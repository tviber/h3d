import { MathUtils, Vector3 } from 'three';

/** Closest points on finite segments, including parallel and zero-length segments. */
export function closestSegments(a0, a1, b0, b1) {
  const u = a1.clone().sub(a0), v = b1.clone().sub(b0), w = a0.clone().sub(b0);
  const a = u.lengthSq(), b = u.dot(v), c = v.lengthSq(), d = u.dot(w), e = v.dot(w);
  let s = 0, t = 0;
  if (a < 1e-14) t = c > 1e-14 ? MathUtils.clamp(e / c, 0, 1) : 0;
  else if (c < 1e-14) s = MathUtils.clamp(-d / a, 0, 1);
  else {
    const denominator = a * c - b * b;
    s = denominator > 1e-14 ? MathUtils.clamp((b * e - c * d) / denominator, 0, 1) : 0;
    t = (b * s + e) / c;
    if (t < 0) { t = 0; s = MathUtils.clamp(-d / a, 0, 1); }
    else if (t > 1) { t = 1; s = MathUtils.clamp((b - d) / a, 0, 1); }
  }
  return { a: a0.clone().addScaledVector(u, s), b: b0.clone().addScaledVector(v, t), s, t };
}

/** Normal points out of B toward A. Radii and positions use normalized world metres. */
export function capsuleContact(a, b, margin = 0) {
  const pair = closestSegments(a.a, a.b, b.a, b.b);
  const normal = pair.a.clone().sub(pair.b), distance = normal.length();
  const depth = a.radius + b.radius + margin - distance;
  if (depth <= 0) return null;
  if (distance > 1e-9) normal.divideScalar(distance);
  else {
    normal.copy(a.a).add(a.b).sub(b.a).sub(b.b);
    if (normal.lengthSq() < 1e-12) normal.crossVectors(a.b.clone().sub(a.a), b.b.clone().sub(b.a));
    if (normal.lengthSq() < 1e-12) normal.set(0, 0, 1);
    normal.normalize();
  }
  return { normal, depth, point: pair.a, otherPoint: pair.b, s: pair.s, t: pair.t };
}

export function projectOutsideCapsule(point, capsule, thickness = 0, fallback = null) {
  const a = capsule.a, b = capsule.b;
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
  const lengthSq = ux * ux + uy * uy + uz * uz;
  const t = lengthSq > 1e-14 ? MathUtils.clamp(((point.x - a.x) * ux + (point.y - a.y) * uy + (point.z - a.z) * uz) / lengthSq, 0, 1) : 0;
  let nx = point.x - a.x - ux * t, ny = point.y - a.y - uy * t, nz = point.z - a.z - uz * t;
  const distanceSq = nx * nx + ny * ny + nz * nz;
  if (distanceSq >= (capsule.radius + thickness) ** 2) return 0;
  const distance = Math.sqrt(distanceSq);
  const depth = capsule.radius + thickness - distance;
  if (distance > 1e-9) { nx /= distance; ny /= distance; nz /= distance; }
  else {
    const normal = fallback ? fallback.clone() : new Vector3(0, 0, 1), axis = new Vector3(ux, uy, uz);
    if (lengthSq > 1e-14) normal.addScaledVector(axis, -normal.dot(axis) / lengthSq);
    if (normal.lengthSq() < 1e-12) normal.set(1, 0, 0);
    normal.normalize(); nx = normal.x; ny = normal.y; nz = normal.z;
  }
  point.x += nx * depth; point.y += ny * depth; point.z += nz * depth;
  return depth;
}

/** Minimum finite segment/triangle distance, including a segment piercing its face. */
export function segmentTriangleContact(capsule, triangle, thickness = 0) {
  const radius = capsule.radius + thickness;
  const points = [triangle.a, triangle.b, triangle.c];
  // Cheap expanded AABB rejection before the exact face/edge tests.
  for (const key of ['x', 'y', 'z']) {
    if (Math.min(triangle.a[key], triangle.b[key], triangle.c[key]) > Math.max(capsule.a[key], capsule.b[key]) + radius
      || Math.max(triangle.a[key], triangle.b[key], triangle.c[key]) < Math.min(capsule.a[key], capsule.b[key]) - radius) return null;
  }
  let closest = triangle.closestPointToPoint(capsule.a, new Vector3()), axisPoint = capsule.a.clone();
  let distanceSq = closest.distanceToSquared(axisPoint);
  const candidate = triangle.closestPointToPoint(capsule.b, new Vector3());
  if (candidate.distanceToSquared(capsule.b) < distanceSq) {
    closest.copy(candidate); axisPoint.copy(capsule.b); distanceSq = closest.distanceToSquared(axisPoint);
  }
  for (let i = 0; i < 3; i++) {
    const pair = closestSegments(points[i], points[(i + 1) % 3], capsule.a, capsule.b);
    const d = pair.a.distanceToSquared(pair.b);
    if (d < distanceSq) { closest.copy(pair.a); axisPoint.copy(pair.b); distanceSq = d; }
  }
  const normal = triangle.getNormal(new Vector3()), direction = capsule.b.clone().sub(capsule.a);
  const denominator = normal.dot(direction);
  if (Math.abs(denominator) > 1e-12) {
    const t = normal.dot(triangle.a.clone().sub(capsule.a)) / denominator;
    if (t >= 0 && t <= 1) {
      const crossing = capsule.a.clone().addScaledVector(direction, t);
      if (triangle.containsPoint(crossing)) { closest.copy(crossing); axisPoint.copy(crossing); distanceSq = 0; }
    }
  }
  const distance = Math.sqrt(distanceSq);
  if (distance >= radius) return null;
  if (distance > 1e-9) normal.copy(closest).sub(axisPoint).divideScalar(distance);
  else {
    const center = triangle.getMidpoint(new Vector3());
    const signed = normal.dot(center.sub(capsule.a.clone().add(capsule.b).multiplyScalar(.5)));
    if (signed < 0) normal.negate();
  }
  const barycentric = triangle.getBarycoord(closest, new Vector3());
  if (!barycentric || normal.lengthSq() < 1e-12) return null;
  return { normal, depth: radius - distance, barycentric };
}
