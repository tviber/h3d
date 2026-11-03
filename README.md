# h3d

h3d 是一个人体多体动力学模拟器（v0.0.1）。它在 MuJoCo 里用真实关节力矩驱动一个简化的人体上肢加球拍模型，做正向动力学仿真，并自动输出拍头运动、关节功率和做功的定量对比。

第一个研究问题：在手臂力矩完全相同的条件下，加入骨盆和躯干的主动旋转会不会改变拍头速度？这个旋转的时机有多重要？

## 定位

- A/B/C 球拍模型由开环关节力矩脉冲驱动，不使用关键帧、位置伺服或直接写入 qpos；独立肌肉实验另支持激活脉冲和闭环姿态反馈。
- 同一配置和运行环境可重复得到确定性记录，测试覆盖既有 A/B/C 结果与肌肉实验模块。
- A/B/C CLI 会核对雅可比速度、能量平衡和角动量；肌肉实验另测试真实地面接触力、动作导出终点和模块边界。
- 依赖尽量少：运行时只依赖官方 MuJoCo WASM 绑定 `@mujoco/mujoco`。PNG 编码器和图表栅格化都是自带实现（基于 `node:zlib`），不需要浏览器，也不需要 GPU。

## v0.0.1 范围

已完成：

- MJCF 模型：骨盆、躯干、右上臂、前臂、手、球拍，共 5 个铰链自由度（骨盆旋转、躯干扭转、肩水平内收、肘屈、腕屈），每个自由度一个力矩电机。体段参数取自 de Leva (1996)，缩放到 75 kg。
- 控制：力矩 = f(关节, 时间)，由平滑脉冲叠加（峰值、起始时间、持续时间、方向，可选 sin² 或平台形状）。
- 每个实验记录：时间、qpos/qvel/qacc、实际执行器力矩、关节功率、累计功、拍头（弦床中心）位置/速度/加速度（雅可比计算，并用有限差分交叉校验）、动能/势能、角动量，以及各关节对拍头速度的贡献分解。
- A/B/C 对比：共用同一个模型、同一个初始姿态、同一组手臂力矩脉冲对象，自动生成 CSV、JSON、Markdown 报告和 5 张 PNG 图。
- CLI（`compare`、`run`、`info`），49 个 `node:test` 测试，GitHub Actions CI（类型检查、测试、CLI 冒烟）。

v0.0.1 的五自由度球拍模型仍是理想力矩电机模型；下面新增的肌肉实验使用独立 MJCF 和模拟模块，不改变 A/B/C 既有结果。

## 肌肉实验与 3D 查看器

现有四组肌肉驱动实验：

- `single-elbow`：肘单关节、肱二头肌与肱三头肌对抗。
- `shoulder-elbow`：肩和肘两个自由度，含跨关节肱二头肌长头、肱三头肌长头，以及肱肌、后束三角肌。
- `squat-to-stand`：浮动根部、骨盆、躯干、髋膝踝与四点足底接触，从深蹲起立。
- `countermovement-drive`：先下沉，再通过髋膝踝肌群完成向上蹬伸。

肌腱路径由 MuJoCo `spatial tendon` 描述。肌肉模块读取路径长度、速度和稀疏肌腱雅可比，以 `τ = −(dL/dq) · F` 计算关节力矩；力模型含长度、速度、被动力和一阶激活动力学。Motor Control 同时支持平滑开环激活脉冲与闭环目标姿态跟踪；下肢实验用有界肌肉激活分配器拟合目标关节力矩，并用重心与骨盆反馈维持支撑。

Physics Simulation 负责浮动根部和关节的正向动力学、足底接触、地面反力与肌肉功率。动作文件包含身体测点、重心、关节状态、肌肉激活与肌力、总及分足地面反力、压力中心、接触点、肌腱三维路径、区域肌肉功率和动作阶段。最后一帧时间严格等于实验时长。

后端生成版本化的 `h3d.motion.v1` JSON；`src/` 不导入 `web/` 代码。前端只读取 JSON，不加载 MuJoCo，也不参与控制或物理计算。独立 WebGL 查看器提供正面、侧面、背面和 45° 视角，人体表面、骨骼关节、坐标轴、地面反力与肌腱路径开关，以及时间轴、阶段标记、倍速播放和动作文件导入。

```sh
npm run muscles   # 用 0.5 ms 仿真步长运行四组实验，更新 web/demo-motion.json
npm run web       # 启动独立静态查看器，打开 http://127.0.0.1:4173/
```

导出帧通常每 5 ms 一帧，内部积分仍使用 0.5 ms 步长。查看器可以载入其他 `h3d.motion.v1` JSON；更换动作文件不会触发重新仿真。

这是可运行的研究原型，不是经人体数据标定的肌肉骨骼模型：肌腱视为不可伸长，肌纤维与肌腱同向，没有羽状角、疲劳或个体参数标定。下肢是共享节段运动的矢状面降阶模型，双脚通过四个接触点与地面作用；查看器中的体表为简化展示几何。闭环控制是演示用姿态和重心反馈，不是临床或运动表现预测。

## 安装

