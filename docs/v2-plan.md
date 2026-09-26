# TapStack V2 执行计划（唯一指导源）

> 版本：v1.0 / 日期：2026-09-26 / 负责人决策已锁定 / 基线：`v1.21.0`
> 与 `docs/rebuild-plan.md` 的关系：rebuild-plan 是方向文档，本文是可执行计划。本文与之冲突处以本文为准。
> 原则：绞杀式演进，每期独立可发版；Spec-First，先验收标准后实现；不搞大爆炸重写；UI 交互冻结。

## 1. 决策锁定（Jasper 已拍板，不再讨论）

| # | 决策 | 结论 | 对计划的影响 |
|---|---|---|---|
| D1 | 恢复码 UX | 优先级低，有时间再做 | E2EE 只做到“接口预留 + 明文现状”，不做恢复码 / 二维码递送 / KEK 流程，相关工作全部移入 V2-Backlog |
| D2 | 外部实时共编 | 非刚需 | 否决 y-websocket 自建、Workers DO、托管同步服务。同步管道唯一方案：Supabase 上自建 Y-Update log（HTTPS 拉取 + Broadcast 只发通知）。`sync.ts` 保留传输抽象但不实现第二种传输 |
| D3 | 墓碑云端保留 | 最多 7 天 | 所有墓碑（组级 / tab 级）自 `deletedAt` 起 7 天后物理清除；客户端与服务端各做一道清理，互为兜底。删除语义对外承诺为“7 天内可恢复，7 天后彻底消失” |

非目标（V2 不做）：UI 改版、交互改动、共编 presence / 光标、多设备 E2EE 完整闭环、恢复码 UX、自建 websocket 运维、Automatmerge 替换 Yjs。

## 2. 基线现状（v1.21.0，从哪出发）

- 同步模型：整组 JSONB 快照 + `opStamp` 全序决胜 + DB 触发器守卫（严格 `<`）+ 墓碑 `is_deleted` 防复活。
- 本地写路径已收口：UI → `sendMutation` → SW 侧 `mutationHandlers`（journal→stamp→apply→setGroups→scheduleUpload），唯一同步入口 `syncEngine`。见 `src/store/slices/tabSlice.ts` 头注释。
- V2 影子已上线：`mutationHandlers.handle()` 主写成功后 fire-and-forget 调 `shadowWrite`，经 `plansToDoc` 写 Y.Doc（`tapstack-y-v2`），物化视图写 Dexie（`tapstack-y-mv`），日志进 `y_shadow_log` / `y_update_log`。灰度开关在 `src/core/yShadowConfig.ts`。
- 同步表已建（additive-only）：`sync_updates(doc_id,user_id,seq,base_vector,update,created_at)`、`sync_snapshots(doc_id,user_id,snapshot,up_to_seq,updated_at)`，见 `supabase/migrations/20260924090000_y_sync_tables.sql`。
- 已知债：`tabSlice.ts(943行)`、`upload.ts(864行)`、`storage.ts(792行)`、`SyncButton.tsx(682行)` 四个上帝文件；`upload.ts` 内 79 处 `console.*`；`syncUtils.legacy.ts(439行)` 未下线；目录 `core/services/utils/supabase/storage-kv` 职责交叉。

## 3. 目标架构（V2 完成态）

```
popup / Web（只读本地 Dexie 视图，瞬间响应）
   │ MutationOp（UI→core 命令层，语义不变）
   ▼
core（Y.Doc 真相源 + Dexie 物化视图，唯一语义实现）
   │ Y-Update 增量（明文，V2 不加密；cryptoSlot.encryptor 透传预留）
   ▼
Supabase（sync_updates append-only + sync_snapshots compact + 墓碑 7 天清理）
   ▲ Broadcast 只发“有新 seq”通知，拉取走 HTTPS
SW（无状态搬运工，可随时被杀，无常驻状态）
```

关键不变式：

