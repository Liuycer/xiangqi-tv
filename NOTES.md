# 项目进度备忘

> 用途：跨会话接续上下文。compact 或开新会话后，读这个文件即可恢复工作状态。
> 每次做完一个有产出的任务，在「进度日志」追加一条；约定变化也记在这里。

## 项目概览

面向天猫魔盒 Q8 电视盒子的中国象棋游戏。棋盘、规则与本地回退 AI 跑在盒子上；排位自适应、Pikafish 走棋、局面分析、历史与复盘由云端 VPS 完成。

- **前端**：Vue 3 + TypeScript + Vite + Vitest（pnpm），`web/`
- **Android**：Kotlin WebView 薄壳（Gradle，minSdk 23 / target 36），`android/`
- **服务端**：FastAPI + SQLite WAL + Pikafish/NNUE + Nginx + systemd，`server/`

## 常用命令

- Web：`pnpm --dir web install` / `dev` / `test`（Vitest）/ `build`（vue-tsc + vite build）
- 服务端：uvicorn 跑 `app.main:app`，监听 `127.0.0.1:8000`；测试在 `server/tests/`
- Android：`scripts/build-android.sh`、`deploy-debug.sh`、`verify-apk.sh`（ADB 到 192.168.3.11:5555）

## 目录速览

| 目录 | 内容 |
| --- | --- |
| `web/src/` | ai（引擎/Worker/远程客户端）、components、game、input、history、experience 等模块 |
| `android/` | Kotlin WebView 壳 |
| `server/` | FastAPI 应用、Pikafish 封装、nginx/systemd 配置、tests |
| `docs/` | Phase 10–41 各阶段设计/测试/部署报告（Phase 1–9 无独立文档，信息在 README） |
| `scripts/` | 构建与设备部署脚本 |

## 当前状态（2026-08-30）

- Phase 25–28 已完成：Profile 为核心的排位模式（A0–A7、1050 分起步，每设备最多 6 档案），客户端已移除手动难度
- Phase 29 已完成并部署：生产备份修复，CORS PATCH/DELETE/OPTIONS 补全，OPTIONS 限流豁免，429 CORS JSON 响应
- Phase 30 已完成：outbox 永久 4xx 按对局隔离，可重试错误继续保留，坏队头不再阻塞后续对局
- Phase 31 已完成并部署：强制设备/Profile 归属校验、非等长循环长将裁定、分析 worker 异常自恢复、遥控器禁用态守卫
- Phase 32 已完成并部署：第一手前不创建远端对局，零手数放弃直接删除，历史过滤旧空记录
- Phase 33 已完成并安装：设置只保留音效/动画，返回按钮去掉“关闭”，水平重置只在棋手档案中提供
- Phase 34 已完成并部署：服务端独立重放并校验棋谱、行棋方和终局一致性，生产合法/非法请求验收通过
- Phase 35 已完成并部署：同步失败管理 UI、一次性 Profile 恢复码和跨设备档案转移，真机软键盘适配通过
- Phase 36 已完成并部署：按中规 2020 增加长杀、长捉和混合攻击性循环的确定性裁定，生产与真机验收通过
- Phase 37 已完成并安装：历史列表支持每页 20 局继续加载，鼠标与遥控器均可访问全部记录；遥控快速导航只请求最终停留对局的详情
- Phase 38–40 已完成并安装：有效未完成对局可从历史续玩，schema v7 revision 防止并发覆盖；鼠标和遥控器均已完成真实历史续局验收
- Phase 41 已完成并安装：玩家胜利播放轻量烟花与庆祝音，人机 AI 获胜仅播放低调结束音；盒子性能与清理验收通过
- 测试全绿：前端 105 项、服务端 63 项，Android lint 通过
- Phase 29–35 已通过 PR #5～#8 合并至 GitHub `main`
- 注意：环境要求较新（Node 26、pnpm 11）；`web/dist` 与 `node_modules` 有本地构建产物

## 工作约定（为控制上下文占用）

1. 大范围搜索/调研交给子代理，只取结论
2. 不整读大文件，先 grep 定位再读片段
3. 有产出的任务完成后更新本文件的「进度日志」
4. 用户侧：阶段结束后手动 `/compact`，换任务开新会话

## 进度日志

