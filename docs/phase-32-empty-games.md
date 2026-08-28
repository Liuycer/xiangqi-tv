# Phase 32 零手数历史对局修复

## 问题

旧流程在棋盘初始化完成后立即向服务器创建 active 对局。一手未走时执行重新开始、模式切换、棋手切换或退出，会把它保存为零手数 abandoned 对局；如果直接中断应用，还可能留下零手数 active 记录。历史查询没有排除这些数据。

## 修复

- 客户端把 start 请求暂存在内存，第一手棋出现时才按 `start → snapshot/finish` 顺序加入持久化 outbox。
- 第一手前结束本局只清除待开始数据，不发送网络请求。
- 服务端收到零手数 abandoned 终局时删除该记录并返回 HTTP 204。
- 创建新局时删除同一 Profile 被旧客户端遗留的零手数 active 对局。
- 历史总数和分页条目统一使用 `ply_count > 0`，旧的零手数 abandoned 数据不再显示。
- completed 对局必须至少包含一手，零手数伪终局返回 422。

至少走过一手后中途退出的对局仍会保留，能够继续用于历史查看和棋谱回放。

## 自动验证

- 未走子 start + finish 不触发 fetch，也不产生 outbox 项。
- 第一手后 start 排在 snapshot 之前。
- 走过棋再悔回零手时仍发送 finish，由服务端删除已存在的远端记录。
- 零手数 active 对局不会进入历史，并在 abandoned 时从数据库删除。
- 新局替换旧空局时不会留下 abandoned 历史。
- 有一手棋的 abandoned 对局继续保留。
- 前端 14 个文件、91 项测试通过；服务端 37 项测试通过；生产 Web 构建通过。

## 生产验收

- 部署前在线备份：`xiangqi-20260828T075628Z.db.gz`，74,879 bytes。
- 线上原有 48 局中清理 23 条零手数 active/abandoned 记录，保留 25 条有效对局，清理后空记录为 0。
- API 版本 0.4.1；临时空局请求 start 返回 200、finish 返回 204，数据库残留为 0。
- Nginx、API、Pikafish 与数据库备份 timer 均为 active，分析队列 19 completed / 0 failed。
- 使用重置后 Token 构建，APK 内 Token 与 VPS 配置安全比对一致；APK 4,053,411 bytes，SHA-256 `75350300a63012c009a9f662a9a22d84bbc8f34c05e436872337cf8ffdf3f463`。
- APK 已覆盖安装至 MagicBox_M_30_F，冷启动 3198ms，主 Activity 正常前台运行；启动后的 Profile bootstrap 返回 HTTP 200。