1. UI 永远只读本地，不等待网络；无网络时全功能可用（除跨端同步）。
2. 并发在数学上可合并，不再有输家；`opStamp` 退化为 Y 事务内的排序提示，不再是仲裁者。
3. 删除 = Y DeleteSet + 墓碑行，7 天后物理清除；清除前恢复 = 普通 upsert。
4. SW 可杀：`withYDoc()` 短命会话（建 Doc → y-indexeddb 载入 → 单事务应用 → 取 update → 销毁），Doc 不常驻内存。
5. 双端语义只有一份：Web 与扩展共用 `src/core`（搬运层除外），统计、过滤、墓碑判定不允许各写一份。

## 4. 数据模型（V2 冻结）

### 4.1 Y-Schema（`src/core/ydoc.ts`，doc 名 `tapstack-y-v2`）

- `groups: Y.Map`：`groupId → {id,name,createdAt,updatedAt,isLocked,is_deleted,deletedAt?,version,last_op_device,last_op_seq,notes?,isFavorite?}`
- `tabs: Y.Map`：`` `${groupId}:${tabId}` → {id,groupId,url,title,lastAccessed,is_deleted,deletedAt?,last_op_*} ``
- `order: Y.Array<string>`：组 id 序列，快照顺序重建。
- 新增字段只有 `deletedAt`（毫秒时间戳，删除时刻；恢复时清空）。其余字段冻结，V2 不加字段。

### 4.2 Dexie 物化视图（`src/core/yMaterialize.ts`，库 `tapstack-y-mv`）

- `tab_groups('id, updatedAt, is_deleted')`、`tabs('id, groupId, updatedAt, is_deleted')`，主键 tabs 为 `` `${groupId}:${tabId}` ``。
- `snapshotToRows()` 保持纯函数；`writeMaterializedView()` 幂等 `bulkPut`；indexedDB 不可用 → 内存兜底且永不抛错（fail-closed 反向：读失败不准降级成零个组清空列表，见 66ed9fc 教训）。

### 4.3 服务端表

沿用 `20260924090000` 两表，V2 新增一次 additive-only 迁移（见 §6 P2）：

- `sync_updates` 加 `tombstone_expires_at timestamptz NULL`（仅墓碑 update 携带，普通 update 为 NULL；用于服务端兜底清理与审计，不参与同步语义）。
- 不加 DELETE 触发器、不改 RLS 主体（仍按 `user_id` 隔离，`(select auth.uid())` 口径）。
- `sync_snapshots` 语义不变：`up_to_seq` 覆盖 updates 前缀；compact 阈值：log > 500 条或 > 256KB → `needsSnapshot=true`（客户端常量，见 `src/core/yShadowConfig.ts`）。

## 5. 墓碑 7 天生命周期（D3 落地细则）

> 🟡 客户端地基完成（2026-09-26）：`TabGroup/Tab/TabData/SupabaseTabGroup` 加 `deletedAt/deleted_at`；
> `mutationOps` 7 处墓碑盖戳 + 2 处恢复清空；tabSlice 5 处乐观墓碑盖戳；
> codec 往返；Y recs + 翻译携带；`probe.supportsDeletedAt`（PGRST204 口径）；
> `markCloudGroupsAsDeleted` 双分支带 `deleted_at`（缺列省略，对端回退 updatedAt）；
> download 回填；新建 `src/core/tombstone.ts`（7 天常量 + sweep 纯函数）+ `tests/tombstone.test.ts`（12 用例）；
> audit 纳入 deletedAt 比对；服务端 additive 迁移 `20260926090000_tombstone_expiry.sql`（迁移脚本 dry-run 已识别）；
> 定时清理为 `supabase/manual/tombstone_expiry_cron.sql` 手动步骤（启用需负责人三确认，不自动执行）。
> ⏳ 待 P2：sweep 执行接线（需经单写者 sweepExpired op）+ cron 启用确认。

### 5.1 定义

- 墓碑 = `is_deleted=true` 且带 `deletedAt` 的组 / tab 行（含 Y 侧 DeleteSet 与 Dexie 行与云端 `tabs_data` 行，三处一致）。
- `deletedAt` 由执行删除的 mutation 的 `now` 产生（`mutationHandlers` 侧唯一时钟源），随 Y-Update 传播，不允许各端用本地 `Date.now()` 重写。
- `expiresAt = deletedAt + 7×24h`。对外文案统一为“删除后 7 天内可在回收站恢复，7 天后彻底删除”。

