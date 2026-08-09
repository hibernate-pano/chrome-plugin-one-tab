# TabStack S1 — 同步骨架加固 + 错误体验（详细 spec）

> **更新日期**：2026-08-05
> **Spec 范围**：Sprint 1 — 同步 + 数据可靠性的护栏
> **父蓝图**：`2026-08-05-tabstack-personal-revamp-blueprint.md`
> **基线版本**：v1.14.0（S2 落地后）
> **状态**：✅ 详细 spec — 待 plan

---

## 0. Summary

S1 在 S2 的 UI/性能工作之上，加固数据可靠性。核心目标：**任何同步/存储/加密失败都有清晰、可恢复的用户路径，且错误有类型、有测试。**

**已完成依赖**：S2 已提供 `storage.hydrateAll()`（单源读取）、`debouncedPersistMiddleware`、`persistGroupsThunk`、`moveTabLocal/moveGroupLocal` 纯 reducer。S1 在其上添加**错误分层 + 加密逃生口 + 离线提示 + 同步状态持久化 + 集成测试**。

---

## 1. 目标 / 非目标

### Goals

1. 五类错误（Sync/Storage/Decrypt/Migration/Network）有类型 + 有测试。
2. 加密失败给出"导出原始 JSON"逃生口（不丢数据）。
3. 离线/网络变化有轻量提示 + 同步重试队列。
4. 同步状态（上次成功时间 / 最近错误）持久化，可显示在 footer（F8 已消费）。
5. syncEngine 集成测试覆盖"回滚 + tombstone 冲突 + envelope 漂移"三种回归。

### Non-goals

- 不重写 syncEngine 核心逻辑（只加错误传播 + 状态记录）。
- 不引入错误监控服务（Sentry 等）。
- 不做多设备冲突 UI（保持 merge 自动解决 + preview 高级模式）。
- 不改 IndexedDB DB 名 / 不动 hydrationDecision / syncMergeSafety。

---

## 2. 五类错误分层

### 2.1 类型定义（`src/utils/errors.ts` 新文件）

```typescript
export type TabStackErrorKind = 'sync' | 'storage' | 'decrypt' | 'migration' | 'network';

export class TabStackError extends Error {
  readonly kind: TabStackErrorKind;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly cause?: unknown;

  constructor(kind: TabStackErrorKind, message: string, opts?: {
    retryable?: boolean;       // 默认 true 除了 decrypt/migration
    userMessage?: string;      // 用户可读文案（zh）
    cause?: unknown;
  }) { ... }
}

// 便捷工厂
export const syncError = (msg: string, opts?) => new TabStackError('sync', msg, opts);
export const storageError = (msg: string, opts?) => new TabStackError('storage', msg, opts);
export const decryptError = (msg: string, opts?) => new TabStackError('decrypt', msg, { retryable: false, ...opts });
export const migrationError = (msg: string, opts?) => new TabStackError('migration', msg, { retryable: false, ...opts });
export const networkError = (msg: string, opts?) => new TabStackError('network', msg, opts);

export function isTabStackError(e: unknown): e is TabStackError;
export function toUserMessage(e: unknown): string;  // 任何 error → 用户可读文案
```

### 2.2 各层抛出位置

| 类型 | 抛出位置 | 用户看到 | retryable |
|---|---|---|---|
| `SyncError` | `syncEngine.downloadAndMerge` / `upload` 的失败路径（已有 throw，包一层） | footer dot 变 rose + SyncTab 错误说明 | true |
| `StorageError` | `storageAdapter` / `indexedDbClient` IO 失败（真错，非空读） | ErrorBoundary + 重试 | true |
| `DecryptError` | `decryptLocalBlob` 失败（key 漂移 / blob 损坏） | 逃生口：导出原始 JSON | false |
| `MigrationError` | `runMigrations` 失败 | "升级失败，旧数据保留" | false |
| `NetworkError` | `supabase` fetch 失败 / `navigator.onLine=false` | 顶部网络条 + footer dot | true |

