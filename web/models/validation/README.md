# Humanoid 验证资产

这些文件用于检验不同骨架和比例的通用重定向。原始网格、骨架和权重没有为了适配而修改。动画播放发生在查看器中，源资产内置动画未覆盖。

## CesiumMan

- © 2017 Cesium，CC BY 4.0。标识另受 Cesium 商标说明约束。
- 来源：https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CesiumMan
- 原始 GLB：`CesiumMan.glb`。下载地址、文件摘要在 `download-manifest.json`，完整许可在 `CC-BY-4.0.txt`、`Cesium-logo-notice.txt` 及 `CesiumMan-LICENSE-source.md`。
- 配置：`cesium-man.profile.json`。保留原材质、贴图、19 关节骨架。

## KayKit Knight

- Kay Lousberg / KayKit Adventurers Character Pack 1.0，CC0 1.0。许可原文见 `KayKit-LICENSE.txt`。
- 来源：https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0/tree/672074b73ba276876a19e8816ecdc5241817ab47
- `KayKitKnight.glb` 是上游 `Characters/gltf/Knight.glb` 的逐字节副本，内嵌缓冲区和贴图；不重新拓扑、不改骨架或权重。保留剑、盾与披风，便于暴露附属物的动作限制。
- SHA-256：`60428e3abc09ba83e595d256e3af8c5c976b46cdae599f0802fc82b4a3445168`。
- 配置：`kaykit-knight.profile.json`。身高约 2.467 m，短腿是身体比例特征，并非统一缩矮模型。

## RobotExpressive 拒绝夹具

- Tomás Laulhé，three.js 示例由 Don McCurdy 提供，CC0。来源：https://threejs.org/examples/webgl_animation_skinning_morph.html 及 https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf/RobotExpressive
- 足骨不在对应小腿骨下，不能用本实现的层级双骨 IK 驱动。保留 `RobotExpressive.glb` 和 `robot-expressive-rejection.json` 作为导入失败验证；没有加入模型列表。

`*.inspection.json` 是导入检查记录；运行时始终重新检查 GLB，不将这些记录作为可盲信的绑定缓存。
