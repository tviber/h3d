import { Box3, Mesh, Triangle, Vector3 } from 'three';
import { projectOutsideCapsule, segmentTriangleContact } from './collision-math.js';

const STEP = 1 / 60;

/** XPBD distance constraint; lambdas live for one equilibrium solve. */
export function solveDistance(a, b, restLength, compliance, lambda = 0) {
  const dx = a.position.x - b.position.x, dy = a.position.y - b.position.y, dz = a.position.z - b.position.z;
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const alpha = compliance / (STEP * STEP), weight = a.invMass + b.invMass;
  if (length < 1e-12 || weight === 0) return lambda;
  const change = (-(length - restLength) - alpha * lambda) / (weight + alpha);
  const scaleA = change / length * a.invMass, scaleB = change / length * b.invMass;
  a.position.x += dx * scaleA; a.position.y += dy * scaleA; a.position.z += dz * scaleA;
  b.position.x -= dx * scaleB; b.position.y -= dy * scaleB; b.position.z -= dz * scaleB;
  return lambda + change;
}

/**
 * Quasi-static garment solver: skinned targets -> compliant stretch/bend/tethers
 * -> unilateral body/fabric contact. No integration history, so arbitrary seeks,
 * playback speed, and repeated paused frames yield the same surface.
 * The GLB geometry, weights, inverse binds and materials remain authoritative.
 */
export class GarmentSolver {
  constructor(calibration, configs = []) {
    this.calibration = calibration;
    this.garments = [];
    this.particles = [];
    this.triangles = [];
    this.constraints = [];
    this.diagnostics = {};
    const seen = new Set();
    // Validate everything before adding render proxies to the imported model.
    const sources = configs.map(config => {
      const matches = [];
      calibration.model.traverse(node => { if (node.name === config.mesh && node.isSkinnedMesh) matches.push(node); });
      if (matches.length !== 1) throw new Error(`Cloth mesh must identify exactly one SkinnedMesh: ${config.mesh}`);
      if (seen.has(matches[0])) throw new Error(`Duplicate cloth mesh: ${config.mesh}`);
      seen.add(matches[0]);
      if (matches[0].geometry.morphAttributes.position?.length) throw new Error(`Cloth morph targets are not supported: ${config.mesh}`);
      if (matches[0].geometry.getAttribute('position').count > 4096) throw new Error(`Cloth requires a low resolution mesh (at most 4096 vertices): ${config.mesh}`);
      if (config.pin?.nearRole && !calibration.roles.has(config.pin.nearRole)) throw new Error(`Unknown cloth pin role: ${config.pin.nearRole}`);
      return matches[0];
    });
    try { configs.forEach((config, i) => this.addGarment(sources[i], config)); }
    catch (error) { this.dispose(); throw error; }
  }