需要 Node.js ≥ 22.18（直接运行 `.ts` 源码，用的是 Node 内置的类型剥离，不需要编译）。

```sh
git clone <repo-url> h3d
cd h3d
npm ci
```

## 运行 A/B/C

```sh
npm run h3d -- compare            # 等价于：node src/cli.ts compare
```

默认读取 `experiments/abc.json`，结果写到 `out/abc/`。常用参数：

```sh
node src/cli.ts compare --out out/abc                  # 指定输出目录
node src/cli.ts compare --duration 0.8                 # 覆盖仿真时长 (s)
node src/cli.ts compare --no-png                       # 只要数据，不出图
node src/cli.ts compare --config experiments/abc.json  # 指定其他配置
node src/cli.ts run B                                  # 只跑某个实验（只写 CSV 和 JSON）
node src/cli.ts info                                   # 打印模型的体段质量、关节、力矩上限
```

退出码：0 表示正常，1 表示某项自检超限，2 表示参数或输入错误。

终端输出示例（本机实测，3 个实验共约 0.2 s）：

```
run  peak |v_head|   t_peak    vs first   checks
A      17.62 m/s   0.3390 s   baseline   pass   arm only (pelvis/trunk unactuated)
B      29.48 m/s   0.3145 s     +67.3%   pass   pelvis -> trunk -> arm (proximal first)
C      14.10 m/s   0.3590 s     -20.0%   pass   pelvis + trunk start with the arm
```

### 三组实验

三组实验的初始姿态都是静止（骨盆 -45°，肩 -40°，腕 -60°），时长 0.6 s。手臂脉冲完全相同：肩 60 N·m @ 0.12 s / 0.20 s，肘 25 N·m @ 0.16 s / 0.15 s，腕 6 N·m @ 0.22 s / 0.12 s。

| 实验 | 骨盆 / 躯干驱动 |
| --- | --- |
| A | 无驱动（被动：可以自由转动，只有脊柱扭转弹簧和阻尼） |
| B | 骨盆 120 N·m 从 0.00 s 开始，躯干 80 N·m 从 0.05 s 开始，各持续 0.30 s（近端先动） |
| C | 和 B 的力矩相同，但都从 0.12 s 开始，与手臂同时启动 |

### 结果（v0.0.1，`experiments/abc.json`）

| 实验 | 峰值拍头速度 | 相对 A | 峰值时刻 | 峰值前执行器总功 | 其中骨盆 + 躯干 |
| --- | --- | --- | --- | --- | --- |
| A | 17.62 m/s | 基线 | 0.3390 s | 75.2 J | 0 J |
| B | 29.48 m/s | +11.86 m/s (+67.3%) | 0.3145 s | 157.0 J | 119.7 J |
| C | 14.10 m/s | −3.52 m/s (−20.0%) | 0.3590 s | 89.7 J | 57.3 J |

在这个模型和这组力矩下：

- 同样的手臂力矩，骨盆和躯干先动（B）时拍头峰值速度高 67%，峰值提前 24.5 ms。近端关节在峰值前多做了约 120 J 的功。
- 同样的近端力矩，如果和手臂同时启动（C），拍头速度反而比 A 低 20%，尽管近端也做了约 57 J 的功。原因是 C 的躯干在手臂加速的时候才开始转，峰值时刻肩关节相对躯干是向后转的（−11.2 rad/s，对拍头速度的贡献是 −12.3 m/s）。手臂落在躯干后面，没有被"甩"出去。
- 也就是说，近端旋转的时机比它多做了多少功更重要。这个结论只针对这一组手工设定的参数，还没有做灵敏度分析（见"下一步"）。

各关节对拍头速度的分解、峰值时刻的关节角和角速度、能量平衡和限位接触情况都在 `out/abc/report.md` 里。

## 查看结果

`out/abc/` 下的文件：

