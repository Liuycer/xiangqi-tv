# Phase 29 生产可靠性修复

Phase 29 处理 `NOTES.md` 审查中两项可以独立上线的生产问题：SQLite 自动备份持续失败，以及 Profile 修改、删除相关的 CORS 方法不完整。本阶段不修改客户端界面和 APK。

## SQLite 在线备份

原 systemd 服务把 `/var/lib/xiangqi-api` 整体挂载为只读。虽然备份只读取主数据库，但 SQLite WAL 模式仍可能需要创建或访问 `-shm` 共享内存文件，因此每日任务在 `source.backup()` 阶段报 `unable to open database file`。

修复后：

- 使用 URI `mode=ro` 打开在线数据库，并启用 `PRAGMA query_only`；
- 通过 SQLite online backup API 创建一致性快照，不直接复制变化中的 WAL 文件；
- gzip 压缩后先恢复到临时数据库，并执行 `PRAGMA quick_check`；
- 只有恢复和完整性校验成功后才把压缩包发布到备份目录；
- systemd 仅放行数据库目录中 SQLite WAL 辅助文件所需的写权限，主数据库连接仍由代码保持只读。

生产验收于 2026-08-28 完成：`xiangqi-database-backup.service` 返回 `Result=success`，生成 `xiangqi-20260828T061554Z.db.gz`（74879 bytes）。压缩包恢复后 `quick_check=ok`，在线数据库与备份数据库都包含 48 局对局。

## CORS 与限流

FastAPI 的 CORS 方法现包含 `GET / POST / PUT / PATCH / DELETE / OPTIONS`，使 Profile 改名和软删除可以通过 WebView 预检。

Nginx 使用请求方法映射生成限流键，OPTIONS 使用空键，因此预检不消耗 30 次/分钟的业务限额。新共享区命名为 `xiangqi_api_v2`，避免变更限流键时与旧工作进程中的同名共享区冲突。Nginx 自己生成的 429 会通过专用位置返回 JSON，并显式附加应用 Origin、`Vary: Origin` 和既有安全响应头。

生产突发验收结果：

- PATCH 和 DELETE 预检均返回 200；
- `Access-Control-Allow-Methods` 包含 PATCH、DELETE 和 OPTIONS；
- 同一回环 IP 触发 429 后，OPTIONS 仍返回 200；
- 429 返回 `application/json`，并包含 `Access-Control-Allow-Origin: https://appassets.androidplatform.net`。

## 自动测试与部署状态

- 新增 3 项备份测试：只读源拒绝写入、WAL 快照可恢复、损坏压缩包会被拒绝；
- 新增 CORS 方法配置测试；
- 服务端 28 项单元测试全部通过；
- `nginx -t` 通过，Nginx 热重载成功；
- `xiangqi-engine-api.service` 与 Nginx 正常，`/health` 返回 Pikafish、schema v5 和零失败分析任务。
