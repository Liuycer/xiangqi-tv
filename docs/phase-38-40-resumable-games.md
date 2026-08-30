# Phase 38–40 未完成对局续玩

## 目标

历史对局中的有效未完成棋局可以从服务器恢复，并在电视盒子上继续下棋。客户端仍只负责交互和棋盘展示；服务器保存完整棋谱、生命周期版本和续局次数，并对并发写入进行保护。

## Phase 38：服务端生命周期

SQLite schema 升级到 v7，`games` 表新增：

- `revision`：生命周期版本。续局或被其他棋局取代时递增；
- `resume_count`：成功续局次数；
- `last_resumed_at`：最近一次续局时间。

新增 `POST /v1/xiangqi/games/{game_id}/resume`。请求必须同时携带所属 `deviceId`、`playerId` 和列表读取到的 `expectedRevision`。服务端会再次从 `initialFen` 重放全部 UCI 棋谱，拒绝非法棋谱、已经形成终局的棋谱和归属不匹配的请求。

允许续玩的记录必须满足：

- 状态为 `active` 或 `abandoned`；
- 至少已经走过一手；
- 尚未生成评级事件或赛后分析任务；
- 棋谱重放后仍为非终局。

续局成功后，服务器将同一 Profile 的其他进行中对局标记为被续局取代，目标棋局重新变为 `active`，清除旧的放弃结果并将 revision 加一。重复发送同一个续局请求会返回同一结果，不会重复增加 `resume_count`。

快照和终局接口也会校验 revision。旧页面、延迟 outbox 或重复客户端使用过期 revision 写入时返回 HTTP 409，防止覆盖已经恢复的棋局。

## Phase 39：电视客户端

历史详情中的有效未完成对局会显示“继续这盘对局”。支持：

- 鼠标点击按钮；
- 遥控器上下键移动焦点，确认键开始续局；
- 续局前重放并验证完整历史棋谱；
- 当前棋局已有走子时先提示，再保存当前快照；
- 等待本地 outbox 清空后才请求续局；
- 恢复棋盘、当前行棋方、上一步、棋谱、重复局面历史和 AI 回合；
- 恢复该局开局时冻结的自适应等级、深度、拟人化策略和开局随机种子。

如果恢复后轮到黑方，客户端会自动继续请求对应等级的 AI。续局失败时历史面板保持打开，并显示可操作的错误信息，不会清空当前棋盘。

客户端当前只恢复标准初始局面。服务端数据模型仍保留 `initialFen`，以后需要支持残局开局时可以继续扩展。

## Phase 40：回归与生产验收

全量自动回归结果：

| 范围 | 结果 |
| --- | --- |
| Web Vitest | 15 个文件、100 项测试通过 |
| Web 类型检查与生产构建 | 通过 |
| 服务端 unittest | 63 项测试通过 |
| Android Lint | 通过 |
| APK 完整性、权限、资源和签名 | 通过 |

生产部署前在线备份：

```text
/var/backups/xiangqi-api/xiangqi-20260830T121801Z.db.gz
91,342 bytes
```

旧后端代码保存在：

```text
/opt/xiangqi-api/rollback-phase38-40-20260830T1218Z
```

生产环境已升级到 API 0.8.0 / schema v7。部署后：

- FastAPI、Pikafish 和 Nginx 正常；
- SQLite `PRAGMA quick_check = ok`；
- 三个迁移列均存在；
- 线上后端文件 SHA-256 与本地一致；
- Uvicorn 与 Pikafish 各只有一个正常父子进程，无孤儿引擎。

生产 API 使用独立临时 Profile 和两步合法棋局完成闭环验收：

```text
start=200
snapshot=200
abandon=200
resume=200
idempotent retry=200
stale revision=409
fresh revision=200
```

验收后临时棋局和临时 Profile 均清理为 0，未污染真实历史。

最终 Debug APK：

```text
android/app/build/outputs/apk/debug/app-debug.apk
4,058,809 bytes
SHA-256 4532f03b13be779efafc1d8683d2ffeb87db54ed08192be04fdab28edb9188fe
```

APK 只申请 `android.permission.INTERNET`，包含 HTML、JavaScript、CSS、本地 AI Worker 和固定服务端 CA，v1/v2 签名有效。

最终 APK 已覆盖安装到 `192.168.3.11:5555`，设备端 SHA-256 与本地完全一致，应用进程和 `MainActivity` 保持前台，未发现 AndroidRuntime、WebView 崩溃或服务端 warning。

真机使用真实历史完成两条操作路径：

- 鼠标：选择一盘 172 手未完成对局，点击“继续这盘对局”，返回主界面后棋盘、红方回合、A3 D4 和 172 手棋谱全部恢复；
- 遥控器：方向键跨两页导航到一盘 4 手未完成对局，焦点进入续局按钮，OK 打开保存当前棋局提示，再用系统“确定”完成恢复；主界面显示遥控器模式、红方回合和 4 手棋谱。

真机验收还发现旧固定难度记录没有 `adaptiveLevel` 时会错误组合当前等级与旧深度，例如显示为不合法的 A3 D3。最终版本会按历史深度推导最接近的自适应等级；旧“普通 D3”现稳定恢复为 A2 D3。新增 3 项测试覆盖完整冻结参数、旧 D3 推导及完全缺失数据的回退路径。

完成态操作文案也已优化：对局中继续显示“重新开始 / 恢复初始棋局”，形成终局后自动改为“再来一局 / 以当前设置开新局”，功能仍使用相同的新局生命周期。