  addGarment(source, config) {
    source.skeleton.update();
    const geometry = source.geometry.clone();
    const proxy = new Mesh(geometry, source.material);
    proxy.name = `${source.name}_collision_surface`;
    proxy.matrixAutoUpdate = false;
    proxy.matrix.copy(source.matrix);
    proxy.castShadow = source.castShadow;
    proxy.receiveShadow = source.receiveShadow;
    proxy.frustumCulled = false;
    proxy.visible = false;
    const garment = { source, proxy, config, wasVisible: source.visible, vertices: [], particles: [], triangles: [] };
    const weld = new Map(), targets = [];
    const count = geometry.getAttribute('position').count;
    for (let i = 0; i < count; i++) targets.push(source.getVertexPosition(i, new Vector3()).applyMatrix4(source.matrixWorld));
    const bounds = new Box3().setFromPoints(targets);
    const pinPoint = config.pin?.nearRole ? calibrationPosition(this.calibration, config.pin.nearRole) : null;
    const chain = this.calibration.chains[config.pin?.alongChain];
    const axis = chain ? this.calibration.rest.get(chain.end).worldPosition.clone().sub(this.calibration.rest.get(chain.upper).worldPosition).normalize() : null;
    const projections = axis ? targets.map(p => p.dot(axis)) : [];
    const minimum = Math.min(...projections), maximum = Math.max(...projections);
    for (let i = 0; i < count; i++) {
      const rest = targets[i];
      const key = rest.toArray().map(value => Math.round(value * 1e6)).join(',');
      let particle = weld.get(key);
      if (!particle) {
        const pinned = config.pin?.top !== undefined
          ? rest.y >= bounds.max.y - (bounds.max.y - bounds.min.y) * config.pin.top - 1e-7
          : axis ? rest.dot(axis) <= minimum + (maximum - minimum) * config.pin.fraction + 1e-7
            : Boolean(pinPoint && rest.distanceTo(pinPoint) <= config.pin.radius * this.calibration.height);
        particle = {
          id: this.particles.length, garment, vertex: i, rest, target: rest.clone(), position: rest.clone(),
          invMass: pinned ? 0 : 1, neighbors: new Set(), attachmentLambda: 0,
          seamCapsules: new Set(),
        };
        weld.set(key, particle);
        this.particles.push(particle);
        garment.particles.push(particle);
      }
      garment.vertices.push(particle);
    }
    const fixed = garment.particles.filter(p => !p.invMass).length;
    if (!fixed || fixed === garment.particles.length) {
      geometry.dispose();
      throw new Error(`Cloth pin must select both fixed and free vertices: ${source.name}`);
    }
    const indices = geometry.index;
    const edgeMap = new Map();
    const edge = (a, b, opposite) => {
      if (a === b) return;
      a.neighbors.add(b.id); b.neighbors.add(a.id);
      const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
      const existing = edgeMap.get(key);
      if (existing) {
        if (existing.opposite !== opposite) this.addConstraint(existing.opposite, opposite, config.bendCompliance ?? 2e-4, 'bend');
      } else {
        edgeMap.set(key, { opposite });
        this.addConstraint(a, b, config.stretchCompliance ?? 2e-7, 'stretch');
      }
    };
    for (let i = 0; i < (indices?.count ?? count); i += 3) {
      const vertices = [0, 1, 2].map(j => garment.vertices[indices ? indices.getX(i + j) : i + j]);
      if (new Set(vertices).size !== 3) continue;
      const [a, b, c] = vertices;
      const triangle = { vertices, shape: new Triangle(a.position, b.position, c.position), rest: new Triangle(a.rest, b.rest, c.rest) };
      this.triangles.push(triangle); garment.triangles.push(triangle);
      edge(a, b, c); edge(b, c, a); edge(c, a, b);
    }
    source.parent.add(proxy);
    this.garments.push(garment);
  }

  /** Sewn roots intentionally overlap coarse body volumes. Exclude just those
   * collider pairs for the fixed seam and its two adjacent topology rings. */
  configureSeams(capsules) {
    for (const garment of this.garments) {
      const pinned = garment.particles.filter(p => !p.invMass), sewn = new Set();
      for (const p of pinned) for (const c of capsules) if (projectOutsideCapsule(p.rest.clone(), c) > 0) sewn.add(c.id);
      let ring = new Set(pinned.map(p => p.id));
      const visited = new Set(ring);
      for (let i = 0; i < 2; i++) {
        const next = new Set();
        for (const id of ring) for (const neighbor of this.particles[id].neighbors) if (!visited.has(neighbor)) { visited.add(neighbor); next.add(neighbor); }
        ring = next;
      }
      for (const id of visited) this.particles[id].seamCapsules = new Set(sewn);
    }
  }

  addConstraint(a, b, compliance, kind) {
    const length = a.rest.distanceTo(b.rest);
    if (length > 1e-8) this.constraints.push({ a, b, length, compliance, kind, lambda: 0 });
  }

  setEnabled(enabled) {
    for (const { source, proxy, wasVisible } of this.garments) {
      source.visible = enabled ? false : wasVisible;
      proxy.visible = enabled && wasVisible;
    }
  }

