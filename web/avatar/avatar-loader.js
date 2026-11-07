import { LoadingManager } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { AvatarAdapter } from './avatar-adapter.js';
import { inspectHumanoid } from './humanoid-inspector.js';
import { HumanoidRetargeter } from './humanoid-retargeter.js';
import { validateCollisionConfig } from './avatar-collision.js';

export const PROFILE_SCHEMA = 'h3d.avatar-profile.v2';

export function createHumanoidProfile(id, label, url = '') {
  return {
    schemaVersion: PROFILE_SCHEMA,
    id,
    label,
    asset: { url },
    rig: { preset: 'auto', boneOverrides: {} },
    calibration: { units: 'asset', up: '+Y', forward: 'auto', bindPose: 'asset' },
    retarget: { rootMotion: 'leg-length-relative', contactPolicy: 'source-contact', limbStretch: false },
    appearance: { materials: 'preserve', geometry: 'preserve' },
  };
}

/** Reject unsupported policy requests instead of silently running a different algorithm. */
export function validateHumanoidProfile(profile) {
  if (!profile || profile.schemaVersion !== PROFILE_SCHEMA) throw new Error('模型配置需要 h3d.avatar-profile.v2 格式');
  if (typeof profile.id !== 'string' || !profile.id.trim() || typeof profile.label !== 'string' || !profile.label.trim()) {
    throw new Error('模型配置缺少 id 或 label');
  }
  if (!profile.asset || typeof profile.asset.url !== 'string') throw new Error('模型配置缺少 asset.url');
  if (profile.asset.sha256 && !/^[a-f0-9]{64}$/i.test(profile.asset.sha256)) throw new Error('asset.sha256 必须为 64 位十六进制摘要');
  const allowed = [
    ['retarget.rootMotion', profile.retarget?.rootMotion, ['leg-length-relative']],
    ['retarget.contactPolicy', profile.retarget?.contactPolicy, ['source-contact']],
    ['retarget.limbStretch', profile.retarget?.limbStretch, [false]],
    ['retarget.missingFingers', profile.retarget?.missingFingers, ['preserve-bind']],
    ['retarget.jointLimitsPreset', profile.retarget?.jointLimitsPreset, ['humanoid']],
    ['appearance.materials', profile.appearance?.materials, ['preserve']],
    ['appearance.geometry', profile.appearance?.geometry, ['preserve']],
  ];
  for (const [name, value, options] of allowed) {
    if (value !== undefined && !options.includes(value)) throw new Error(`暂不支持配置 ${name}=${value}`);
  }
  validateCollisionConfig(profile.collision);
  return profile;
}

/** Stable review artifact. It is rederived on import, never blindly replayed onto another GLB. */
export function calibrationReport(inspection, sha256) {
  return {
    schemaVersion: 'h3d.avatar-calibration.v1',
    inspectorVersion: 1,
    assetSha256: sha256,
    profileId: inspection.profile.id,
    heightMeters: inspection.height,
    diagnostics: inspection.diagnostics,
    roles: Object.fromEntries([...inspection.roles].map(([role, bone]) => [role, inspection.nodeSelectors?.get(bone) ?? bone.name])),
    chains: Object.fromEntries(Object.entries(inspection.chains).map(([name, chain]) => [name, chain && {
      upperLength: chain.upperLength, lowerLength: chain.lowerLength,
    }])),
    bind: [...inspection.rest].map(([bone, rest]) => ({
      name: bone.name,
      localPosition: rest.position.toArray(), localQuaternion: rest.quaternion.toArray(), localScale: rest.scale.toArray(),
      worldPosition: rest.worldPosition.toArray(), worldQuaternion: rest.worldQuaternion.toArray(),
    })),
    soleOffsets: Object.fromEntries(Object.entries(inspection.soleOffsets).map(([side, offset]) => [side, offset.toArray()])),
  };
}

/** The generic path needs a self-contained GLB; it never needs MakeHuman's rig.json. */
export async function loadAvatarProfile(profile, options = {}) {
  if (profile.schemaVersion !== PROFILE_SCHEMA) {
    if (options.buffer) throw new Error('导入 GLB 需要通用 v2 配置');
    return AvatarAdapter.load(profile);
  }
  validateHumanoidProfile(profile);
  const buffer = options.buffer ?? await (async () => {
    const response = await (options.fetchFn ?? fetch)(profile.asset.url);
    if (!response.ok) throw new Error(`模型文件请求失败 (${response.status})`);
    return response.arrayBuffer();
  })();
  const view = new DataView(buffer);
  if (buffer.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2
      || view.getUint32(8, true) !== buffer.byteLength) throw new Error('请选择完整的 glTF 2.0 GLB 文件');
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  if (profile.asset.sha256 && profile.asset.sha256.toLowerCase() !== hash) throw new Error('模型摘要与配置不一致，请使用对应的 GLB 或重新标定');
  const manager = new LoadingManager();
  manager.setURLModifier(url => {
    if (/^(blob:|data:)/.test(url)) return url;
    throw new Error('当前导入只支持贴图和缓冲区均内嵌的 GLB，请将外部资源打包进 GLB');
  });
  const gltf = await (options.loader ?? new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder)).parseAsync(buffer, '');
  try {
    const inspection = inspectHumanoid(gltf.scene, profile);
    if (!inspection.diagnostics.skinCount) throw new Error('模型只有骨架，没有带蒙皮的网格');
    const adapter = new HumanoidRetargeter(inspection);
    adapter.profile = structuredClone(profile);
    adapter.profile.asset.sha256 = hash;
    adapter.inspection = inspection;
    adapter.report = calibrationReport(inspection, hash);
    // Keep disposal available to all loader callers, including failed imports.
    adapter.model.userData.disposeCollision = () => adapter.collision.dispose();
    return adapter;
  } catch (error) {
    disposeAvatar(gltf.scene);
    throw error;
  }
}

export function disposeAvatar(model) {
  model?.userData.disposeCollision?.();
  const textures = new Set(), materials = new Set(), geometries = new Set(), skeletons = new Set();
  model?.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    if (object.skeleton) skeletons.add(object.skeleton);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!material) continue;
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  for (const item of [...textures, ...materials, ...geometries, ...skeletons]) item.dispose();
}