### 5.2 状态机

```
活跃 →(deleteGroup/removeTab/deleteAllGroups)→ 墓碑（is_deleted=true, deletedAt=T）
墓碑 →(restoreGroup，expiresAt 之前)→ 活跃（is_deleted=false，deletedAt 清空，lastOp 推进）
墓碑 →(purgeGroup，回收站手动彻底删除)→ 物理移除（Y removeGroup + Dexie 删除行 + 云端行删除）
墓碑 →(expiresAt 到达，无需用户动作)→ 物理移除（同 purge，但由清理任务触发）
```

- `purgeGroup` 仅回收站场景可用；普通列表删除永远只进墓碑，不物理删。
- 恢复窗口内同步语义：恢复是一个普通 upsert（新 stamp / 新 Y 事务），天然赢过墓碑；不需要“复活保护”特殊分支。

### 5.3 清理（双保险，互为兜底）

- 客户端清理（主）：`storage` 侧每日一次（复用现有 `getDeletedGroups` 过期过滤位置，`src/utils/storage.ts:357` 附近），删除 `expiresAt < now` 的本地墓碑行 + Y 侧 `removeGroup` + Dexie 删行；清理动作本身走正常 mutation（带 stamp），从而传播到云端。SW 启动时也跑一次（防 popup 长期不打开）。
- 服务端清理（兜底）：`pg_cron` 每日一次（若实例无 pg_cron 则用 Supabase Scheduled Job / Vercel Cron 二选一，V2 只选一种），物理删除 `tombstone_expires_at < now()` 的 `sync_updates` 墓碑 update 前缀已并入 snapshot 的部分；绝不直接删未被 snapshot 覆盖的 log 前缀（防新设备恢复断链）。
- 可观测：清理计数进现有 journal（`y_shadow_log` 同口径 FIFO），`SyncButton` 显示“已彻底清理 N 个过期删除”仅记日志不弹成功提示（延续 1b684ee Unix 哲学：成功静默）。

### 5.4 验收（墓碑专项）

- T1：A 端删组，B 端 7 天内同步后组进回收站可恢复；恢复后两端一致。
- T2：`deletedAt` 伪造旧时间戳的写入被丢弃（以 mutation 时钟为准，不信任客户端直写）。
- T3：过期墓碑在客户端清理后，云端 24h 内收敛（snapshot 覆盖后 updates 前缀可裁）。
- T4：`purgeGroup` 后新设备全量拉取不复活（DeleteSet 路径覆盖，见现有 `overwriteTombstone*` 用例延续）。

## 6. 分期计划（每期独立可发版）

### P0 手术：上帝文件拆分 + 日志收口 + legacy 冻结（0.5–1 周）

> ✅ 已完成（2026-09-26，负责人执行）：
> - `upload.ts` 864行→会话收口 `session.requireSessionUserId` + 日志收口 `@/utils/log`；新建 `src/utils/supabase/session.ts`、`src/utils/log.ts`（logInfo 仅 DEV 输出）
> - 全仓 50 文件 339 处 `console.*` 收口；eslint 新增 `no-console` + `no-restricted-imports(syncUtils.legacy)` 双门禁
> - 测试 infra 根因修复：`--import tests/_register-loader.mjs` 全局预装 loader；loader stub 改注入式（旧跨线程 globalThis 永为 undefined）；`log.ts` import.meta 安全访问
> - `tabSlice.ts` 943→883行（纯函数抽 `tabSliceHelpers.ts`）；`SyncButton.tsx` 682→590行（展示层抽 `syncPreviewView.tsx`）；legacy 头加 P3 删除日期
> - 验证：type-check ✓ / lint ✓ / 334 单测 ✓ / vite build ✓；体积门见 y-bundle 报告（Y 增量仍 ≤120KB）

