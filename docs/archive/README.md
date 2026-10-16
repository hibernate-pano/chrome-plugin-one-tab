# docs/archive —— 历史归档（不代表当前产品行为）

本目录保存 2026-10-16「云端后端下线、扩展收敛为 WebDAV-only」之前的规划、审计与验证文档。
它们如实记录了当时的决策过程，但其中不少内容描述的是**已删除**的能力：

- Supabase 托管云端、登录 / 注册 / 账户体系（已整体删除）
- 云端行上的 `is_deleted` 墓碑与 30 天 TTL（已换成 WebDAV 墓碑分片）
- `supabase/migrations/*`、`pnpm test:supabase-smoke` 等已删除的脚本与迁移

请勿按本目录的文档实现或宣传功能。当前同步设计以 `../webdav-selfhost-sync-plan.md`
与 `../../src/sync-backend/` 为准；发版台账在 `../RELEASE-NOTES.md`。

`tests/docsAlignment.test.ts` 仍在守卫其中几份计划的**作废声明**（v2-plan / dev-plan-2026-09-27 /
y-shadow-v2）——归档不是删除：历史必须保持可检索，同时不能误导读者。
