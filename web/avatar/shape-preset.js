import { SkinnedMesh } from 'three';

/**
 * Heroic athletic body shape preset ported from human3d.
 *
 * Applied once at load time in bind space on the SkinnedMesh geometry,
 * without altering bone scales or bind matrices. Limb segment lengths
 * remain untouched so kinematics and bone lengths stay exact.
 */

const SKIN_TOP = 1.7;

const TORSO_KEYS = [
  [0.95, 1, 1],
  [1.06, 0.94, 0.94],
  [1.18, 1, 1],
  [1.30, 1.05, 1.04],
  [1.40, 1.02, 1.02],
  [1.47, 1.10, 1.03],
  [1.53, 1, 1],
];

const ARM = { yFrom: 1.16, yTo: 1.46, xFrom: 0.30, xTo: 0.60, zMul: 1.16, fade: 0.35 };
const LEG = { yFrom: 0.45, yTo: 0.98, xMul: 1.06, zMul: 1.06, fade: 0.12 };
const CHIN = {
  yMin: 1.475, yMax: 1.565, zFront: 0.03,
  center: 1.52, sigma: 0.03, narrow: 0.13,
  tipCenter: 1.525, tipSigma: 0.014, tipPush: 0.007, tipWidth: 0.06,
};

function smooth(t) {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

function torsoMul(y) {
  if (y < TORSO_KEYS[0][0] || y >= TORSO_KEYS[TORSO_KEYS.length - 1][0]) return [1, 1];
  for (let i = 0; i < TORSO_KEYS.length - 1; i++) {
    const [ya, ax, az] = TORSO_KEYS[i], [yb, bx, bz] = TORSO_KEYS[i + 1];
    if (y >= ya && y < yb) {
      const t = (y - ya) / (yb - ya);
      return [ax + (bx - ax) * t, az + (bz - az) * t];
    }
  }
  return [1, 1];
}

function shapeSurface(geometry) {
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  if (!bb || bb.max.y < SKIN_TOP) return;
  const pos = geometry.attributes.position;
  const n = pos.count;
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let nx = x, nz = z;
    if (y >= 0.95 && y <= 1.53 && Math.abs(x) < 0.35) {
      const [mx, mz] = torsoMul(y);
      nx *= mx;
      nz *= mz;
    }
    if (y >= ARM.yFrom && y <= ARM.yTo && Math.abs(x) >= ARM.xFrom) {
      const along = Math.min((Math.abs(x) - ARM.xFrom) / (ARM.xTo - ARM.xFrom), 1);
      const w = 1 - ARM.fade * smooth(along / 0.5);
      nz *= 1 + (ARM.zMul - 1) * w;
    }
    if (y >= LEG.yFrom && y <= LEG.yTo && Math.abs(nx) < 0.25) {
      const w = 1 - LEG.fade * smooth(Math.min(((LEG.yTo - y) / (LEG.yTo - LEG.yFrom)) * 2, 1));
      nx *= 1 + (LEG.xMul - 1) * w;
      nz *= 1 + (LEG.zMul - 1) * w;
    }
    if (y >= CHIN.yMin && y <= CHIN.yMax && z >= CHIN.zFront) {
      const wy = Math.exp(-Math.pow((y - CHIN.center) / CHIN.sigma, 2));
      nx *= 1 - CHIN.narrow * wy;
      const wt = Math.exp(-Math.pow((y - CHIN.tipCenter) / CHIN.tipSigma, 2)) * (1 - Math.min(Math.abs(x) / CHIN.tipWidth, 1));
      nz += CHIN.tipPush * wt;
    }
    if (nx !== x) pos.setX(i, nx);
    if (nz !== z) pos.setZ(i, nz);
  }
  pos.needsUpdate = true;
}

export function applyHeroicShape(root) {
  root.traverse((o) => {
    if (!(o instanceof SkinnedMesh)) return;
    shapeSurface(o.geometry);
  });
}
