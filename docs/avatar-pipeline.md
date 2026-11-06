# Avatar 导入与动作重定向

## 坐标与比例

导入链路保留三个独立坐标系：

- **Source Model**：GLB 场景中的原始轴向、单位和根节点变换。
- **Canonical Humanoid**：查看器使用米制，`+Y` 向上、`+Z` 朝人物正面、`+X` 朝人物左侧，脚底位于 `y = 0`，骨盆居中。
- **h3d / MuJoCo**：`+X` 向前、`+Y` 向左、`+Z` 向上。该坐标转换由 `AvatarAdapter` 完成。

导入时会根据头部与骨盆方向估计上轴，根据左右上臂（必要时腿或手）估计侧向，并将其吸附到最接近的源坐标轴。单位由骨架高度估算，也可由导入 API 的 `unitScale`、`upAxis` 和 `flipFacing` 选项覆盖。模型再进行统一缩放和平移，使静止骨盆高度默认为 MuJoCo 的 `0.915 m`，并将脚底放到地面。这个比例校准保留模型内部比例，但会改变它在查看器中的世界尺寸；可通过 `normalizeStature: false` 或 `targetPelvisHeight` 调整。下肢动作中的足部旋转会相对模型的绑定世界朝向应用，保留不同骨架原本的脚掌方向。

## 骨骼语义映射

`inferHumanoidBoneMap()` 按以下优先级识别骨骼：

1. 用户手工指定的 overrides。
2. GLB 内嵌的 VRM 0.x / VRM 1.0 humanoid 节点映射。
3. 常见骨骼名称与父子层级。
4. 骨架结构推断，用于无语义名称的骨骼。

`diagnoseHumanoidMap()` 会检查当前默认站姿和动作需要的关键骨骼。手指、脚趾、扭转骨、肩部等作为可选项；缺少关键角色时，“选择模型”面板显示诊断和手工映射列表。GLB 必须包含骨骼、SkinnedMesh、`JOINTS_0` 和 `WEIGHTS_0` 才能驱动动作。查看器和离线检查器均配置 Three.js `MeshoptDecoder`，支持 Meshopt 压缩 GLB。导入适配器通常保留模型的 PBR 材质和纹理；炭治郎的已知错位袖片会在运行时做定向修正，不会改写磁盘上的 GLB。

本工作区的查看器默认选中炭治郎，并通过 `/avatars/tanjiro.glb` 请求 `out/炭治郎-avatar.noindex/tanjiro-tripo-h3.1-rigged-operator.glb`。该 Tripo Studio 资产由四视图生成，含 12 个独立蒙皮网格、12 个材质和 PBR 贴图；文件位于被 Git 忽略的 `out/` 中，不会随仓库分发，新工作区需用自己的参考图重新生成或导入其他已绑骨 `.glb`。其中 `tripo_part_6` 和 `tripo_part_11` 的右袖几何偏离上臂绑定轴，且 `tripo_part_6` 混有锁骨/躯干权重；加载时会把这两个分件在绑定姿态下对齐到 `R_Upperarm`—`R_Forearm` 轴，并让袖片跟随 `R_Upperarm`。不要将 `tripo_part_11` 改绑到躯干骨骼，否则该分件会从手臂脱开。Avatar Profile 可以从“选择模型”面板导出为 JSON；当前版本尚未提供 Profile JSON 的再次导入入口。

## Tripo Studio 多视图生成与绑骨

生成时按正面、背面、左侧、右侧顺序提供四张图，并显式设置 `--visibility private`（CLI 默认是 `public`）：

```sh
tripo-cli generate multiview <front> <back> <left> <right> \
  --model-version v3.1-20260211 --face-limit 50000 --geometry-quality detailed \
  --generate-parts --visibility private -o tanjiro.glb
```

分件生成后，单独运行贴图和 PBR 操作，再做绑骨预检和绑骨：

```sh
tripo-cli process texture <project-id> --mode generate
tripo-cli process texture <project-id> --mode pbr
tripo-cli process rig <project-id> --check
tripo-cli process rig <project-id>
```

