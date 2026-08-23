# 中国象棋 TV

面向天猫魔盒 Q8 畅越版的中国象棋电视游戏。棋盘、规则、交互和本地回退 AI 运行在电视盒子上；排位自适应、Pikafish 走棋、局面分析、历史对局与赛后复盘由云端服务完成。客户端采用 Vue 3 + TypeScript，并由一个尽可能薄的 Kotlin WebView 壳打包为 Android APK。

当前进度：Phase 25–28 已完成开发。游戏改为以真人棋手 Profile 为核心的排位自适应模式：每个 Profile 独立保存评分、段位、历史对局和 AI 复盘，客户端不再提供手动 AI 难度或自定义深度。新棋手从 A1 / 1050 分起步，有效排位局驱动 A0–A7 强度调整；本地双人保留但不计分。

## 已验证目标设备

| 项目 | 实测值 |
| --- | --- |
| 厂商 / 型号 | Tmall / MagicBox_M_30_F |
| Android API | 29（Android 10 基础） |
| 应用 ABI | armeabi-v7a, armeabi |
| Android 运行时 | zygote32 |
| Android 应用合成分辨率 | 1920 × 1080 @ 60Hz |
| HDMI 实际输出模式 | 4096 × 2160 @ 约 60Hz |
| Density | 240 dpi |
| 内存 | 980444 kB |
| WebView | com.android.webview 74.0.3729.186 |
| 网络 ADB | 192.168.3.11:5555 |

设备的 `ro.build.version.release` 为厂商版本号 `10.0.1-RS-20231226.2109`，兼容性判断以实测 API 29 为准。

显示链路采用双层分辨率：Android `DisplayInfo` 与 SurfaceFlinger 使用 1920×1080 缓冲，底层显示引擎以 HDMI mode 35 输出 4096×2160，并对 1080P 内容做硬件缩放。因此 UI 继续以 1080P 应用画布为主要设计基准，同时在 720P CSS 视口和 4K 电视输出上真机验证。

## 技术栈

- Web：Vue 3、TypeScript、Vite、Vitest
- Android：Kotlin、Android WebView、AndroidX WebKit、Gradle
- 服务端：FastAPI、SQLite WAL、Pikafish + NNUE、Nginx、systemd
- 本地内容：`WebViewAssetLoader`
- 包管理器：pnpm

WebView 通过 `https://appassets.androidplatform.net/assets/index.html` 加载 APK 内资源，不使用 `file:///android_asset/`。Android 壳只声明 `INTERNET` 权限，不开放 JavaScript Bridge，并关闭 WebView 文件访问。云端 API 使用 HTTPS、Bearer Token 和固定服务端 CA 校验。

## 项目结构

```text
xiangqi-tv/
├── android/        Android WebView 壳
├── web/            Vue 3 应用
├── server/         FastAPI、Pikafish、SQLite、Nginx 与 systemd 配置
├── docs/           各阶段设计、测试和部署记录
├── scripts/        构建和设备辅助脚本
└── README.md
```

游戏代码按以下边界组织：

```text
UI → InputController → GameController → RuleEngine / GameState / AIEngine
```

规则层不会依赖 Vue、DOM 或 Android。

## 核心功能

- 严格中国象棋规则：合法着生成、将军/将死/困毙、重复局面和禁止反复长将。
- 棋手 Profile：冷启动选择实际玩家，每台设备最多 6 个独立档案，支持新建、改名、头像、切换、重置和软删除。
- 排位自适应：客户端不再提供固定难度选单；每个 Profile 独立保存排位分、A0–A7 段位和调整进度。
- 云端 AI：普通对局、三路候选局面分析和赛后逐手复盘由 2C2G VPS 上的 Pikafish 执行；断网时安全回退到本地 AI。
- 历史对局：服务器保存对局时间、结果、评级、棋谱和 AI 分析，客户端按需加载并逐手回放。
- 电视交互：鼠标优先，同时完整支持遥控器方向键、OK 和 BACK；1080P 应用画布与 4K HDMI 输出均已真机验证。

当前排位等级与 AI 强度：

| 等级 | 搜索策略 |
| --- | --- |
| A0 | 本地 D2 |
| A1 | 云端 D3，较强拟人化 |
| A2 | 云端 D3，中等拟人化并更偏向最佳着 |
| A3 | 云端 D4 |
| A4 | 云端 D5 |
| A5 | 云端 D7 |
| A6 | 云端 D9 |
| A7 | 云端 D11 |

