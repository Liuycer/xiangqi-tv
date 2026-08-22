# Phase 24 校准、监控与备份

Phase 24 为自适应难度补齐可校准参数、运行观测、数据库版本和自动备份。所有新参数均有与 Phase 22 相同的默认值，升级不会突然改变用户难度。

## 可校准参数

| 环境变量 | 默认值 | 含义 |
|---|---:|---|
| `XIANGQI_ADAPTIVE_MINIMUM_PLIES` | 10 | 少于该手数的对局不参与评级 |
| `XIANGQI_ADAPTIVE_PROVISIONAL_GAMES` | 10 | 前多少盘使用新用户 K 值 |
| `XIANGQI_ADAPTIVE_PROVISIONAL_K` | 40 | 新用户评级变化速度 |
| `XIANGQI_ADAPTIVE_ESTABLISHED_K` | 24 | 稳定用户评级变化速度 |
| `XIANGQI_ADAPTIVE_ADJUSTMENT_INTERVAL` | 3 | 至少累计多少盘才允许调一级 |
| `XIANGQI_ADAPTIVE_ROLLING_WINDOW` | 5 | 升降级胜率观察窗口 |
| `XIANGQI_ADAPTIVE_PROMOTE_SCORE` | 0.65 | 升级最低滚动得分率 |
| `XIANGQI_ADAPTIVE_DEMOTE_SCORE` | 0.35 | 降级最高滚动得分率 |
| `XIANGQI_ADAPTIVE_INITIAL_RATING` | 1200 | 新用户和重置后的初始分 |
| `XIANGQI_ADAPTIVE_INITIAL_LEVEL` | 2 | 新用户和重置后的 A 等级 |
| `XIANGQI_REVIEW_GOOD_MAX_CP` | 30 | “好棋”损失上界 |
| `XIANGQI_REVIEW_INACCURACY_MAX_CP` | 80 | “不精确”损失上界 |
| `XIANGQI_REVIEW_MISTAKE_MAX_CP` | 200 | “失误”损失上界，以上为漏着 |

建议先积累至少 30 盘有效对局再调参数，每次只改一组阈值并观察一周。紧急回退可以设置 `XIANGQI_ADAPTIVE_SHADOW_MODE=1`，继续计算推荐值但停止把它用于自动难度。

## 指标

受 Bearer Token 保护的 `GET /v1/xiangqi/metrics` 返回：

- API 请求数、错误数、正在处理数及按操作分类的平均耗时；
- Pikafish 运行、占用和交互请求等待状态；
- 赛后分析队列的 queued / running / completed / failed 数量；
- SQLite schema 版本、占用字节、玩家、对局、分析着法和评级事件数量；
- 当前生效的自适应与复盘分类参数。

单用户 2C2G 建议关注：分析队列连续一小时不下降、`failed > 0`、数据库持续异常增长、API 5xx 增加。如果只在完成对局后短暂出现一个 queued / running，属于正常行为。

## 备份

`xiangqi-database-backup.timer` 每天北京时间 04:15 左右调用 SQLite 在线备份 API，输出 gzip 文件到 `/var/backups/xiangqi-api`，默认保留 14 天。备份期间不需要停止服务，且不会直接复制可能仍在变化的 WAL 文件。

可选环境变量：

```dotenv
XIANGQI_BACKUP_DIRECTORY=/var/backups/xiangqi-api
XIANGQI_BACKUP_RETENTION_DAYS=14
# rclone 配置完成后可启用，例如 Cloudflare R2：
# XIANGQI_BACKUP_RCLONE_REMOTE=r2:xiangqi-tv/backups
```

当前数据是结构化文字，通常每盘只有几十 KB，2GB 系统盘剩余空间可以保存大量个人对局。R2 更适合作为异地备份，不适合作为在线 SQLite 主库；只有当本地备份增长、需要跨机器灾备时再启用即可。

恢复时先停止 API，保留当前数据库及 WAL 副本，解压选定的 `.db.gz` 到新的文件，执行 `PRAGMA integrity_check` 后再原子替换。恢复属于破坏性操作，不由定时任务自动执行。

## 冒烟验收

- schema v4 初始化以及自定义策略读取通过；
- 指标统计能读取临时数据库的玩家、对局和文件占用；
- 在线备份脚本能产生可打开、通过 `integrity_check` 的 gzip 数据库；
- 服务端 Python 文件语法检查通过。

## 生产部署验收（2026-08-22）

- `112.74.108.214` 上 API、Nginx 和备份 timer 均为 active，公网 IP HTTPS `/health` 返回 schema v4 和 Pikafish 正常状态。
- 正式环境完成隔离测试玩家的创建、快照、结束、历史、自适应档案和指标接口冒烟；分析队列无失败任务。
- 首次在线备份已写入 `/var/backups/xiangqi-api`，timer 下一次运行时间已登记。
- APK 通过压缩包、v1/v2 签名、权限和内置资源检查后覆盖安装到 `MagicBox_M_30_F`。
- 真机 1920×1080 应用画布完整显示历史列表、只读棋盘和回放区；鼠标打开/关闭和遥控器上下切换均成功。
- 真机显示自适应 `A2 D3` 与评级 `1200 · A2`，证明客户端显示与服务端档案对齐。
- 强制停止后创建新局，旧活动对局自动变为“未完成”，只保留最新一盘“进行中”。

最终 Debug APK SHA-256：`d92b6a5e1009eb596d56afcbce3f5fb23d10137ba121b391e19bbcfebe0e3ed4`。
