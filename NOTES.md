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
| `docs/` | Phase 10–33 各阶段设计/测试/部署报告（Phase 1–9 无独立文档，信息在 README） |
| `scripts/` | 构建与设备部署脚本 |

## 当前状态（2026-08-28）

- Phase 25–28 已完成：Profile 为核心的排位模式（A0–A7、1050 分起步，每设备最多 6 档案），客户端已移除手动难度
- Phase 29 已完成并部署：生产备份修复，CORS PATCH/DELETE/OPTIONS 补全，OPTIONS 限流豁免，429 CORS JSON 响应
- Phase 30 已完成：outbox 永久 4xx 按对局隔离，可重试错误继续保留，坏队头不再阻塞后续对局
- Phase 31 已完成并部署：强制设备/Profile 归属校验、非等长循环长将裁定、分析 worker 异常自恢复、遥控器禁用态守卫
- Phase 32 已完成并部署：第一手前不创建远端对局，零手数放弃直接删除，历史过滤旧空记录
- Phase 33 已完成并安装：设置只保留音效/动画，返回按钮去掉“关闭”，水平重置只在棋手档案中提供
- 测试全绿：前端 91 项、服务端 37 项
- Phase 29–31 已提交并推送至 `codex/phase-29-31-hardening`（`bc9b50b`）；Phase 32 尚未提交
- 注意：环境要求较新（Node 26、pnpm 11）；`web/dist` 与 `node_modules` 有本地构建产物

## 工作约定（为控制上下文占用）

1. 大范围搜索/调研交给子代理，只取结论
2. 不整读大文件，先 grep 定位再读片段
3. 有产出的任务完成后更新本文件的「进度日志」
4. 用户侧：阶段结束后手动 `/compact`，换任务开新会话

## 进度日志

- 2026-08-28：建立本备忘文件；子代理完成项目现状调查（即上文「当前状态」）。
- 2026-08-28：5 路子代理并行 bug 审查完成（规则引擎/AI与历史同步/UI输入/服务端/协议+Android）。确认严重 2 个：① CORS allow_methods 缺 PATCH/DELETE（main.py:1210，档案改名/删除必失败）；② 同步 outbox 队头 4xx 永久死锁（game-sync-client.ts:490-527）。中等级别包括：档案归属校验可绕过（deviceId 省略即跳过）、三次重复裁定要求等间距周期、备份服务 ReadOnlyPaths 必然失败、分析 worker claim 异常永久死亡、遥控 OK 绕过禁用态。Android 壳与本地规则引擎核心未见问题；「humanize/depth 矛盾」经人工复核为误报已剔除。
- 2026-08-28：Phase 29 完成并部署。修复 SQLite WAL 在线备份：源库使用 `mode=ro + query_only`，压缩包发布前执行恢复与 `quick_check`，systemd 放行 WAL `-shm` 辅助文件；FastAPI 补齐 PATCH/DELETE/OPTIONS，Nginx 使用 `xiangqi_api_v2` 让 OPTIONS 绕过限流并为 429 返回带 CORS 的 JSON。生产备份 `xiangqi-20260828T061554Z.db.gz` 校验通过，在线库与备份均为 48 局；API/Pikafish 正常，服务端 28 项测试通过。
- 2026-08-28：Phase 30 完成并通过真机验收。outbox 将不可恢复 4xx 对应的整局待传操作移入 `xiangqi-tv-game-outbox-failed-v1` 隔离区，失败请求保留实际状态码、同局依赖项标记 424；401/403、408、425、429、5xx 和网络故障继续等待重试。盒子实测 `/games` 于 14:44:07 返回 422，坏局被隔离；14:44:12 后续 `/move` 返回 200，符合 4.2 秒节流。测试前数据已恢复，临时 WebView 调试入口已撤销。最终 APK 4053368 bytes、SHA-256 `28402d2da4e23f1ba7841c430203371abb3caa4cc9e387502ccbe69057ba8dc2`，已覆盖安装并正常前台启动；前端 86 项测试通过。
- 2026-08-28：Phase 31 完成并部署。所有 Profile 所属读写接口强制携带并核验 `deviceId + playerId`；重复裁定按当前局面最近三次出现之间的完整窗口判断单方连续将军，不再要求两段路径等长；赛后分析 worker 可从领取任务和失败状态写入异常中恢复；遥控器确认键遵守分析中及功能禁用状态。前端 88 项、服务端 33 项测试全绿。生产验收结果：缺失 deviceId=422、错误归属=404、正确归属=200；API、Pikafish、Nginx 与备份定时器正常。最终 APK 4053317 bytes、SHA-256 `07edf6129765f14e924ab04433ff0e268797dca098817c4609f259a9c86e27ee`，已覆盖安装，冷启动 2410ms。
- 2026-08-28：Phase 32 修复零手数空对局并完成生产部署。`GameSyncClient` 将远端 start 延迟到第一手棋；未走子结束时丢弃内存中的待开局数据。服务端对零手数 abandoned 返回 204 并删除记录，新对局会清理同 Profile 的旧 active 空局，历史分页统一限定 `ply_count > 0`；完成态零手数请求返回 422。至少一手的 abandoned 对局仍保留。前端 91 项、服务端 37 项测试及生产 Web 构建通过。上线前生成备份 `xiangqi-20260828T075628Z.db.gz`，随后删除 23 条空记录，保留 25 条有效对局；生产临时局验收 start=200、finish=204、remaining=0。API 0.4.1 与全部服务健康。重置后 Token 已安全嵌入最终 APK（4053411 bytes，SHA-256 `75350300a63012c009a9f662a9a22d84bbc8f34c05e436872337cf8ffdf3f463`），Token 一致性校验通过，盒子覆盖安装后冷启动 3198ms，Profile bootstrap 返回 200。
- 2026-08-28：Phase 33 精简“设置与棋谱”。设置区删除重置水平，只保留落子音效和走子动画；返回对局按钮不再显示右侧“关闭”。重置水平继续保留在棋手档案详情中。遥控器设置焦点上限从 3 改为 2，对应音效、动画、返回三项；前端 91 项测试与生产构建通过。使用 VPS 当前 Token 构建的 APK 4053280 bytes、SHA-256 `26d6da36b0d4c551000a14874821588074f6a850c4c0b1b40d51436611c0e710`，Token 一致性校验通过，已覆盖安装并冷启动 3489ms。真机设置面板视觉验收确认三个控件正确、无重置入口且“返回对局”右侧无文字。