新 Profile 从 A1 / 1050 分开始。只有完成且分析成功、未悔棋、未回退、达到最少手数的人机对局才参与排位；每次调整最多升降一级。

## 环境要求

- Node.js 26（当前已验证 26.5.0）
- pnpm 11（当前已验证 11.0.4）
- Android SDK Platform 36
- Android SDK Build Tools 36.0.0
- Android SDK Platform Tools
- Android Studio 自带 JDK

Android 配置：

```text
minSdk 23
targetSdk 36
compileSdk 36
Java / Kotlin bytecode target 17
```

项目不使用 NDK，因此不设置 `abiFilters`。如果未来引入原生库，必须包含 `armeabi-v7a`。

## Web 开发

首次安装依赖：

```bash
pnpm --dir web install
```

启动开发服务器：

```bash
pnpm --dir web dev
```

浏览器访问终端显示的本地地址。当前应看到完整的 9×10 中国象棋棋盘、32 枚初始棋子和右侧状态面板。

运行测试和生产构建：

```bash
pnpm --dir web test
pnpm --dir web build
```

生产构建目标为 Chrome 74，以兼容盒子实测 WebView。

## Android 构建

一条命令构建 Web、生成 Debug APK 并执行交付校验：

```bash
VITE_XIANGQI_API_TOKEN='<测试令牌>' ./scripts/build-android.sh
```

APK 输出位置：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

构建脚本要求显式提供至少 32 字符的云端测试令牌，缺失时立即失败，避免排位自适应、Profile 与历史对局功能静默失效。令牌只通过构建环境传入，不写入 Git 跟踪文件。

构建结束时会自动检查 APK 压缩完整性、HTML/JS/CSS/AI Worker 离线资源、Android 权限、原生库和 v1/v2 签名。也可以对已有 APK 单独执行：

```bash
./scripts/verify-apk.sh
```

也可以在 Web 已构建后单独执行：

```bash
cd android
./gradlew assembleDebug
```

## ADB 安装

连接盒子：

```bash
adb connect 192.168.3.11:5555
adb devices -l
```

构建、覆盖安装并启动应用：

```bash
./scripts/deploy-debug.sh
```

也可以手动安装：

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

启动应用：

```bash
adb shell am start -n com.xiangqitv.app/.MainActivity
```

执行完整真机性能复测：

```bash
./scripts/profile-device.sh
```

测试结果见 [Phase 10 天猫魔盒真机测试报告](docs/phase-10-device-test.md)。

优化结果见 [Phase 11 性能优化报告](docs/phase-11-performance.md)。

体验优化结果见 [Phase 12 体验优化报告](docs/phase-12-experience.md)。

局面分析结果见 [Phase 16 云端分析报告](docs/phase-16-analysis.md)。

输入与状态联动结果见 [Phase 17 联动报告](docs/phase-17-analysis-interaction.md)。

最终部署结果见 [Phase 18 部署验收报告](docs/phase-18-deployment.md)。

对局生命周期与自适应结果见 [Phase 19–22 实施报告](docs/phase-19-22-adaptive.md)。

历史对局结果见 [Phase 23 历史与回放报告](docs/phase-23-history.md)。

监控、校准与备份结果见 [Phase 24 运维验收报告](docs/phase-24-operations.md)。

棋手档案与纯排位模式见 [Phase 25–28 实施报告](docs/phase-25-28-profiles.md)。

## 操作方式

鼠标：

- 移动到棋盘交叉点：Hover 高亮
- 左键点击本方棋子：选择或切换选择
- 点击绿色落点：移动；绿色圆环表示可吃子
- 点击非法空位、当前棋子或右键：取消选择

遥控器：

- 方向键：移动棋盘光标
- OK / CENTER / ENTER：选择棋子或确认落子
- 光标位于棋盘最右列时继续按右：进入对局操作区
- 操作区使用方向键在悔棋、重新开始、对战模式、棋手档案、设置、分析和历史之间移动，确认键执行
- “设置与棋谱”位于操作区最后一项；面板内使用方向键切换、OK 修改、BACK 返回
- 操作区按 BACK：返回棋盘
- BACK：优先取消选择；没有选择时退出应用

鼠标和遥控器共用 `InputController → GameController`，切换输入模式不会重置棋局。黄色方框表示遥控焦点，青色方框表示已选棋子，绿色实心点表示普通落点，绿色圆环表示吃子目标，蓝色与橙色分别表示上一步起点和终点，红色框表示当前被将军的将/帅。

## 当前状态