- 目标：为 V2 腾出手，不改同步语义，纯结构。
- 改动：
  - `upload.ts` 按“会话鉴权 / 上传 / 探活重试”拆三模块，`console.*` 全部收口到 `src/utils/errorHandler.ts`，加 eslint `no-console`（production error/warn 除外白名单）。
  - `tabSlice.ts` 只留 Redux 纯状态，同步副作用搬 `syncEngine`；`SyncButton.tsx` 拆展示与调度。
  - `syncUtils.legacy.ts` 标记 `@deprecated 冻结`，禁止新引用（eslint `no-restricted-imports`），删除日期定 V2-P3。
- 验收：`type-check + lint + 334 用例` 全绿；包体积不增；无行为变更（e2e 回归全过）。
- 回滚：纯重命名与搬运，直接 revert。

### P1 影子转正：Y.Doc 升为主真相源候选（1–2 周）

> 🟡 代码完成（2026-09-26）：新建 `src/core/yAudit.ts`（纯函数对账 + 5% 采样执行器，
> 结果进 `y_audit_log` FIFO 50），`mutationService.shadowWrite` 后链式触发（同 fire-and-forget、
> 同吞错，返回类型不变）；`yShadowConfig` 新增 `AUDIT_SAMPLE_PERCENT/Y_AUDIT_LOG_KEY/AUDIT_LOG_MAX`；
> 新增 `tests/yAudit.test.ts`（10 用例，采样 key 实测钉死）。
> ⏳ 待时间窗口：对账差异率 <0.1% 持续 7 天（需线上流量沉淀，会话内无法完成）。
> 灰度说明：代码 `SHADOW_ROLLOUT_PERCENT` 实际已是 100（开发全量），与旧文档 10% 不一致，以代码为准。

- 目标：线上小流量验证 Y 路径与快照路径长期一致。
- 改动：`SHADOW_ROLLOUT_PERCENT` 从 10 → 50 → 100 阶梯；影子写失败不影响主写（维持 fire-and-forget + 双层吞错）；加一致性对账 job（抽样比对 Y 物化视图 vs `storage.getGroups`，差异记日志不自动修）。
- 验收：对账差异率 < 0.1% 持续 7 天；`withYDoc` 增量捕获、物化视图删行、连接必关（70685e1/977bcc9 回归用例）全绿；体积门 ≤120KB。
- 回滚：kill-switch `SHADOW_WRITE_ENABLED=false` 一键关。

### P2 日志管道：云端切到 sync_updates/sync_snapshots（2–3 周，风险最高，单独发版）

- 目标：同步从传快照变传操作；触发器仲裁下线。
- 改动：
  - 新迁移 `supabase/migrations/2026xxxxxx_tombstone_expiry.sql`（additive-only：只加 `tombstone_expires_at` 列 + pg_cron job + 索引；无 DROP/ALTER COLUMN/DELETE）。
  - SW 实现推拉：push（`encodeStateAsUpdate` diff → insert `sync_updates`）/ pull（按 `seq` 增量拉 → apply → 更新 Dexie 视图）；Broadcast 只收“有新 seq”通知。
  - `opStamp` 退化为 Y 事务排序提示；DB 触发器改为透传（先置旁路再下线，分两版）。
  - 存量迁移：首次启动把本地快照一次性转 Y.Doc 并 push 一条 snapshot（复用 `snapshotToRows` + `plansToDoc`）。
- 验收：双端并发编辑（A 改名 + B 删 tab）无输家；断网 24h 后上线自动收敛；流量对比（同操作 egress 下降一个数量级）；T1–T4 墓碑用例全绿；e2e `no-resurrect` 系列全过。
- 回滚：保留快照读路径一版；出问题切回快照下载合并且停 push（开关 + 发版）。

### P3 瘦身下线：删 legacy 与快照代偿（1 周）

- 目标：代码量净减少，语义只剩一份。
- 改动：删 `syncUtils.legacy.ts`、`mergeTabGroupsLegacy`、digest 探活、防抖落盘、pending 标志、双驱动调度中已失效的分支；`storage.ts` 收敛为 Dexie 视图薄封装；文档 `rebuild-plan.md` 状态更新为“V2 完成”。
- 验收：`grep -rn legacy/mergeTabGroupsLegacy/digest探活` 零命中（除 CHANGELOG）；测试数不减（删代码不删用例，迁移到 Y 路径）；包体积下降。
- 回滚：此期不设回滚，只设 fast-forward 修复（因 P2 已稳定一周才可进 P3）。

