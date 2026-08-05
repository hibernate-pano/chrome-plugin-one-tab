# TabStack S1 — 同步骨架加固 + 错误体验（outline）

> **更新日期**：2026-08-05
> **Spec 范围**：Sprint 1 — 同步 + 数据可靠性的护栏
> **父蓝图**：`2026-08-05-tabstack-personal-revamp-blueprint.md`
> **状态**：⏸ Outline — 待 S2 落地后写详细 spec
> **S2 落地所需信息**：见 §3 与本文件详情节

---

## 0. 目的

在 S2 动 UI 之前，**先把数据可靠性的护栏再厚一点**。避免 S2 改 storage / syncEngine 时踩坏 syncMergeSafety / hydrationDecision 防线。

---

## 1. 关键改动（preview）

### 1.1 五类错误统一

| 类型 | 抛出位置 | 用户看到 | 内部动作 |
|---|---|---|---|
| `SyncError` | syncEngine.* 入口 | "同步失败，X 分钟后重试" + Toast | 已有的 restoreSnapshot 回滚 |
| `StorageError` | storageAdapter / storage.ts IO 路径 | ErrorBoundary + 重试按钮 | 不写缓存，下次重试 |
| `DecryptError` | decryptLocalBlob | "无法解密本地数据" + 导出原 JSON 逃生口 | 不清空，提供 retry-with-passphrase |
| `MigrationError` | runMigrations | "升级失败，旧数据保留" 提示 | 不删旧数据；半迁移状态保存到 backup key |
| `NetworkError` | supabase fetch | 顶部网络提示条 + sync status = error | autoSyncMiddleware 队列重试 |

### 1.2 加密失败逃生口

```ts
// src/utils/encryptionUtils.ts 加：
export async function decryptWithPassphrase(blob: string, passphrase: string): Promise<TabGroup[]>
// 导出 JSON 选项（在 ImportExportTab 中暴露）
export async function exportRawBackupJson(): Promise<string>
```

### 1.3 syncEngine 集成测试

- **现有 25 个单元测试保留**（tests/syncEngine.test.ts）
- **新增集成测试**（tests/syncEngine.integration.test.ts）：
  - 测试"download 失败 → 回滚" 路径
  - 测试"tombstone 冲突：本地删 + 云端改" 时序
  - 测试"加密 envelope 漂移"（假设人工把 ENCRYPTED_V2 改成 V3_OLD）

> **关键约束**：AI_HANDOFF §7.5 — `mock.module` 与自定义 TS loader 不兼容。集成测试用 fake-indexeddb + 真实 syncEngine 实例，但通过测试用例传入 fake storage client。

### 1.4 离线 / 网络状态

- `src/hooks/useNetworkStatus.ts` — `navigator.onLine` + 30s polling
- 顶部 8px 提示条："离线 — 同步将在恢复后自动重试"

### 1.5 storage.hydrateAll 单源化（**与 S2-3 共用**）

> 重要：**这次只在 S1 落地**，S2 复用该 API。
>
> 这意味着 S1 的 PR 与 S2 的 PR 会互相依赖，**S1 必须先合并**。
>
> 或：S1 + S2 都改这部分时，**一起提交**避免半截状态。

---

## 2. 不动

- mergeTabGroups / validateMergeResult / hydrationDecision 三个核心纯函数（已有测试钉死）
- IndexedDB DB 名 = `tabvaultpro`
- syncEngine 类结构（仅内部加 throws + 错误信息）
- 已有 5 个不变量测试
- Service Worker 不加回同步逻辑

---

## 3. 验收（详细 spec 待写）

| # | 验收 |
|---|---|
| 1 | 5 类错误统一抛出，全调用点改完无回归 |
| 2 | `storage.hydrateAll` 是 storage 层唯一对外接口；其他路径迁移完 |
| 3 | syncEngine 集成测试新增 ≥ 8，全绿 |
| 4 | 加密失败逃生口手工验证脚本（`scripts/verify-decrypt-fallback.mjs`） |
| 5 | `pnpm verify` 全绿 |
| 6 | 5 个不变量测试保持绿 |

---

## 4. 何时开始

**先 S2 落地，再回头写 S1 详细 spec**。因为：

- S1 复用的 `storage.hydrateAll` 与 S2 共写，不分先后会冲突
- S2 的 UI 简化让 SyncStatusRow 出现时，S1 的网络状态才有承接载体

---

## 5. S1 详细 spec 何时写

S2-3（bootstrap 单源化）与 S1-5（storage.hydrateAll）共用代码。预计 S2 进入 P1 阶段后，把 S1 详细 spec 同步开始写，在 P1 完成时一起提交。