  bodyContacts(capsules) {
    let contacts = 0;
    const thickness = this.calibration.height * .003;
    for (const p of this.particles) {
      if (!p.invMass) continue;
      for (const capsule of capsules) {
        if (p.seamCapsules.has(capsule.id)) continue;
        const x = p.position.x, y = p.position.y, z = p.position.z;
        const depth = projectOutsideCapsule(p.position, capsule, thickness);
        if (depth <= 1e-7) continue;
        if (this.needsArmSide(p.garment, capsule)) {
          const direction = this.armOutsideDirection(capsule);
          p.position.set(x, y, z);
          const axis = capsule.b.clone().sub(capsule.a), relative = p.position.clone().sub(capsule.a);
          const t = axis.lengthSq() > 1e-14 ? Math.max(0, Math.min(1, relative.dot(axis) / axis.lengthSq())) : 0;
          const offset = relative.addScaledVector(axis, -t), dot = offset.dot(direction), radius = capsule.radius + thickness;
          const distance = -dot + Math.sqrt(Math.max(0, dot * dot + radius * radius - offset.lengthSq()));
          p.position.addScaledVector(direction, distance);
        }
        contacts++;
      }
      p.position.y = Math.max(this.calibration.groundY + thickness, p.position.y);
    }
    return contacts;
  }

  bodySurfaceContacts(capsules) {
    let contacts = 0;
    const thickness = this.calibration.height * .003;
    for (const triangle of this.triangles) {
      if (triangle.vertices.every(p => !p.invMass)) continue;
      for (const capsule of capsules) {
        if (triangle.vertices.some(p => p.seamCapsules.has(capsule.id))) continue;
        const contact = segmentTriangleContact(capsule, triangle.shape, thickness);
        if (!contact || contact.depth < 1e-6) continue;
        const weights = contact.barycentric.toArray();
        const mass = triangle.vertices.reduce((sum, p, i) => sum + p.invMass * weights[i] ** 2, 0);
        // Fixed sewn vertices retain their attachment even inside a coarse proxy.
        if (mass < .05) continue;
        const correction = Math.min(contact.depth, this.calibration.height * .012) / mass;
        if (this.needsArmSide(triangle.vertices[0].garment, capsule)) {
          contact.normal.copy(this.armOutsideDirection(capsule));
        }
        triangle.vertices.forEach((p, i) => p.position.addScaledVector(contact.normal, correction * p.invMass * weights[i]));
        contacts++;
      }
    }
    return contacts;
  }

  armOutsideDirection(capsule) {
    return this.armDirections.get(capsule.chain);
  }

  needsArmSide(garment, capsule) {
    return garment.config.pin.top !== undefined && this.armDirections.has(capsule.chain);
  }

  /** A contact correction must not tear a garment when pins/contact are
   * incompatible. Line-search each garment back toward its skinned target,
   * keeping edge stretch and displacement within an explicit display budget.
   * Contact residual is measured AFTER this guard, never before it. */
  limitDeformation() {
    const result = [];
    for (const garment of this.garments) {
      let scale = 1;
      for (const p of garment.particles) {
        const displacement = p.position.distanceTo(p.target);
        if (displacement > 0) scale = Math.min(scale, this.calibration.height * .06 / displacement);
      }
      for (const c of this.constraints) {
        if (c.a.garment !== garment || c.kind !== 'stretch') continue;
        const target = c.a.target.clone().sub(c.b.target);
        const change = c.a.position.clone().sub(c.b.position).sub(target);
        // Existing skinning stretch is the minimum feasible input; permit at
        // most another 5%, or 50% over bind length if the input is less strained.
        const maximum = Math.max(c.length * 1.5, target.length() * 1.05);
        if (target.clone().addScaledVector(change, scale).lengthSq() <= maximum * maximum) continue;
        const a = change.lengthSq(), b = 2 * target.dot(change), cc = target.lengthSq() - maximum * maximum;
        if (a > 1e-14) scale = Math.min(scale, Math.max(0, (-b + Math.sqrt(Math.max(0, b * b - 4 * a * cc))) / (2 * a)));
      }
      if (scale < 1) for (const p of garment.particles) p.position.lerpVectors(p.target, p.position, scale);
      result.push({ mesh: garment.source.name, scale });
    }
    return result;
  }

