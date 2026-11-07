# 通用 Humanoid 模型配置与动作重定向

状态：首版已实现 GLB 检查/规范化、v2 配置导入导出、SHA-256 校验、Bind-aware 肢体旋转、按腿长缩放的骨盆位移、单足底锚点接触约束及确定性的时间轴跳转。已用 MakeHuman、CesiumMan、KayKit Knight 和全新制作的 Tanjiro v3 验证；v3 使用 Tripo v3.0-20260909 绑骨输出，经 Blender 组装并整理为 Mixamo 命名，通过通用 Profile 播放。历史炭治郎未参与制作且已从查看器删除。下文的设计包含后续扩展，不能将所有设计项视为已实现。

## 目标和边界

同一份 `h3d.motion.v1` 记录可以驱动不同身高、体型和骨架命名的人形 GLB。Profile 保存资产出处、坐标系、骨骼角色映射、绑定姿态校准和动作补足策略。目标是保持相近的关节动作，同时依照目标模型自己的骨长和支撑宽度求姿态；不能把源人体的绝对位置直接复制给另一种体型。

“大部分模型”是有边界的兼容目标：资产需是可变形的双足人形、具有可读的层级骨架、关节链完整且具合理蒙皮。非标准拓扑、绑定权重缺陷、严重不对称、单网格但无骨骼，无法靠 Profile 参数修好。配置映射成功也不表示 GLB 蒙皮质量已验收。

## 建议的数据契约

保持动作文件描述仿真世界里的规范人体测点、关节通道、坐标帧和单位；Avatar Profile 仅描述目标角色，二者互不写入。建议新增版本化 `h3d.avatar-profile.v2`，与当前未版本化的 MakeHuman profile 明确区分。人工配置与机器标定分开保存，避免为每个模型填写数百个坐标。以下是人工配置示意，不是可加载资产：

```json
{
  "schemaVersion": "h3d.avatar-profile.v2",
  "id": "artist-rig-a",
  "label": "Artist rig A",
  "asset": { "url": "/models/artist-a.glb", "license": "待确认", "provenance": "待填写" },
  "rig": { "preset": "mixamo", "boneOverrides": {}, "requiredCapabilities": ["torso", "arms", "legs"], "optionalCapabilities": ["fingers", "toes", "twist"] },
  "calibration": { "units": "asset", "up": "asset", "forward": "auto", "bindPose": "asset", "overrides": {} },
  "retarget": { "rootMotion": "leg-length-relative", "contactPolicy": "source-contact", "limbStretch": false, "missingFingers": "preserve-bind", "jointLimitsPreset": "humanoid" },
  "appearance": { "materials": "preserve", "geometry": "preserve" }
}
```

`preset` 提供骨名候选；`boneOverrides` 只填自动识别有歧义的角色，例如 `leftArm.upperArm` 对应某个节点路径。机器标定缓存另存资产 SHA-256、检查器版本、角色到节点路径/索引、完整 bind/rest TRS、各段骨长、弯曲轴、足底与掌面锚点、skin 列表及诊断。缓存与资产 hash 不符必须重建，重复骨名用节点路径或索引消歧。`auto` 必须输出置信度与待标定项；不能猜不准还静默加载。

生产数据必须校验全部必需角色。手指、眼睛、扭转骨和足趾是可选项；没有这些次要关节不应阻止基本步态或深蹲。

## 导入和自动校准

1. 解析 GLB 的 scene、skin、joint hierarchy、inverse bind matrices 与网格包围盒。以实际变换后的顶点边界取得目标身高，不依赖外部 `rig.json` 必须和 GLB 同名。
2. 归一化单位与朝向：glTF 按规范使用米及 Y-up，但仍需检查导出器的场景变换和实际尺寸。正常资产保留原始身高 `H` 米，不把所有模型强行归一成同样高；错误单位由显式 `unitScale` 修正。朝向不确定时输出待标定项，不凭文件大小或骨名盲猜米/厘米和前向。
3. 自动映射常用骨名（Mixamo、VRM、常见 DCC 名称）到 canonical roles，并用父子关系和关节头尾位置交叉验证左右侧及链条顺序；侧别、链条顺序或左右肢长明显异常时要求修正配置，不能仅靠近似名字通过。
4. 将映射骨骼点转成模型局部绑定空间，按头尾位置计算 upper-arm、forearm、thigh、shin 长度，检查空链、零长度、方向反常、非有限坐标及非人形比例。验证结果写进可复查的 profile diagnostics。
5. 推断 rest/bind 变换和 A/T 姿：从骨骼方向估计肢体初始方向，存储规范帧到目标 bind frame 的旋转校准。动作增量必须乘到目标 Bind Pose 上，不能把源四元数当目标绝对 world rotation，也不能把局部关节角直接写成 Euler。

