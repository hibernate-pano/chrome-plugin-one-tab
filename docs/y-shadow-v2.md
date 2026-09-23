# V2 影子双写（Yjs + Dexie）

> 状态：影子模式。mutation 落盘成功后异步翻译写入 Y.Doc，**读路径仍走 blob**。
> 主同步零影响：kill-switch 常量、灰度采样、影子全程 try/catch + fire-and-forget。

## 1. 新增依赖与体积

`pnpm add yjs y-indexeddb dexie`（`package.json` dependencies）：

| 包 | 版本 | raw | gzip |
|---|---|---|---|
| yjs | ^13.6.32 | 292.8KB | 61.5KB |
| y-indexeddb | ^9.0.12 | 5.8KB | 1.6KB |
| dexie | ^4.4.6 | 255.5KB | 49.7KB |
| **合计** | | | **112.8KB ≤ 120KB ✅ 通过** |

关键：三包仅经**动态 `import()`** 引入，vite 打成独立异步 chunk
（`yjs-*.js` 23.9KB / `y-indexeddb-*.js` 1.2KB / dexie 进 `import-wrapper-prod` 31.7KB gzip），
主 SW 入口 `service-worker.js` 仅 9.4KB gzip，popup 首屏零增长。
完整报告：`node scripts/report-y-bundle.mjs`（构建后执行）。

## 2. Y-Schema（`src/core/ydoc.ts`，doc 名 `tapstack-y-v2`）

| root | 类型 | key / 内容 |
|---|---|---|
| `groups` | Y.Map | `groupId → YGroupRec{id,name,createdAt,updatedAt,isLocked,is_deleted,version,last_op_device,last_op_seq,notes?,isFavorite?}` |
| `tabs` | Y.Map | `` `${groupId}:${tabId}` → YTabRec{id,groupId,url,title,lastAccessed,is_deleted,last_op_*} ``（查询镜像） |
| `order` | Y.Array | 组 id 序列（快照顺序重建） |

- **MV3 可杀**：`withYDoc()` 短命会话（建 Doc → y-indexeddb 载入 → 单事务应用
  plans → 取 update → 销毁），Doc 不常驻内存；SW 被杀只丢本次影子写。
- **事务幂等**：`plansToDoc()` 单 `transact` + stamp 门控（旧 stamp 跳过），重复应用收敛。
- **WebCrypto 不动**：本期 Y-update 存明文；`cryptoSlot.encryptor` 默认透传，
  V3 E2EE 替换该插槽即可，调用点零改。

## 3. MutationOp → Y 翻译表（`src/core/yTranslate.ts`）

锚定 stamp 不变量（阶段二 §4.3/§5.3：一次 mutation 触及的实体全盖同一 stamp），
翻译**不重实现各 apply\* 分支**，统一收敛为 3 种计划
（`upsertGroup` / `removeGroup` / `setOrder`）：

| MutationOp | 计划推导 |
|---|---|
| saveGroup / removeTab / deleteGroup / deleteAllGroups / restoreGroup | 快照中 `lastOp == 本次 stamp` 的组 → `upsertGroup`（墓碑 `is_deleted` 一并带入；整组清空路径天然覆盖） |
| importGroups / renameGroup / toggleGroupLock / updateGroupFields / moveGroup / moveTab / cleanDuplicates | 同上（源组+目标组同 stamp → 双 upsert；导入组全带 stamp → 全 upsert） |
| purgeGroup | `removeGroup(groupId)`（快照已无该组） |
| 任意 op | 恒附 `setOrder`（快照 id 序列） |

注：仓库真实路径为 `src/shared/mutationProtocol.ts`（`MutationOp`）与
`src/utils|core/mutationOps.ts`（纯函数），翻译函数签名按此对接。

## 4. Dexie 物化视图（`src/core/yMaterialize.ts`，库 `tapstack-y-mv` v1）

- `tab_groups`：`'id, updatedAt, is_deleted'`
- `tabs`：`'id, groupId, updatedAt, is_deleted'`（主键为 `${groupId}:${tabId}`）
- `snapshotToRows()` 纯函数（含 `tabCount`、按 `order` 排序）；`writeMaterializedView()`
  动态 import dexie、`bulkPut` 幂等，indexedDB 不可用 → 内存兜底且永不抛错。

## 5. 同步表（`supabase/migrations/20260924090000_y_sync_tables.sql`）

additive-only、全幂等（`IF NOT EXISTS` + DO 块条件建策略/补列，无 DROP/ALTER COLUMN/DELETE）：

- `sync_updates(doc_id, user_id, seq, base_vector, update, created_at)`，
  主键 `(doc_id, seq)`，索引 `(user_id, doc_id, seq DESC)`，RLS（select/insert，`user_id`）。
- `sync_snapshots(doc_id PK, user_id, snapshot, up_to_seq, updated_at)`，
  索引 `(user_id)`，RLS（select/insert/update，`user_id`）。
- compact 阈值：本地 update 日志 **>500 条或 >256KB** → `needsSnapshot=true`
 （影子本期只打标；snapshot 上传与 updates 裁剪属 V2 同步面）。

## 6. 影子双写接线与开关

- 接线点：`src/background/mutationHandlers.ts` `handle()` ——主写 `ok` 时
  `fire-and-forget` 调用 `deps.shadowWrite({op, stamp, now})`（不 await + 双层吞错）；
  生产绑定见 `src/background/mutationService.ts`（`storage.getGroups` +
  `auth.getCurrentUser` 取 userId + `kvGet/kvSet`）。
- 开关：`src/core/yShadowConfig.ts` —— `SHADOW_WRITE_ENABLED`（kill-switch，默认 true）、
  `SHADOW_ROLLOUT_PERCENT`（默认 **10**，FNV-1a userId 哈希切流）。
- 结果 journallog 化：`y_shadow_log`（FIFO 200，不消耗 seq，区别于主 journal）；
  Y update 进 `y_update_log`（FIFO 500 + 256KB compact 打标）。