Phase 25–28 已完成 Profile 排位模式。SQLite schema v5 为棋手增加设备归属、名称、头像、软删除和最近使用时间，并能把旧玩家数据无损迁移为默认棋手。客户端冷启动先选择实际玩家，所有新请求使用 `deviceId + profileId` 核验数据归属；评级、历史、棋谱和 AI 复盘均按 Profile 隔离。原固定难度和自定义深度入口已移除，人机对局只使用 A0–A7 排位自适应。右侧对局信息已针对远距离观看放大，七项功能菜单完整保留在 1080P 电视安全区内。前端 76 项、服务端 24 项自动测试全部通过，最终 APK 已完成盒子鼠标与遥控器实机验证。

Phase 19–24 已完成云端对局生命周期、后台赛后分析、评级、自适应、历史回放和运维闭环。客户端通过本地 outbox 幂等同步开局、快照和终局；VPS 使用 SQLite WAL 保存棋局与逐手分析，Pikafish 后台任务会为实时走棋和局面分析让出引擎。服务提供受 Token 保护的历史、指标和 Profile 接口，并使用 systemd timer 每日在线备份数据库。生产环境为 `112.74.108.214`，域名 `823147.xyz` 通过 HTTPS 提供服务。

Phase 18 已完成云端分析部署验收。VPS 与本地分析服务文件校验值一致，API 和 Nginx 均为 active；MultiPV 1/3、三档定时分析、客户端中断恢复和长将历史局面全部通过。初始局面快速、标准、深入分析分别约为 1502ms / D17、3001ms / D19、5002ms / D19；5 秒资源采样中 Pikafish 峰值 RSS 约 351MB，系统最低可用内存 853MB，Swap 未使用。最终 APK 已覆盖安装，冷启动 1760ms；显示驱动确认 1920×1080 应用缓冲经 HDMI mode 35 以 4096×2160、60.6Hz 输出。

Phase 17 已完成分析输入与棋局状态联动。分析改为右侧窄面板，鼠标悬停候选或遥控器焦点移动到候选时，左侧棋盘即时预览紫色虚线起点和紫色实框终点；点击或按 OK 后自动返回棋局并保留高亮，不会直接落子。走子、悔棋、重新开始和模式切换会清除高亮并取消旧请求；AI 思考期间禁止分析，网络失败只显示错误提示，不影响本地游戏。真机已完成鼠标点击与 D-pad 焦点预览/确认验证。

Phase 16 已完成电视端云端分析面板。右侧操作区新增“局面分析”，打开后默认执行约 3 秒的标准分析，也可用鼠标或遥控器切换快速 1.5 秒、标准 3 秒和深入 5 秒。面板显示红方视角评价、动态评价条、实际深度、节点数、耗时、三路候选着法和最多八个半回合的中文主变化。关闭面板、局面变化、切换后台或开始新请求都会取消旧分析，过期结果不能覆盖当前局面。1920×1080 浏览器和天猫魔盒 WebView 74 均已验证不溢出；真机初始局面标准分析达到 D19、2,066,657 节点、3001ms。前端 69 项测试通过。

Phase 15 已完成电视端分析客户端与数据模型。`RemoteAiClient` 新增局面分析请求，支持 100–5000ms 和一至三路候选；服务端返回会经过运行时结构、回合与排名校验，UCI 主变化逐步验证合法性并转换为既有 `Move` 类型和中文棋谱。分析与走棋共用统一的请求序列和取消机制，新请求、超时或主动取消后，旧响应不能覆盖当前局面。前端 64 项自动测试及生产构建均已通过；本阶段尚未添加可见界面。

Phase 14 已完成云端局面分析基础。VPS 新增经过 Bearer Token 保护的 `/v1/xiangqi/analyze` 接口，支持 100–5000ms 定时搜索和最多三路 MultiPV，返回红方视角评价、实际深度、节点数、NPS 与主变化。分析和 AI 走棋共用单引擎锁；客户端断开时发送 `stop`，分析结束后恢复 `MultiPV=1`，不会污染原有走棋。2C2G 实机初始局面快速分析 1500ms 达到 D16，标准分析 3000ms 达到 D19；8 项服务端测试通过。电视端分析面板将在后续阶段接入。

Phase 12 已完成体验优化。应用使用 Web Audio API 实时合成选棋、落子、吃子、将军和胜利五类短音，不携带音频资源。棋子采用 150ms 轻量走子动画；音效和动画都能在“设置与棋谱”面板独立关闭，并保存在本机 WebView 存储中。