加载时的 node TRS 不能直接等同于 bind pose；必须与 inverse bind matrices、mesh bind space 和父级 TRS 联合验证。镜像变换、非均匀缩放、多 skin/不同 bind space 应明确支持或给出拒绝原因。保留所有原始骨骼、网格变换、权重和 inverse bind，不在每帧 reset 时将模型的导入变换清零。

## 重定向规则

优先从动作采样中读取明确的骨盆、肩、肘、腕、髋、膝、踝 landmark。关节方向本身不做尺度变换。骨盆位移用腿长比例 `L_target/L_source` 映射；手部目标按目标上臂/前臂长度构建，横向站距按目标骨盆宽和姿态参数构建，不能用一个身高比例缩放所有部位。相对朝向和动作角来自规范 landmark，不来自目标 rig 的绝对坐标。

源 rest 必须来自对应物理模型，不能把 `motion-clip.ts` 中共享的 `STATIC_POSITIONS` 当成所有动作源的准确静止骨架。建议补充准确的 `sourceRest` 元数据，旧 clip 只有得到足够可靠的标定后才启用比例重定向。

对每条目标 limb 链，用该角色自己的骨长 `a,b`，两骨 IK 弯折点可由：

```text
d = clamp(|target-root|, |a-b|+epsilon, a+b-epsilon)
x = (a*a - b*b + d*d) / (2*d)
height = sqrt(max(0, a*a - x*x))
mid = root + direction*x + poleDirection*height
```

实现还须加入关节活动范围、左右侧 pole 向量、Bind Pose frame、髋/肩基座到 bone frame 校准、镜像角色与接近伸直时的稳定处理。物理关节角是首选输入；若 clip 有相应 world landmarks，则解算目标 limb direction，并以肘/膝的角度或 pole 约束定弯折平面。对非 identity bind 旋转，严格使用同一坐标空间：

```text
deltaWorld = desiredAnatomicalFrame * inverse(bindAnatomicalFrame)
desiredWorld = deltaWorld * bindWorld
desiredLocal = inverse(parentWorld) * desiredWorld
```

深蹲按以下顺序求解，保证矮壮、长腿等体型使用自己的支撑几何：

1. 初始骨盆意图为 `p_target = p_target_rest + (L_target/L_source) * (p_source-p_source_rest)`。站距另按目标髋宽求解。
2. 用 `contacts`、逐脚力及足底位置识别整足、脚跟、前掌支撑，采用不同入/出接触阈值和稳定窗口。支撑进入时锁定目标脚底的世界锚点，而不是把它锁到移动的 pelvis 上。
3. 将足底局部锚点 `r_sole` 转成踝骨目标：`p_foot = contactWorld - R_foot*r_sole`。踝骨不能直接贴到地面高度。
4. 在锁脚约束下，用低维 pelvis 高度/前后搜索及双腿解析 IK，使双腿均可达。可最小化归一化的姿态差、脚底接触误差、骨盆位移与限位惩罚；优先保持骨长和接触，再尽量贴近源关节动作。不可达则报告残差，不缩放骨骼或拉长蒙皮。
5. pole 来自角色标定与稳定规则；完全伸直的骨链不能只用叉积构造弯曲平面。前掌 pivot、脚跟抬起和腾空需分别处理，离地时释放脚锁。
6. 拖动时间轴、倒放或跳帧时，接触区间和锚点必须可从 clip 重建；不能只依赖连续播放的历史。