| 文件 | 内容 |
| --- | --- |
| `report.md` | 所有数字表格（峰值速度、各关节做功和功率、速度分解、能量平衡、限位、自检），并引用全部图 |
| `comparison.json` | 机器可读的完整对比：模型参数、各实验的脉冲、summary、相对 A 的差值、逐位相同的输入关节 |
| `A.timeseries.csv` 等 | 每个样本一行（dt = 0.5 ms，共 1201 行），102 列，列定义见 [docs/physics-model.md](docs/physics-model.md#5-输出量定义) |
| `A.summary.json` 等 | 单个实验的配置和标量汇总 |
| `head_speed.png` | A/B/C 拍头速度随时间的曲线，标出峰值 |
| `peak_head_speed.png` | 峰值拍头速度柱状图，带相对 A 的变化 |
| `joint_power.png` | 各关节执行器功率曲线（每个关节一个小图，A/B/C 叠在一起） |
| `joint_work.png` | 峰值前各关节累计执行器功（分组条形图） |
| `joint_torque.png` | 各关节实际施加的力矩，显示手臂三个关节在 A/B/C 中完全相同 |

PNG 直接用看图软件打开即可。CSV 可以用 pandas、Excel 或任意工具读：

```python
import pandas as pd
b = pd.read_csv("out/abc/B.timeseries.csv")
b.plot(x="time", y=["head_speed", "butt_speed"])
```

## 自定义实验

配置是 JSON 格式。实验由命名的脉冲集组合而成，同一个脉冲集被多个实验引用时，它们的输入天然相同：

```json
{
  "model": "../models/upper_body.xml",
  "duration": 0.6,
  "initialPoseDeg": { "pelvis_rot": -45, "shoulder_hadd": -40, "wrist_flex": -60 },
  "pulseSets": {
    "arm": [{ "joint": "shoulder_hadd", "peak": 60, "start": 0.12, "duration": 0.2, "direction": 1 }],
    "hips": [{ "joint": "pelvis_rot", "peak": 120, "start": 0.0, "duration": 0.3, "direction": 1, "shape": "plateau", "rise": 0.05 }]
  },
  "experiments": [
    { "id": "A", "label": "arm only", "use": ["arm"] },
    { "id": "B", "label": "hips first", "use": ["arm", "hips"] }
  ]
}
```

- `model` 是相对配置文件的路径。`initialPoseDeg` 里没写的关节从 0° 开始，初速度都是 0。
- `peak` 单位 N·m（≥ 0），`direction` 取 1（向前挥拍方向）或 −1。`shape` 可选 `sin2`（默认）或 `plateau`。
- 施加的力矩 = gear · clamp(tau / gear, −1, 1)，超过上限时会被截断，并在 summary 里标为 `saturated`。
- 对比以列表中的第一个实验为基线。图表最多支持 3 个实验（3 个经过色觉验证的分类色），数据输出没有这个限制。

## 测试

```sh
npm run typecheck   # tsc --noEmit
npm test            # node:test，49 个测试，约 3 s
npm run smoke       # CLI 冒烟：compare --no-png 写到 out/smoke
```

测试覆盖：A/B/C 脉冲、执行器映射、确定性和物理自检；肌肉力-长度-速度、拮抗力臂、激活动力学、轨迹采样和有界肌肉分配；浮动基座、地面接触力、压力中心、肌腱路径、区域功率和精确动作终点；后端/查看器导入边界；PNG、报告和 CLI 输出。

## 项目结构

```
models/upper_body.xml            五自由度球拍模型
models/muscle_elbow.xml           单关节肌肉实验 MJCF
models/muscle_shoulder_elbow.xml  肩肘肌肉实验 MJCF
models/muscle_lower_body.xml      骨盆躯干、下肢与足底接触 MJCF
experiments/abc.json              A/B/C 力矩实验配置
experiments/muscle-demo.json      四组肌肉实验、轨迹和激活配置
src/control.ts                    力矩脉冲和执行器映射
src/experiment.ts                 配置加载和校验
src/simulate.ts                   原始模型正向动力学
src/analysis.ts                   峰值、做功、能量平衡、自检
src/report.ts                     CSV / JSON / Markdown 输出
src/charts.ts                     对比图
src/plot/                         PNG 编码器和栅格化
src/muscle-model.ts               肌腱几何、肌肉力和关节力矩
src/motor-control.ts              开环激活、轨迹反馈与激活分配
src/muscle-simulate.ts            肌肉模型、接触动力学与逐步记录
src/muscle-experiment.ts          肌肉实验配置加载和校验
src/motion-clip.ts                后端独立的动作 JSON 导出
src/muscle-cli.ts                 肌肉实验运行和动作导出
src/web-server.ts                 静态文件服务器，不运行仿真
web/                              独立 WebGL 动作查看器
 test/muscle.test.ts              肌肉模型、控制、接触与导出测试
test/                             node:test 测试
 docs/physics-model.md            力矩模型与肌肉实验说明
```

## 近似与限制

完整清单见 [docs/physics-model.md](docs/physics-model.md#7-近似与限制)，主要几点：

- 原始 A/B/C 模型只有 5 个平面转动自由度；没有肩内外旋、前臂旋前旋后、肩上举，也没有地面反力。它仍使用理想力矩电机。
- 下肢实验是矢状面降阶模型，双侧足底接触点共享一套髋、膝、踝节段运动；没有侧向平衡、左右腿差异或真实人体蒙皮动力学。
- 肌肉使用不可伸长肌腱和近似 Hill 力模型，路径、力参数与姿态反馈尚未按个体标定；没有羽状角、疲劳和弹性肌腱。
- 关节限位是 MuJoCo 软约束。原始 A/B/C 里肘、腕（以及 B 的肩）会碰到限位，B 在峰值前被限位吸收了 19.5 J。
- A 的骨盆和躯干是被动的，不是锁死的；下肢闭环姿态/重心反馈是演示控制器，不代表生理控制或个体运动能力。

## 下一步（候选）

1. 对原始 A/B/C 模型扫描近端起始提前量和幅值，加入躯干锁死对照与灵敏度分析。
2. 用测量数据校准四组肌肉实验的肌腱路径、最大肌力和肌纤维参数，并核对接触与关节力矩方向。
3. 扩展下肢模型的三维自由度和左右独立支撑，再用轨迹优化或模型预测控制研究肌肉激活策略。

## 许可

Apache-2.0（与 MuJoCo 一致）。