每一步现在会生成简明象棋记谱，红方使用中文数字、黑方使用阿拉伯数字；悔棋和重新开始会同步更新棋谱。设置弹层及五项主操作已通过 WebView 74 真机遥控器验证，稳定空闲 Total PSS 为 99747KB。最终 APK 为 1371037 bytes，45 项自动测试全部通过。

Phase 13 已完成 AI 强化。搜索加入置换表、PV/杀手/历史走法排序、MVV-LVA 吃子排序、静态搜索和阶段化位置评估；棋盘查询使用 90 格缓存，将军受攻判断改为车炮射线、马腿和过河兵的直接检测。困难档真机达到 D3 / 10656 节点 / 3208ms，大师档达到 D4 / 19264 节点 / 7030ms。

Phase 11 已完成基础性能优化。AI 叶子节点不再重复生成合法走法，截止时间改为逐节点检查，并复用根走法；当时困难档从 Phase 10 的 D2 / 512 节点提升至 D3 / 2316 节点，同时耗时从 4329ms 降至 2805ms。

棋盘的 90 个交叉点和 32 枚棋子使用视觉状态缓存与增量更新，合法落点改为坐标 Map 查询，遥控器移动不再刷新未改变的棋局快照。AI Worker 在一回合结束且没有待处理任务时释放，使真机单回合 PSS 增量从约 10.7MB 降到约 6.7MB。最终候选 APK 为 1368784 bytes，40 项自动测试全部通过。

Phase 10 已完成目标盒子真机性能测试。三次有效冷启动平均为 1801ms；稳定空闲 Total PSS 为 101814KB，困难 AI 完成后为 112729KB。鼠标、遥控器、1080P 应用画布、4K HDMI 缩放、中文字体和 WebView 74 离线 Worker 均已验证。

AI 性能数据显示在对局信息栏中。Phase 10 发现的三档超时问题已经在 Phase 11 修复；原始基线和测试边界仍保留在 `docs/phase-10-device-test.md`。

Phase 9 已完成可重复的 APK 构建、校验和真机部署流程。`build-android.sh` 会在构建后自动调用 `verify-apk.sh`；`deploy-debug.sh` 会继续完成 ADB 覆盖安装、冷启动、进程存活和前台 Activity 检查。针对厂商应用商店偶发抢占前台的情况，部署与诊断脚本只接受实际进入象棋主界面的结果，并进行有限重试。当前 Debug APK 不包含原生库，只申请云端功能所需的 `INTERNET` 权限，包含全部本地游戏资源，并通过 v1/v2 签名验证。

Phase 8 已完成 Android WebView 集成审计与加固。应用仅允许主文档导航到 `https://appassets.androidplatform.net/assets/` 本地路径，只申请 `INTERNET` 权限，不允许文件/内容访问、明文流量、混合内容、弹窗、定位或外部页面导航，并关闭缩放、滚动条和网络缓存。

Activity 使用 `singleTask`，从电视桌面重新进入应用会恢复原有任务，不会因创建第二个主界面而重置棋局。WebView 在 Activity 进入后台/前台时同步暂停和恢复；如果后台切换发生在 AI 思考期间，当前 Worker 会取消，回到前台后再安全发起搜索。

APK 内已核验包含入口 HTML、样式、主脚本和独立 AI Worker。真机使用 WebView 74 完成人机模式两手棋，证明 Worker 可以从 `WebViewAssetLoader` 正常加载；后台返回测试也保留了当前回合和棋局历史。

Phase 7 的 AI 继续使用迭代加深 Minimax、Alpha-Beta 剪枝、吃子优先排序以及包含子力、兵卒推进和中心控制的局面评估。

排位强度由当前 Profile 的 A0–A7 等级唯一决定：A0 使用本地 D2，A1/A2 使用云端 D3 拟人化候选，A3–A7 分别使用 D4/D5/D7/D9/D11。A1 的候选窗口更宽，A2 更偏向最佳着；遇到杀棋评分时始终选择最佳着。云端不可用时自动回退到本地搜索，但该局不计入排位分。悔棋、中途切换档案、本地双人、过短对局或分析未完成同样不计分。

游戏默认进入人机对战，冷启动时先选择棋手 Profile。操作区提供悔棋、重新开始、对战模式、棋手档案、设置棋谱、局面分析和历史对局。每台设备最多保留 6 个档案，支持名称/头像编辑、切换、重置和软删除。局面分析的快速、标准和深入仍是分析时长档位，不是对局难度。历史对局按当前 Profile 从服务器按需加载，电视端只负责列表、AI 分析摘要及逐手回放。
