import type { TabGroup } from '@/types/tab';
import { ensureBackendPrimed, getActiveSyncBackend } from '@/sync-backend';
import type { RemoteGroupFingerprint } from '@/sync-backend';
import type { GroupDigestLike } from '@/core/syncDecision';

/**
 * 透传层：调用方（SyncEngine / SyncButton）与「当前生效的同步后端」之间的唯一接缝。
 *
 * ── 2026-10-13 改造（WebDAV 自带存储 · 阶段 0）──────────────────────────
 * 改造前：本文件用 `let activeSyncPort: SupabaseSyncPort = supabaseSync` 直接绑死
 * 实现，并用 `setSyncPort()` 预留替换点。但 **setSyncPort 是全仓零调用**
 * （2026-10-13 全仓检索复核）——那条「未来多实现」的接缝从未接上，
 * Supabase 之外没有任何东西真的走过它。
 *
 * 现在：后端解析统一交给 `@/sync-backend`（默认仍解析为 Supabase，
 * **行为零变化**）。WebDAV 适配器接入后，只要在 sync-backend 里改解析结果，
 * 本文件与全部调用方一行都不用动 —— 这才是这条接缝本来该有的样子。
 *
 * ── 对外函数签名刻意逐字保留 ────────────────────────────────────────────
 * 调用方（SyncEngine 5 个 + SyncButton 1 个 + 测试）依赖这些名字与返回形状。
 * 例如 `uploadTabGroups` 的返回值仍带 `writtenTombstoneIds` ——
 * 那不是 Supabase 泄漏，而是 syncEngine 用来避免「同一 id 被二次写墓碑」的
 * 必要信息（见 syncEngine.upload 内该字段的完整论证），改名会波及那段逻辑。
 */
/**
 * 探活指纹的对外形状 = `GroupDigestLike`（snake_case）。
 *
 * ── 为什么对外用 snake_case，而端口内部用 camelCase ────────────────────
 * 消费方 `syncDecision.hasRemoteChanges()` 的全部判据都建立在
 * `updated_at` / `is_deleted` / `last_op_seq` 这些字段名上，且那段逻辑
 * 被 2026-10-10 缺陷 1 的完整论证与多个测试钉住（digestTombstoneProbe 等）。
 * 为了「统一命名」去改它会波及探活语义 + 测试，收益为零、风险非零。
 *
 * 反过来，端口内部必须用后端无关的命名（`updatedAt` / `etag`），
 * 否则 WebDAV 适配器被迫伪装成 Supabase 列名 —— 那正是这次改造要消灭的东西。
 *
 * 因此映射发生在本文件（接缝处），两侧各自保持自己的语言。
 */
export type TabGroupDigest = GroupDigestLike;

/** 端口指纹（camelCase）→ 探活消费方形状（snake_case）。 */
function toDigestLike(f: RemoteGroupFingerprint): GroupDigestLike {
  return {
    id: f.id,
    updated_at: f.updatedAt,
    // version 原样透传（Supabase 独有）。**不要**用 etag 顶替：
    // 见 ports.ts 里 RemoteGroupFingerprint.version 的完整论证。
    version: f.version,
    is_deleted: f.isDeleted ?? undefined,
    last_op_device: f.lastOp?.d ?? undefined,
    last_op_seq: f.lastOp?.s ?? undefined,
  };
}

export async function uploadTabGroups(
  groups: TabGroup[],
  overwriteCloud: boolean = false
): Promise<{ writtenTombstoneIds: string[] }> {
  // 每个上下文（SW / popup / options）首次调用时补一次解析：
  // SW 启动时的 prime 管不到 popup，popup 里第一次点同步若直接读缓存，
  // 拿到的是「未预解析 fail-safe 的 Supabase」，用户配的 WebDAV 被无声绕过。
  // 已有缓存时零开销（不重建适配器、不重跑 PBKDF2）。
  await ensureBackendPrimed();
  const result = await getActiveSyncBackend().uploadGroups(groups, {
    overwriteRemote: overwriteCloud,
  });
  // 契约映射：SyncBackendPort.uploadGroups 的 `writtenIds` → 调用方熟悉的
  // `writtenTombstoneIds`。Supabase 适配器只报告真实写上的墓碑 id
  // （覆盖模式才可能非空），不做扩大解释 —— 见 supabaseAdapter 文件头。
  return { writtenTombstoneIds: result.writtenIds };
}

export async function downloadTabGroups(): Promise<TabGroup[]> {
  await ensureBackendPrimed();
  return getActiveSyncBackend().downloadGroups();
}

export async function markCloudGroupsAsDeleted(deletedIds: string[]): Promise<void> {
  await ensureBackendPrimed();
  return getActiveSyncBackend().broadcastDeletes(deletedIds);
}

/** 物理删除超过龄期的删除广播载体（Supabase 侧 = is_deleted 行），返回删除行数。 */
export async function purgeExpiredCloudTombstones(maxAgeDays: number = 30): Promise<number> {
  await ensureBackendPrimed();
  return getActiveSyncBackend().purgeExpiredDeletes(maxAgeDays);
}

/** 轻量探活：只拉 (id, updated_at, version, is_deleted[, 印记列]) 指纹，无大字段。 */
export async function downloadTabGroupsDigest(): Promise<TabGroupDigest[]> {
  await ensureBackendPrimed();
  const fingerprints = await getActiveSyncBackend().fetchFingerprints();
  return fingerprints.map(toDigestLike);
}