- 2026-08-30：提交 PR #11（Phase 38–40 续局与 Phase 41 烟花）后清理工作区：本地 main fast-forward 至 `d18431e`，README 进度行更新为 Phase 25–41，删除 6 个已合并本地分支（`agent/cloud-ai-vps-migration`、`codex/docs-phase-25-28-readme`、`codex/fix-history-client-stability`、`codex/phase-14-18-analysis`、`codex/phase-37-history-pagination`、`codex/phase-38-40-resumable-games`）；远端旧 feature 分支保留未动。
- 2026-08-28：建立本备忘文件；子代理完成项目现状调查（即上文「当前状态」）。
- 2026-08-28：5 路子代理并行 bug 审查完成（规则引擎/AI与历史同步/UI输入/服务端/协议+Android）。确认严重 2 个：① CORS allow_methods 缺 PATCH/DELETE（main.py:1210，档案改名/删除必失败）；② 同步 outbox 队头 4xx 永久死锁（game-sync-client.ts:490-527）。中等级别包括：档案归属校验可绕过（deviceId 省略即跳过）、三次重复裁定要求等间距周期、备份服务 ReadOnlyPaths 必然失败、分析 worker claim 异常永久死亡、遥控 OK 绕过禁用态。Android 壳与本地规则引擎核心未见问题；「humanize/depth 矛盾」经人工复核为误报已剔除。
- 2026-08-28：Phase 29 完成并部署。修复 SQLite WAL 在线备份：源库使用 `mode=ro + query_only`，压缩包发布前执行恢复与 `quick_check`，systemd 放行 WAL `-shm` 辅助文件；FastAPI 补齐 PATCH/DELETE/OPTIONS，Nginx 使用 `xiangqi_api_v2` 让 OPTIONS 绕过限流并为 429 返回带 CORS 的 JSON。生产备份 `xiangqi-20260828T061554Z.db.gz` 校验通过，在线库与备份均为 48 局；API/Pikafish 正常，服务端 28 项测试通过。
- 2026-08-28：Phase 30 完成并通过真机验收。outbox 将不可恢复 4xx 对应的整局待传操作移入 `xiangqi-tv-game-outbox-failed-v1` 隔离区，失败请求保留实际状态码、同局依赖项标记 424；401/403、408、425、429、5xx 和网络故障继续等待重试。盒子实测 `/games` 于 14:44:07 返回 422，坏局被隔离；14:44:12 后续 `/move` 返回 200，符合 4.2 秒节流。测试前数据已恢复，临时 WebView 调试入口已撤销。最终 APK 4053368 bytes、SHA-256 `28402d2da4e23f1ba7841c430203371abb3caa4cc9e387502ccbe69057ba8dc2`，已覆盖安装并正常前台启动；前端 86 项测试通过。
- 2026-08-28：Phase 31 完成并部署。所有 Profile 所属读写接口强制携带并核验 `deviceId + playerId`；重复裁定按当前局面最近三次出现之间的完整窗口判断单方连续将军，不再要求两段路径等长；赛后分析 worker 可从领取任务和失败状态写入异常中恢复；遥控器确认键遵守分析中及功能禁用状态。前端 88 项、服务端 33 项测试全绿。生产验收结果：缺失 deviceId=422、错误归属=404、正确归属=200；API、Pikafish、Nginx 与备份定时器正常。最终 APK 4053317 bytes、SHA-256 `07edf6129765f14e924ab04433ff0e268797dca098817c4609f259a9c86e27ee`，已覆盖安装，冷启动 2410ms。
- 2026-08-28：Phase 32 修复零手数空对局并完成生产部署。`GameSyncClient` 将远端 start 延迟到第一手棋；未走子结束时丢弃内存中的待开局数据。服务端对零手数 abandoned 返回 204 并删除记录，新对局会清理同 Profile 的旧 active 空局，历史分页统一限定 `ply_count > 0`；完成态零手数请求返回 422。至少一手的 abandoned 对局仍保留。前端 91 项、服务端 37 项测试及生产 Web 构建通过。上线前生成备份 `xiangqi-20260828T075628Z.db.gz`，随后删除 23 条空记录，保留 25 条有效对局；生产临时局验收 start=200、finish=204、remaining=0。API 0.4.1 与全部服务健康。重置后 Token 已安全嵌入最终 APK（4053411 bytes，SHA-256 `75350300a63012c009a9f662a9a22d84bbc8f34c05e436872337cf8ffdf3f463`），Token 一致性校验通过，盒子覆盖安装后冷启动 3198ms，Profile bootstrap 返回 200。
- 2026-08-28：Phase 33 精简“设置与棋谱”。设置区删除重置水平，只保留落子音效和走子动画；返回对局按钮不再显示右侧“关闭”。重置水平继续保留在棋手档案详情中。遥控器设置焦点上限从 3 改为 2，对应音效、动画、返回三项；前端 91 项测试与生产构建通过。使用 VPS 当前 Token 构建的 APK 4053280 bytes、SHA-256 `26d6da36b0d4c551000a14874821588074f6a850c4c0b1b40d51436611c0e710`，Token 一致性校验通过，已覆盖安装并冷启动 3489ms。真机设置面板视觉验收确认三个控件正确、无重置入口且“返回对局”右侧无文字。
- 2026-08-28：Phase 32–33 已以提交 `87e4ef8` 经 PR #6 合并至 GitHub `main`，合并提交为 `34fb9fe`。Phase 34 完成并部署：新增服务端独立中国象棋规则模块，对 AI/分析请求及历史快照从初始 FEN 逐手重放，校验全部棋子走法、阻挡、九宫/河界、自陷将军、将帅照面、重复与长将；completed 结果必须与真实终局一致。服务端测试从 37 项增至 56 项并全部通过，API 升级为 0.5.0。上线前备份 `xiangqi-20260828T113953Z.db.gz`（71,383 bytes）；生产合法快照=200、非法走法=422、伪造终局=422、合法放弃=200，验收数据残留 0，SQLite quick_check=ok，API/Nginx active，三份生产代码哈希与本地一致。
- 2026-08-29：Phase 35 完成并部署。永久 4xx 隔离记录按 gameId 汇总，在历史面板提供同步异常入口、逐局删除和清空诊断；设置面板仍只保留音效/动画。Profile 使用 80-bit 一次性恢复码，服务端仅存带域分隔的 SHA-256 摘要；跨设备恢复原子转移档案并销毁旧码。API 0.6.0 / schema v6 生产验收：生成=200、错误码=404、恢复=200、复用=404、摘要存储确认、残留=0、quick_check=ok；上线前备份 `xiangqi-20260828T115315Z.db.gz`（71,426 bytes）。前端 93 项、服务端 60 项通过。浏览器 1080P/720P 与真机档案页验收通过；首次真机发现软键盘遮挡输入框，改为顶部安全区定位后复验完整可见。最终 APK 4,055,611 bytes、SHA-256 `332e5158211755669e24192a1b63edc406b45e02368d7843c861061b8fa10f6a`，令牌一致，已覆盖安装且无崩溃日志。
- 2026-08-29：Phase 36 采用中国象棋协会《象棋竞赛规则（2020版）》第 23～26 条作为循环裁定基准。前后端在第三次重复时独立标注将、杀、捉、闲，支持长将、长杀、长捉及三种混合禁止着法；帅将/兵卒自身长捉、未过河兵卒、正常有根兑子按允许着法处理。对规则中依赖裁判解释的深层交换采用“可证明才判罚”的保守边界，避免误判负。前端 94 项、服务端 61 项通过，真实 UCI 长捉循环在两端均判责任方负。生产 API 已升级至 0.7.0；上线前备份 `xiangqi-20260829T004020Z.db.gz`（71,515 bytes），线上长捉验收正确判红方责任、伪造和棋被拒绝，服务健康。最终 APK 4,056,813 bytes、SHA-256 `cf9ded19ed0dfdbb0dfec35c3dbd0782667eea0270bce8e91631ff83a7c054a4`，令牌一致，已覆盖安装且无 AndroidRuntime/WebView 错误。
- 2026-08-29：Phase 37 修复历史分页。客户端以服务端 `total/offset` 为准每次继续读取 20 局，按 ID 去重且保持顺序；列表末尾新增鼠标和遥控器均可操作的加载入口，遥控焦点自动滚动。快速方向键导航改为 300ms 稳定后只读取最终条目详情，避免触发 Nginx 429。生产 Profile 25 局实测可完整显示，第 21～25 局与回放正常；最终日志只有一次第二页请求和一次详情请求，均为 200。前端 95 项、服务端 61 项、Web 构建及 Android lint 全部通过。最终 APK 4,057,542 bytes、SHA-256 `023a70fa6b15700d7f241f4f71f65202fd6acd2637d4e32d51b89e506b8f84ac`，已覆盖安装，设备端哈希一致且无 AndroidRuntime/WebView 错误。
- 2026-08-30：Phase 38–40 实现未完成对局续玩。服务端 API 0.8.0 / schema v7 增加 revision、续局次数和时间，续局重放棋谱并拒绝终局、空局、已评级或已分析记录；旧 revision 写入返回 409，重复续局幂等。客户端历史详情支持鼠标/遥控器续局，恢复棋盘、棋谱、回合、开局种子及冻结的自适应 AI 参数。最终回归为前端 100 项、服务端 63 项、Web 构建和 Android Lint 全绿。上线前备份 `xiangqi-20260830T121801Z.db.gz`（91,342 bytes），生产续局闭环及清理通过，SQLite quick_check=ok。真机鼠标恢复 172 手 A3 D4 对局、遥控器跨页恢复 4 手旧 D3 对局均成功；验收中修复旧记录缺少 adaptiveLevel 导致 A3 D3 的组合错误，现按深度恢复为 A2 D3。完成态按钮改为“再来一局 / 以当前设置开新局”。最终 APK 4,058,809 bytes、SHA-256 `4532f03b13be779efafc1d8683d2ffeb87db54ed08192be04fdab28edb9188fe`，已覆盖安装且设备端哈希一致，无 AndroidRuntime/WebView 或服务端 warning。
- 2026-08-30：Phase 41 完成胜局烟花。终局策略明确区分人机红胜、AI 黑胜、本地双人胜方和和棋；玩家胜利使用 2.5 秒 Canvas 烟花与五音符庆祝音，AI 获胜只播放双音符低调结束音。真机从 1080P/30fps/112 粒子的 117%～150% CPU 优化为 720P/24fps/96 粒子的约 85%～121%，结束后回到 0% 附近；播放 PSS 约 120MB，稳定约 108MB。动画关闭、页面切换、重新开始、后台和销毁均会清理。前端 105 项、Android 测试/lint、APK 签名与资源校验通过。最终 APK 4,060,417 bytes、SHA-256 `03c6eb387be83e8978a3477e5389a1f08bd6dca88e90e444f10526272fb6b681`，设备端一致并已覆盖安装，无自动预览或崩溃日志。