### 2.3 现有代码改造点

- `src/utils/storage.ts` — `getGroups` 解密失败目前返回 `[]`（外层 catch 吞）——改为 throw `DecryptError`，由调用方决定（hydration 空读逻辑**不变**——hydrationDecision 测试保持绿，只是错误信息有类型）。
- `src/services/syncEngine.ts` — 包一层错误传播，不改变现有回滚逻辑。
- `src/utils/migrationUtils.ts` — `runMigrations` 失败处包 MigrationError。

---

## 3. 加密失败逃生口

### 3.1 背景

`decryptLocalBlob` 失败时（key 漂移——例如 deviceId 变化、加密 envelope 版本变化），`getGroups` 返回 `[]`。用户数据**仍在 IndexedDB**（损坏或加密 blob），但没有 UI 路径取回。

### 3.2 设计

- **设置 → 数据 → "导出原始备份"**：新增 `src/utils/backupUtils.ts`：
  ```typescript
  export async function exportRawBackup(): Promise<Blob | null>
  // 读取 IndexedDB 中原始 GROUPS key 的 blob（不解密），包装成
  // `{ format: 'tabstack-raw', version: 2, exportedAt, blob }` JSON
  // 返回 Blob 供下载（a[download]）
  ```
- 下载文件名：`tabstack-raw-backup-YYYY-MM-DD.json`
- **恢复路径**（后续手动）：用户可在 ImportExportTab 导入该文件——导入时如果 detect 到 `format: 'tabstack-raw'`，则**跳过解密直接写回原始 blob**（这样 key 修复后能读）。这是逃生口，不自动做。

### 3.3 测试

- `tests/backupUtils.test.ts`：构造损坏 blob → `exportRawBackup` 能拿到原始字节；`format` 字段正确；无数据时返回 null。

---

## 4. 离线 / 网络提示

### 4.1 `useNetworkStatus` hook（`src/hooks/useNetworkStatus.ts`）

```typescript
export function useNetworkStatus(): boolean  // 返回 isOnline
// navigator.onLine + online/offline 事件 + 30s 轮询兜底（MV3 SW 可能丢事件）
```

### 4.2 顶部提示条

- 在 `MainApp.tsx` 顶部（Header 上方）渲染 `{!isOnline && <NetworkBanner />}`：
  - 8px 高，琥珀色背景，文案 "离线 — 同步将在网络恢复后自动重试"
  - 只在 `isAuthenticated` 时显示（未登录无需同步提示）
- 网络恢复时：`syncService.downloadAndRefresh(false)` 自动重试一次（防抖 5s）。

### 4.3 测试

- `tests/useNetworkStatus.test.ts`（jsdom）：mock `navigator.onLine` + 触发 online/offline 事件 → hook 值变化。

---

## 5. 同步状态持久化

### 5.1 存储

`storage.ts` 新增：
- `getLastSyncStatus(): Promise<{ lastSyncAt: string | null; lastSyncError: string | null }>`
- `setLastSyncStatus(partial)` — 写 `last_sync_status` key（IndexedDB）

### 5.2 syncEngine 接入

- `syncEngine.upload()` 成功 → `setLastSyncStatus({ lastSyncAt: now })`
- `syncEngine.downloadAndMerge()` 成功 → 同上
- 任一失败 → `setLastSyncStatus({ lastSyncError: toUserMessage(e) })`（**不覆盖 lastSyncAt**——保留上次成功时间）
- 注意：tabSlice 已有 `lastSyncTime` 字段（内存态）——S1 加的是**持久化**版本，popup 重开后仍显示"上次同步 3 小时前"。

### 5.3 UI 消费

- F8 的 footer indicator 读取持久化状态：popup 打开时 `getLastSyncStatus()` → 填充 footer（而不是只在本次会话内有值）。
- SyncTab 显示 lastSyncError 详情（如果有）。