不同体型无法同时严格保持所有源关节角、相同的世界坐标轨迹与双脚锁定。发生冲突时，采用“骨长/接触约束优先，再保持动作相似”的策略，并保留误差诊断。体积、衣服宽度与手臂避碰还需可选碰撞包络，不能从骨长单独推导。

躯干屈伸按规范通道分配到 profile 中现有 spine chain；减少或增加脊柱段数时用权重和归一化分配，总转角保持一致。目标骨缺失时只跳过对应次要运动；必需的上/下肢主链缺失则明确拒绝该动作类别，不静默显示错误动画。

## 对现有实现的改造

- `AvatarAdapter` 当前从单个 `rig.json` 建立所有 rest 点，并默认要求映射里每块骨骼存在；改为从 GLB skeleton 自动提取并基于 profile 验证，允许可选骨骼缺失。
- 上肢和默认站姿包含米制固定 offset；下肢姿态使用固定的 0.915 m 骨盆基准和固定站距。改为按身高、骨盆宽度和量出的 limb lengths 导出比例配置。
- `solveLimb` 中 `frameRotation` 是 bind 到当前方向的增量，需按 `desiredWorld = delta * bindWorld` 校准，按 `parentWorld` 转成局部旋转。`setWorldRotation` 才接受绝对 world quaternion。
- `rotateLocalEulerDeg` 与手指放松当前直接覆盖局部四元数；通用 rig 应把经校准的关节增量叠加到保存的 rest local quaternion。
- `retargetLowerBodyFrame` 当前忽略 contacts 里的逐脚支撑状态；增加足底 landmark/contact 锁定和骨盆可达性解算。
- `applyVisualMaterials` 会将所有 `SkinnedMesh.material` 替换成肤色，破坏带制服/颜色贴图的模型；通用加载须默认保留 GLB 原材质。仅在 Profile 明确配置时覆写特定网格/材质。
- 自动 Profile 应支持多种 Tripo skeleton spec 名称，但不能假设相同 `mixamo`/`vrm` 骨名必定具有相同 bind axes、姿势、单位或蒙皮质量。
- `retargetPhysicalArm` 的 landmark fallback 当前用 `pi-angle(upper,forearm)` 求屈肘，但按现有向量方向，伸直时夹角为 0；在缺少 `elbow_flex` 覆写的 clip 中会反转屈曲含义。需用独立的伸直/屈肘输入验证，而不能只测带角度通道的演示文件。

## Tripo 工作流和版本检查

Tripo 官方 Auto Rig 文档给出的示例使用显式 `model: v3.0-20260909`、`rig_type: biped`、`spec: mixamo` 并导出 GLB；同页示例也列有 VRM。官方更新日志说明 v3.0 必须显式请求，默认模型保持不变。Auto Rig Check 先验可用性，文档展示的检查任务 `credits_consumed` 为 0；实际账号价格和额度应以账户余额/计费接口响应为准。通过检查后再提交 Rig，随后用独立动画测试验收，不将 Rig 成功等同于权重质量合格。

本次核查日期为 2026-11-06。当前会话暴露的 Tripo 包装器与官方 API v3 文档存在版本差异。生产前须核查实际工具 schema、CLI help 和后端支持，不假设包装器能传入新值，也不把默认值当最新版本。如果工具不能表达现行参数，再更新工具或通过已授权、经核验的官方 API 路径执行；不要继续采用早先的 v2.5 biped 假设。

`spec` 是骨名约定；`spec=vrm` 也不意味着 GLB 必定带完整 VRM 扩展元数据。Tripo Retarget 文档描述预置动画应用，不能据此认定能直接上传并播放任意 h3d 动作。新 API 文档也标记 `bake_animation` 已弃用并被忽略，应按当前参数页核对。

来源：

- Tripo Auto Rig: https://developers.tripo3d.ai/en/docs/animations-rig
- Tripo Auto Rig Check: https://developers.tripo3d.ai/en/docs/animations-rig-check
- Tripo Changelog: https://developers.tripo3d.ai/en/docs/changelog
- Tripo Retarget: https://developers.tripo3d.ai/en/docs/animations-retarget

## 验收矩阵