  /** Spatially hashed vertex/triangle self and cross-garment contacts. */
  fabricContacts(resolve = true) {
    const thickness = this.calibration.height * .003, cell = this.calibration.height * .05;
    const grid = new Map(), bounds = new Box3();
    const key = (x, y, z) => `${x},${y},${z}`;
    for (const triangle of this.triangles) {
      bounds.setFromPoints(triangle.vertices.map(p => p.position)).expandByScalar(thickness);
      const lo = bounds.min.clone().divideScalar(cell).floor(), hi = bounds.max.clone().divideScalar(cell).floor();
      for (let x = lo.x; x <= hi.x; x++) for (let y = lo.y; y <= hi.y; y++) for (let z = lo.z; z <= hi.z; z++) {
        const k = key(x, y, z);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(triangle);
      }
    }
    let contacts = 0, maxPenetration = 0;
    const closest = new Vector3(), normal = new Vector3(), restClosest = new Vector3();
    for (const p of this.particles) {
      if (!p.invMass) continue;
      const candidates = grid.get(key(Math.floor(p.position.x / cell), Math.floor(p.position.y / cell), Math.floor(p.position.z / cell))) ?? [];
      for (const triangle of candidates) {
        const vertices = triangle.vertices;
        if (vertices.some(q => q === p || p.neighbors.has(q.id))) continue;
        triangle.shape.closestPointToPoint(p.position, closest);
        const distance = p.position.distanceTo(closest);
        if (distance >= thickness) continue;
        // Deliberate sewn/overlapping bind seams are not separating contact pairs.
        triangle.rest.closestPointToPoint(p.rest, restClosest);
        if (p.rest.distanceTo(restClosest) < thickness * 2) continue;
        maxPenetration = Math.max(maxPenetration, thickness - distance);
        if (!resolve) { contacts++; continue; }
        normal.copy(p.position).sub(closest);
        if (distance < 1e-9) triangle.shape.getNormal(normal);
        else normal.divideScalar(distance);
        if (normal.lengthSq() < 1e-12) continue;
        const bary = triangle.shape.getBarycoord(closest, new Vector3());
        if (!bary) continue;
        const weights = bary.toArray();
        const denominator = p.invMass + vertices.reduce((sum, q, i) => sum + q.invMass * weights[i] ** 2, 0);
        const correction = (thickness - distance) / denominator;
        p.position.addScaledVector(normal, correction * p.invMass);
        vertices.forEach((q, i) => q.position.addScaledVector(normal, -correction * q.invMass * weights[i]));
        contacts++;
      }
    }
    return resolve ? contacts : { contacts, maxPenetration };
  }