`process rig` 输出的 operator ID 标识实际绑骨结果。不要把 `process rig -o` 下载的项目模型当成绑骨结果；应通过 operator ID 导出实际的 rigged GLB，再用本地检查器确认骨架映射和动作重定向：

```sh
tripo-cli export <project-id> --operator-id <rig-operator-id> -o tanjiro-rigged.glb
node scripts/check-rigged-avatar.mjs tanjiro-rigged.glb web/demo-motion.json
```

## 静态网格的实验性自动绑骨

静态人形网格没有骨架或权重时，可用 Blender 预处理脚本生成一个新的蒙皮 GLB：

```sh
blender --background --factory-startup --python scripts/rig-glb.py -- input.glb output-rigged.glb --forward -y
```

`--forward` 接受 `-y` 或 `+y`，表示人物在 Blender Z-up 场景中的正面方向。脚本检查网格是否直立，依据 bounds 放置 21 根 VRM 风格命名的通用人体骨骼。源文件不会被覆盖；输出包含原网格、UV、材质和嵌入图像，并生成同名 `.avatar-report.json` 报告。默认 `--weights heat` 会依次尝试 Bone Heat、骨骼包络和未覆盖顶点的距离补权；也可用 `--weights envelope` 从包络开始，或 `--weights distance` 强制使用旧算法。

当前脚本先尝试 Blender Bone Heat；失败后再试骨骼包络权重。包络未覆盖的顶点才用线段距离权重补齐，随后统一归一化并限制到每顶点最多四个骨骼影响。旧版静态炭治郎模型 `炭治郎-rigged-v7.glb` 有 244,794 条边界边，Bone Heat 在该开放网格上没有产生可用权重；骨骼包络覆盖约 97.3% 顶点，剩余约 2.7% 由距离权重补齐。报告会记录实际使用的方式和修补数量。可用 `--weights envelope` 从包络权重开始，或 `--weights distance` 强制使用旧距离算法。

骨骼位置仍是 bounds 启发式估算；包络权重比全网格线段高斯权重更贴近骨骼影响范围，但不能修正错误关节位置，也不能保证肘、膝、手指或衣物的自然变形。

## 衣物部件与差异化运动

GLB 材质定义颜色、贴图和表面参数，不会自动规定网格怎样随骨骼运动。旧版静态炭治郎资产只有一个网格和一个材质，衣服图案与身体共享 UV 贴图；当前 Tripo 模型拆成 12 个独立蒙皮网格并带有 12 个材质，但网格仍使用通用名称 `tripo_part_0..11`，不能据此可靠识别羽织、袖子、裤子和皮肤，也没有新增专用衣物辅助骨骼或布料动力学。

后续处理分件模型时，应将部件命名为身体、头发、羽织躯干、左右袖子、裤子、鞋袜等语义明确的名称，并为各部件保留独立材质。脚本会对每个网格单独求权重，部件名称和材质名称也能用于添加有针对性的权重规则。衣物要产生区别于人体的摆动，还需明确提供衣物辅助骨骼（例如左右袖口、左右衣摆和裤裙下摆）及其权重；查看器还需要额外实现弹簧/阻尼次级运动或读取预烘焙动画。仅拆材质而不拆几何、没有辅助骨骼或运动配置，不会自动得到布料物理效果。

## 离线检查

可以用 Node.js `GLTFLoader` 和现有 AvatarAdapter 检查生成模型的 GLB 结构和动作重定向。检查器启用 Three.js `MeshoptDecoder`，可读取 Meshopt 压缩的 GLB；整个检查不需要浏览器或 WebGL：

```sh
node scripts/check-rigged-avatar.mjs output-rigged.glb web/demo-motion.json
```

该检查遍历动作文件中的各个样本，确认映射有效、骨长不随重定向漂移、骨骼变换有限，并检查 skin indices、weights 和 bind matrices 保持不变。它不能替代视觉检查蒙皮变形。
