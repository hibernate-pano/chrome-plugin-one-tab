import type { DownloadSkippedGroup, TabGroup } from '@/types/tab';
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
  overwriteCloud: boolean = false,
  // 2026-10-18 P1#4：本次上传是否属于「用户已确认归属的首次全量」。
  // 默认 false = 不认定 —— 认定是危险的默认值：WebDAV 适配器在远端还没有
  // manifest 时会全量上传，而保存新会话触发的自动上传也会走到这里，
  // 于是用户的归属决策被绕过。设置页三选一的那一次显式传 true。
  explicitFirstSync: boolean = false
): Promise<{ writtenTombstoneIds: string[]; recoveredIds?: string[]; indexRebuilt?: boolean }> {
  // 每个上下文（SW / popup / options）首次调用时补一次解析：
  // SW 启动时的 prime 管不到 popup，popup 里第一次点同步若直接读缓存，
  // 拿到的是「未预解析 fail-safe 的 Supabase」，用户配的 WebDAV 被无声绕过。
  // 已有缓存时零开销（不重建适配器、不重跑 PBKDF2）。
  await ensureBackendPrimed();
  const result = await getActiveSyncBackend().uploadGroups(groups, {
    overwriteRemote: overwriteCloud,
    suppressFirstSyncFullUpload: !explicitFirstSync,
  });
  // 契约映射：SyncBackendPort.uploadGroups 的 `writtenIds` → 调用方熟悉的
  // `writtenTombstoneIds`。Supabase 适配器只报告真实写上的墓碑 id
  // （覆盖模式才可能非空），不做扩大解释 —— 见 supabaseAdapter 文件头。
  return {
    writtenTombstoneIds: result.writtenIds,
    // 2026-10-20 修 P0：云端索引丢过 / 有会话被水位线误判成「已上传」时，
    // 这两个字段是**要上报给用户的事实**，不能在这一层被吞掉。
    ...(result.recoveredIds ? { recoveredIds: result.recoveredIds } : {}),
    ...(result.indexRebuilt ? { indexRebuilt: true } : {}),
  };
}

export async function downloadTabGroups(): Promise<TabGroup[]> {
  await ensureBackendPrimed();
  return getActiveSyncBackend().downloadGroups();
}

/**
 * 本轮（或最近一轮）下载里**读不出来**而被整组跳过的会话（2026-10-20 D-6）。
 *
 * 那些组的**云端行仍在**（一个字节都没被动过），只是这一轮没能把它们还原成
 * 可用的会话（形状不可恢复 / 还原率不达标 / tabs 表回填被截断 / 单组处理异常）。
 *
 * ⚠️ **凡是会用下载结果替换本地的路径（覆盖下载）必须用下面那个原子包装**，
 * 不要用这个函数 + `downloadTabGroups()` 的「两步走」：两步之间有 await 间隙，
 * 理论上可能读到**别的轮次**的清单 ⇒ 保护错对象。
 *
 * 「方法不存在」的语义 = 该后端本轮没有跳过任何会话（**这是事实，不是「不知道」**）。
 * 「方法存在却抛错」的语义 = 事实未知 ⇒ 调用方必须中止（fail-closed）。
 */
export async function downloadSkippedGroups(): Promise<DownloadSkippedGroup[]> {
  await ensureBackendPrimed();
  return (await getActiveSyncBackend().downloadSkippedGroups?.()) ?? [];
}

/**
 * 一次性拿到「读到的」+「读不出来的」（2026-10-20 D-6）。
 *
 * ── 引擎层**应该用这个**，不要用「两步走」 ──────────────────────────────
 * `downloadTabGroups()` 与 `downloadSkippedGroups()` 是两次独立调用，中间有
 * await 间隙 ⇒ 理论上可能读到**别的轮次**的清单（清单是「上一轮/这一轮」的
 * 单例，见 utils/supabase/download.ts 的 lastDownloadSkipped）。把两件事收进
 * 一个函数 ⇒ 端口实例只解析一次、两次读取紧邻执行 ⇒ 拿到的是**同一轮**的快照。
 *
 * 失败语义：
 *   · 下载失败 → 抛（整轮中止，与既有下载路径一致）；
 *   · 后端没有「跳过清单」这个能力 → 空清单（**事实**：它本轮没跳过任何会话）；
 *   · 后端有这个能力但抛错 → **抛**（事实未知 ⇒ fail-closed：
 *     拿「不知道哪些组被跳过」去覆盖本地 = 把「可能只是没读到」的会话删掉）。
 */
export async function downloadTabGroupsWithSkips(): Promise<{
  groups: TabGroup[];
  skipped: DownloadSkippedGroup[];
}> {
  await ensureBackendPrimed();
  const backend = getActiveSyncBackend();
  const groups = await backend.downloadGroups();
  const skipped = (await backend.downloadSkippedGroups?.()) ?? [];
  return { groups, skipped };
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