  solve(capsules) {
    const thickness = this.calibration.height * .003;
    this.armDirections = new Map();
    const lateral = this.calibration.chains.leftArm.upper.getWorldPosition(new Vector3())
      .sub(this.calibration.chains.rightArm.upper.getWorldPosition(new Vector3())).normalize();
    for (const side of ['left', 'right']) {
      const chain = this.calibration.chains[`${side}Arm`];
      if (chain.upper.getWorldPosition(new Vector3()).y >= chain.lower.getWorldPosition(new Vector3()).y - this.calibration.height * .02) {
        this.armDirections.set(`${side}Arm`, lateral.clone().multiplyScalar(side === 'left' ? 1 : -1));
      }
    }
    const skeletons = new Set(this.garments.map(g => g.source.skeleton));
    for (const skeleton of skeletons) skeleton.update();
    for (const p of this.particles) {
      p.garment.source.getVertexPosition(p.vertex, p.target).applyMatrix4(p.garment.source.matrixWorld);
      p.position.copy(p.target);
      p.attachmentLambda = 0;
    }
    for (const c of this.constraints) c.lambda = 0;
    let bodyContacts = 0, fabricContacts = 0;
    for (let iteration = 0; iteration < 48; iteration++) {
      for (const p of this.particles) {
        if (!p.invMass) { p.position.copy(p.target); continue; }
        p.attachmentLambda = solveDistance(p, { position: p.target, invMass: 0 }, 0,
          p.garment.config.attachmentCompliance ?? 8e-5, p.attachmentLambda);
      }
      for (const c of this.constraints) c.lambda = solveDistance(c.a, c.b, c.length, c.compliance, c.lambda);
      if (iteration % 12 === 11) fabricContacts += this.fabricContacts();
      bodyContacts += this.bodyContacts(capsules);
      if (iteration % 4 === 3) bodyContacts += this.bodySurfaceContacts(capsules);
    }
    for (let iteration = 0; iteration < 4; iteration++) bodyContacts += this.bodyContacts(capsules);
    const deformationScales = this.limitDeformation();
    let maxVertexPenetration = 0, maxSurfacePenetration = 0, pinnedPenetration = 0, maxDisplacement = 0;
    for (const p of this.particles) {
      maxDisplacement = Math.max(maxDisplacement, p.position.distanceTo(p.target));
      for (const capsule of capsules) {
        if (p.seamCapsules.has(capsule.id)) continue;
        const depth = projectOutsideCapsule(p.position.clone(), capsule, thickness);
        if (p.invMass) maxVertexPenetration = Math.max(maxVertexPenetration, depth);
        else pinnedPenetration = Math.max(pinnedPenetration, depth);
      }
    }
    for (const t of this.triangles) {
      if (t.vertices.every(p => !p.invMass)) continue;
      for (const capsule of capsules) {
        if (t.vertices.some(p => p.seamCapsules.has(capsule.id))) continue;
        const contact = segmentTriangleContact(capsule, t.shape, thickness);
        if (contact) maxSurfacePenetration = Math.max(maxSurfacePenetration, contact.depth);
      }
    }
    const fabricResidual = this.fabricContacts(false);
    const maxPenetration = Math.max(maxVertexPenetration, maxSurfacePenetration, pinnedPenetration, fabricResidual.maxPenetration);
    const maxStretchRatio = Math.max(1, ...this.constraints.filter(c => c.kind === 'stretch').map(c => c.a.position.distanceTo(c.b.position) / c.length));
    for (const g of this.garments) {
      g.proxy.matrix.copy(g.source.matrix);
      const inverse = g.source.matrixWorld.clone().invert(), attribute = g.proxy.geometry.getAttribute('position');
      const local = new Vector3();
      g.vertices.forEach((p, i) => { local.copy(p.position).applyMatrix4(inverse); attribute.setXYZ(i, local.x, local.y, local.z); });
      attribute.needsUpdate = true;
      g.proxy.geometry.computeVertexNormals();
      g.proxy.updateMatrixWorld(true);
    }
    this.diagnostics = { mode: 'quasi-static-xpbd', particles: this.particles.length,
      pinned: this.particles.filter(p => !p.invMass).length, bodyContacts, fabricContacts,
      maxPenetration, maxVertexPenetration, maxSurfacePenetration, pinnedPenetration, maxDisplacement, maxStretchRatio,
      remainingFabricContacts: fabricResidual.contacts, maxFabricPenetration: fabricResidual.maxPenetration,
      seamExclusions: this.particles.reduce((count, p) => count + p.seamCapsules.size, 0), deformationScales,
      limitedGarments: deformationScales.filter(item => item.scale < .999).length };
    return this.diagnostics;
  }

  dispose() {
    this.setEnabled(false);
    for (const { proxy } of this.garments) { proxy.removeFromParent(); proxy.geometry.dispose(); }
    this.garments = []; this.particles = []; this.constraints = []; this.triangles = [];
  }
}

function calibrationPosition(calibration, role) {
  return calibration.rest.get(calibration.roles.get(role)).worldPosition;
}
