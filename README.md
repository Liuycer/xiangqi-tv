# 中国象棋 TV

面向天猫魔盒 Q8 畅越版的离线中国象棋电视游戏。项目采用 Vue 3 + TypeScript 实现界面、规则与 AI，并由一个尽可能薄的 Kotlin WebView 壳打包为 Android APK。

当前进度：Phase 12 体验优化。已加入轻量合成音效、可关闭走子动画、简明棋谱以及鼠标/遥控器设置面板，并完成天猫魔盒真机布局与流程验证。

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
- 本地内容：`WebViewAssetLoader`
- 包管理器：pnpm

WebView 通过 `https://appassets.androidplatform.net/assets/index.html` 加载 APK 内资源，不使用 `file:///android_asset/`。Android 壳不声明网络权限，不开放 JavaScript Bridge，并关闭 WebView 文件访问。

## 项目结构

```text
xiangqi-tv/
├── android/        Android WebView 壳
├── web/            Vue 3 应用
├── scripts/        构建和设备辅助脚本
└── README.md
```

游戏代码按以下边界组织：

```text
UI → InputController → GameController → RuleEngine / GameState / AIEngine
```

规则层不会依赖 Vue、DOM 或 Android。

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
./scripts/build-android.sh
```

APK 输出位置：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

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
- 操作区使用方向键在悔棋、重新开始、对战模式、AI 难度之间移动，确认键执行
- “设置与棋谱”位于操作区最后一项；面板内使用方向键切换、OK 修改、BACK 返回
- 操作区按 BACK：返回棋盘
- BACK：优先取消选择；没有选择时退出应用

鼠标和遥控器共用 `InputController → GameController`，切换输入模式不会重置棋局。黄色方框表示遥控焦点，青色方框表示已选棋子，绿色实心点表示普通落点，绿色圆环表示吃子目标，蓝色与橙色分别表示上一步起点和终点，红色框表示当前被将军的将/帅。

## 当前状态

Phase 12 已完成体验优化。应用使用 Web Audio API 实时合成选棋、落子、吃子、将军和胜利五类短音，不携带音频资源。棋子采用 150ms 轻量走子动画；音效和动画都能在“设置与棋谱”面板独立关闭，并保存在本机 WebView 存储中。

每一步现在会生成简明象棋记谱，红方使用中文数字、黑方使用阿拉伯数字；悔棋和重新开始会同步更新棋谱。设置弹层及五项主操作已通过 WebView 74 真机遥控器验证，稳定空闲 Total PSS 为 99747KB。最终 APK 为 1371037 bytes，45 项自动测试全部通过。

Phase 13 已完成 AI 强化。搜索加入置换表、PV/杀手/历史走法排序、MVV-LVA 吃子排序、静态搜索和阶段化位置评估；棋盘查询使用 90 格缓存，将军受攻判断改为车炮射线、马腿和过河兵的直接检测。困难档真机达到 D3 / 10656 节点 / 3208ms，大师档达到 D4 / 19264 节点 / 7030ms。

Phase 11 已完成基础性能优化。AI 叶子节点不再重复生成合法走法，截止时间改为逐节点检查，并复用根走法；当时困难档从 Phase 10 的 D2 / 512 节点提升至 D3 / 2316 节点，同时耗时从 4329ms 降至 2805ms。

棋盘的 90 个交叉点和 32 枚棋子使用视觉状态缓存与增量更新，合法落点改为坐标 Map 查询，遥控器移动不再刷新未改变的棋局快照。AI Worker 在一回合结束且没有待处理任务时释放，使真机单回合 PSS 增量从约 10.7MB 降到约 6.7MB。最终候选 APK 为 1368784 bytes，40 项自动测试全部通过。

Phase 10 已完成目标盒子真机性能测试。三次有效冷启动平均为 1801ms；稳定空闲 Total PSS 为 101814KB，困难 AI 完成后为 112729KB。鼠标、遥控器、1080P 应用画布、4K HDMI 缩放、中文字体和 WebView 74 离线 Worker 均已验证。

AI 性能数据显示在对局信息栏中。Phase 10 发现的三档超时问题已经在 Phase 11 修复；原始基线和测试边界仍保留在 `docs/phase-10-device-test.md`。

Phase 9 已完成可重复的 APK 构建、校验和真机部署流程。`build-android.sh` 会在构建后自动调用 `verify-apk.sh`；`deploy-debug.sh` 会继续完成 ADB 覆盖安装、冷启动、进程存活和前台 Activity 检查。针对厂商应用商店偶发抢占前台的情况，部署与诊断脚本只接受实际进入象棋主界面的结果，并进行有限重试。当前 Debug APK 不包含原生库、不申请 Android 权限，包含全部离线游戏资源，并通过 v1/v2 签名验证。

Phase 8 已完成 Android WebView 集成审计与加固。应用仅允许导航到 `https://appassets.androidplatform.net/assets/` 本地路径，不申请任何 Android 权限，不允许文件/内容访问、明文流量、混合内容、弹窗、定位或外部页面导航，并关闭缩放、滚动条和网络缓存。

Activity 使用 `singleTask`，从电视桌面重新进入应用会恢复原有任务，不会因创建第二个主界面而重置棋局。WebView 在 Activity 进入后台/前台时同步暂停和恢复；如果后台切换发生在 AI 思考期间，当前 Worker 会取消，回到前台后再安全发起搜索。

APK 内已核验包含入口 HTML、样式、主脚本和独立 AI Worker。真机使用 WebView 74 完成人机模式两手棋，证明 Worker 可以从 `WebViewAssetLoader` 正常加载；后台返回测试也保留了当前回合和棋局历史。

Phase 7 的 AI 继续使用迭代加深 Minimax、Alpha-Beta 剪枝、吃子优先排序以及包含子力、兵卒推进和中心控制的局面评估。

难度上限与单次思考预算：简单始终使用本地 D2 / 350ms，普通使用 D3，困难使用 D5；自定义可在云端选择 D3–D20，默认 D5。普通、困难和自定义优先使用云端，云端不可用时自动回退到本地搜索；自定义本地回退最高使用 D5，避免电视盒子长时间满载。这里的深度是搜索上限；界面会显示实际完成深度。时间耗尽时使用最后完整搜索深度的结果；即使第一层未完成也会返回预先排序的合法应手。人机模式悔棋会撤回 AI 与玩家各一手，让玩家重新选择。完整规则仍由独立 `RuleEngine` 负责。

游戏默认进入人机对战。操作区提供悔棋、重新开始、对战模式、AI 难度、自定义深度和设置棋谱。AI 难度可在简单、普通、困难和自定义之间循环；自定义深度使用不会溢出屏幕的居中 6×3 选单一次展示 D3–D20，支持鼠标直接点击，同时保留遥控器方向键操作。切换本地双人/人机模式会开始一盘新棋。Android 壳已声明鼠标/非触摸设备可用，并同时提供普通 Launcher 与 Leanback Launcher 入口。