### 5.4 测试

- `tests/syncStatusPersistence.test.ts`（fake-indexeddb）：set → get 往返；失败不覆盖 lastSyncAt；默认值 null/null。

---

## 6. syncEngine 集成测试

### 6.1 约束

AI_HANDOFF §7.5：`mock.module` 与 `_alias-loader.mjs` 不兼容 → 集成测试用**依赖注入**（v1.13.6 syncEngine DI 已经支持 `SyncEngineDeps`——验证并复用）。

### 6.2 测试用例（`tests/syncEngine.integration.test.ts`，fake-indexeddb + 真 syncEngine 实例 + fake storage/deps）

1. **下载失败 → 回滚**：deps.download 抛错 → `downloadAndMerge` 抛 SyncError → 本地数据未被污染（快照恢复）。
2. **tombstone 冲突**：本地删组（isDeleted=true）+ 云端已改该组 → merge 后本地删胜出（tombstone 传播语义）。
3. **envelope 漂移**：云端 blob 是 `ENCRYPTED_V1` 旧格式 + 本地 key 新 → download 失败 → DecryptError（或明确 sync error），不静默吞。
4. **上传失败重试**：deps.upload 抛 NetworkError → upload 抛 retryable error → 不写 lastSyncAt。
5. **成功路径**：正常 upload → lastSyncAt 更新。

---

## 7. 文件清单

**新增**：
- `src/utils/errors.ts` — 错误类 + 工厂 + toUserMessage
- `src/utils/backupUtils.ts` — 原始备份导出
- `src/hooks/useNetworkStatus.ts`
- `src/components/common/NetworkBanner.tsx`
- `tests/errors.test.ts` / `tests/backupUtils.test.ts` / `tests/useNetworkStatus.test.ts` / `tests/syncStatusPersistence.test.ts` / `tests/syncEngine.integration.test.ts`

**修改**：
- `src/utils/storage.ts` — DecryptError throw + lastSyncStatus 持久化 + `getLastSyncStatus/setLastSyncStatus`
- `src/services/syncEngine.ts` — 错误包层 + 状态写入
- `src/utils/migrationUtils.ts` — MigrationError 包层
- `src/components/app/MainApp.tsx` — NetworkBanner + footer 持久化状态读取
- `src/components/settings/ImportExportTab.tsx` — "导出原始备份"按钮
- `src/components/settings/SyncTab.tsx` — lastSyncError 显示
- `src/components/sync/SyncStatusRow.tsx` — 读取持久化状态（如果 F8 footer 也读）

---

## 8. 测试预期

- 新增 ~25 tests（errors 8 / backup 4 / network 3 / persistence 5 / integration 5）
- 基线 281 → **~306**

---

## 9. 验收标准（Done Definition）

| # | 验收 | 方法 |
|---|---|---|
| 1 | 五类错误可区分（kind 字段） | `errors.test.ts` |
| 2 | 加密失败 → 设置里可导出原始备份 | 手动 + backupUtils.test |
| 3 | 离线时顶部提示条 + 恢复自动重试 | 手动断网 + useNetworkStatus.test |
| 4 | footer 显示上次同步时间（跨 popup 重开） | 手动 + syncStatusPersistence.test |
| 5 | syncEngine 集成测试 5 个全绿 | `syncEngine.integration.test.ts` |
| 6 | `pnpm verify` 全绿 ~306 tests | CI |
| 7 | 5 个不变量测试保持绿 | hydrationDecision/syncMergeSafety/storageLayer/syncEngine/tombstone |
| 8 | 无新依赖 | package.json diff 检查 |

---

## 10. Out of Scope

- 自托管 Supabase / 多供应商 OAuth
- 冲突 UI（手动选择保留哪个版本）
- 错误监控 / 遥测
- 加密密钥导出/恢复向导（逃生口只做"原始导出"，不做"解密工具"）