至少使用当前 MakeHuman 加两个来源独立、不同比例的人形 GLB，至少一个为当前 Tripo rig 输出。覆盖 A/T bind、非 identity 旋转、不同源单位、无手指、无 twist、不同 spine 段数、多个蒙皮网格及重名骨。合成的比例变体仅作回归辅助，不能代替第二个真实资产的蒙皮验收。

检查 A-pose、自然站立、单臂抬 90 度、屈肘 90 度、双臂上举、单膝屈曲、深蹲下降/最低/上升、躯干旋转；每姿态检查正视与侧视，异常补背视。量化检查：非有限/零长骨骼、肢体断开、脚底滑移、目标与源关节角差、pole 翻转、蒙皮关节区域拉伸和未映射必需骨。验证原权重/inverse bind 与源 clip 不变。保存 profile diagnostics、bind pose 截图、各姿态 GLB/Viewer 截图和失败原因。

当前可测试的独立动作仍受 h3d `h3d.motion.v1` 简化 DOF 限制；适配器只能忠实重定向已有信息，不能从 Profile 合成仿真里没有的肩胛、躯干三维旋转、左右独立腿或平衡控制。

## 实施顺序

1. **导入检查器及标定缓存**：资产 hash、skin/骨架描述、骨名候选、能力诊断、保留材质；无需接 MuJoCo。
2. **Bind-aware 旋转与比例重定向**：独立姿态测试验证 A/T bind、父旋转、不同 limb 比例、缺可选骨骼；通过后接当前动作 JSON。
3. **足底接触和骨盆调整**：验证深蹲、离地、顺放及跳帧；每个真实资产留正侧视证据。
4. **扩充资产注册**：验收合格的 GLB 才加入 UI 注册表，再按实际需要加入 twist 分配、体积避碰和复杂衣服能力。


## 已实现首版的使用方式

运行 `npm run web`，打开 http://127.0.0.1:4173/ 。在“选择模型”中切换 CesiumMan 或 KayKit Knight，选择同一动作观察体型差异。原 MakeHuman 路径继续保留。

点击“导入模型”选择一个内嵌贴图的 GLB。常见骨名会自动映射；自定义骨名需同时选择 v2 配置 JSON，通过 `rig.boneOverrides` 指定角色到节点名称或 `path:` 节点选择器。系统展示缺失角色、歧义、坏层级或绑定矩阵不一致的具体原因。没有皮肤网格的骨架不能作为可用角色导入。

点击“保存配置”下载 JSON，其中包含资产 SHA-256 和重新计算的标定报告；下次同时选择原 GLB 和该 JSON 即可复用。配置不包含 GLB，页面刷新后本地导入需重新选择文件。为了避免错误缓存，当前每次导入都重新标定，不直接恢复旧报告。

单位采用 glTF 的米制/Y-up；错误单位用 `calibration.unitScale` 显式校正，前向支持自动推断或 ±X/±Z。镜像、非均匀缩放、非站立 A/T bind 及不完整主链会拒绝。可缺手指、toe 或 twist；首版保留它们的 bind 姿态，尚未实现 twist 分配和手指动作。

新导出的动作带 `rig.sourceRest.positions`，来自 MuJoCo 初始动作之前的真实静止 site。旧演示下肢动作可从精确 `rig.bodies` 校准；两者都缺失时不使用共享 display landmarks 伪造标定。

首版足底接触采用逐脚力的入/出阈值和短暂释放混合、一个足底锚点以及双腿可达性投影。尚未支持独立 heel/toe pivot、接触持续时间去抖及全身优化。足底锚点当前由网格最低点和脚踝位置推导，带拖地装饰或不平鞋底的模型仍需后续显式足底标定。后续新增的显示层胶囊体避碰与独立衣物准静态约束见 [角色碰撞说明](avatar-collision.md)；该原型提供残留诊断，尚非完整的复杂服装动力学。

验收记录：类型检查与 82 项自动测试通过；Chrome 桌面 1440×1000、手机 390×844 验证通过。两个独立模型覆盖四组动作采样，骨长最大误差约 1.91e-7 m，IK 残差最大约 1.93e-7 m。已检查抬臂屈肘、下蹲、蹬伸的正侧视截图及配置导出再导入、无效模型拒绝、手机无横向溢出。数值结果不代表复杂服装或所有姿态均通过蒙皮验收。