### P4 打磨（Polish，0.5 周）

- 边缘：IndexedDB 不可用、SW 被杀中途、Supabase 限流、超大组（>1000 tabs）的分页与虚拟列表。
- 体验：保持成功静默、失败可解释（InlineNotice + journal 可查）；删除 7 天文案在回收站、设置页、Web 仪表盘三处一致。
- 门：Lighthouse / popup 打开 <300ms（M2 机器）；多设备一致性 e2e 全绿。

## 7. 测试策略（每期门禁）

- 单元（`node --test` 现状延续）：Y 翻译表、物化视图、墓碑状态机、expires 计算、cryptoSlot 透传。
- 回归（必跑）：`overwriteTombstone*`、`storageFailClosed`、`syncMergeSafety`、`yShadow`、`ydocDelta`、`reviveHardening`。
- 新增：T1–T4 墓碑 7 天（用虚拟时钟，不真等 7 天）；P2 双端并发无输家；断网重连收敛。
- e2e（`scripts/run-e2e.mjs`）：`no-resurrect` 系列 + 新增“过期墓碑不复活”。
- 体积门：`scripts/report-y-bundle.mjs`，新增依赖 gzip >120KB 告警阻断发布。

## 8. 文件清单（预计触及）

- 核心：`src/core/ydoc.ts`、`src/core/yTranslate.ts`、`src/core/yMaterialize.ts`、`src/core/yShadow.ts`、`src/core/yShadowConfig.ts`、`src/core/mutationOps.ts`、`src/core/webTombstone.ts`。
- 后台：`src/background/mutationHandlers.ts`、`src/background/mutationService.ts`、`src/services/syncEngine.ts`。
- 存储：`src/storage-kv/*`、`src/utils/storage.ts`（收敛为薄封装）、`src/utils/supabase/upload.ts`（拆分）、`src/utils/supabase/download.ts`、`src/utils/supabase/sync.ts`（传输抽象保留）。
- 状态机：`src/store/slices/tabSlice.ts`（纯化）、`src/components/sync/SyncButton.tsx`（拆分）。
- 迁移：`supabase/migrations/2026xxxxxx_tombstone_expiry.sql`（新建，additive-only）。
- 删除：`src/utils/syncUtils.legacy.ts`（P3）。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| P2 触发器下线导致老客户端写丢失 | 触发器先旁路一版再下线；老版本 popup 提示强制升级 |
| Y DeleteSet 膨胀 | compact 阈值（500条/256KB）+ snapshot 覆盖后裁 updates 前缀 |
| 墓碑时钟漂移 | `deletedAt` 以执行端 mutation 时钟为准，服务端只做 `expiresAt` 兜底，不仲裁 |
| pg_cron 不可用 | 降级 Vercel Cron 调服务端清理接口，V2 只保留一种，写死在迁移文档 |
| 体积超门 | Yjs 维持 13.x，禁 Automerge；超门先拆 `PerformanceTest` 等非核心 chunk |

## 10. V2-Backlog（明确不进 V2）

- D1 恢复码 UX：KEK=Argon2id、DEK 多设备递送（恢复码/二维码）、密钥丢失不可恢复提示链路。待 V2 稳定后再立项。
- 实时 presence / 共编光标：D2 已否决，如未来成刚需再重议传输方案。
- 墓碑保留时长可配置（当前写死 7 天，服务端与客户端同常量，不做 per-user 配置）。

## 11. 里程碑与发版

- M0（P0 完成）：`v1.21.x` 补丁版，零行为变更。
- M1（P1 完成）：`v1.22.0`，Y 对账全绿，灰度 100%。
- M2（P2 完成）：`v2.0.0`，日志管道上线，触发器旁路。
- M3（P3+P4 完成）：`v2.1.0`，legacy 下线，触发器删除，文档封版。

---

附：决策原文（Jasper 2026-09-26）→ D1 恢复码低优先级；D2 实时共编非刚需；D3 墓碑最多 7 天。本文已按此锁定，不再收集新需求，进码。
