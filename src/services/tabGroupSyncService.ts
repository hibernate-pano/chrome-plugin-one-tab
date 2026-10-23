import type { TabGroup } from '@/types/tab';
import { getActiveSyncBackend, ensureBackendPrimed } from '@/sync-backend';
import type { RemoteGroupFingerprint } from '@/sync-backend';
import type { OverwriteSkipReason } from '@/core/overwriteUploadGuard';
import type { GroupDigestLike } from '@/core/syncDecision';
import type { DeleteBroadcastResult } from '@/core/accountScope';

/**
 * 透传层：调用方（SyncEngine / SyncButton）与「当前生效的同步后端」之间的唯一接缝。
 *
 * ── 为什么这里是**静态** import ──────────────────────────────────────────
 * 2026-10-23 之前这里没有任何 import（后端由调用方传进来），
 * 后来一度改成 `await import('@/sync-backend')`，理由是「别把同步栈拖进首屏」。
 * 两件事让那个改法站不住：
 *   1. **弹窗首屏本来就有这个桶**：`HeaderDropdown`（顶栏菜单）静态 import 了
 *      `@/sync-backend`（它要看后端解析状态）⇒ 本文件改静态**不增加**首屏体积。
 *   2. **service worker 里 `import()` 被 Chrome 禁止**（HTML 规范），
 *      而 SW 侧（syncEngine）正是这个接缝的主要调用方 ⇒ 动态加载在 SW 里必然失败。
 *
 * ⇒ 真正要挡住首屏的不是「这个桶」，而是**桶里的重依赖**：
 * Supabase SDK 与 WebDAV 传输栈。那两块的取法见
 * `utils/supabaseRuntime.ts` 与 `sync-backend/webdavRuntime.ts`
 * （页面动态加载、SW 静态注册）。
 *
 * ⚠️ **顺序不许调换**：必须先 `await ensureBackendPrimed()`（补一次解析）
 * 再取后端 —— 顺序颠倒会拿到「未预解析的 fail-safe Supabase」，
 * 用户配的 WebDAV 被无声绕过（见 sync-backend/index.ts 的说明）。
 */

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
): Promise<{
  writtenTombstoneIds: string[];
  recoveredIds?: string[];
  indexRebuilt?: boolean;
  /** 被账号闸门挡下、**不算已提交**的会话 id（2026-10-22 DS-1 收口）。 */
  blockedAccountIds?: string[];
  /**
   * 覆盖模式被跳过的原因（2026-10-23 回归审计 R-1 收口）。
   *
   * 覆盖 = 「先删空云端再写回」。当账号闸门放行 0 个（换账号）时，
   * 「删空」会发生而「写回」什么都不会写 ⇒ 纯数据丢失 ⇒ 必须跳过并**如实上报**
   * （否则界面报「已覆盖云端」，而云端其实原封未动/或已被清空）。
   */
  overwriteSkipped?: OverwriteSkipReason;
}> {
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
    // 账号闸门拦下的那批（2026-10-22 DS-1 收口）：同样**不能在这一层被吞掉**
    // —— 上层要靠它把「没提交」与「已提交」分开。
    ...(result.blockedAccountIds ? { blockedAccountIds: result.blockedAccountIds } : {}),
    // 覆盖被跳过的事实（2026-10-23 R-1）：同样不能吞 —— 上层要靠它区分
    // 「已覆盖云端」与「覆盖没发生」。
    ...(result.overwriteSkipped ? { overwriteSkipped: result.overwriteSkipped } : {}),
  };
}

export async function downloadTabGroups(): Promise<TabGroup[]> {
  await ensureBackendPrimed();
  return getActiveSyncBackend().downloadGroups();
}

// ⚠️ 2026-10-23（第 51 轮）：这里原本还有一个**导出的** `downloadSkippedGroups()`，
// 全仓没有任何调用方（引擎与预览都走下面的原子包装）⇒ 删掉了。
// 留着它 = 留一条「可以两步走」的路，而那正是本文件头警告的错法 ⇒ 删掉比留着更安全。

/**
 * ⚠️ 2026-10-23（第 51 轮）：这里原本还有一个 `downloadTabGroupsWithSkips()`
 * （同样是「一次性拿到读到的 + 读不出来的」），但它**少了三样东西**：
 *   · 不**归一化**清单（脏 id / 重复 id 不管）；
 *   · 端口的 `downloadSkippedGroups` **存在却抛错**时不 fail-closed
 *     （而是静默当成空清单 ⇒ 拿「不知道」去覆盖本地）；
 *   · 与引擎/预览用的那条路径**不是同一份实现**。
 * ⇒ 删掉它，全仓只剩**一条**原子读路径：
 *   `services/downloadWithSkippedGroups.ts` 的 `downloadGroupsWithSkipped()`
 *   （引擎、预览、以及这里的调用方都走它）。
 *
 * 两条「看起来一样」的下载路径 = 迟早有一处用错 ⇒ 少一条比多一条安全。
 */

/**
 * 广播删除意图（跨设备删除的唯一载体）。
 *
 * @returns 哪些真的广播了、哪些被账号闸门挡下了（2026-10-23 审计 R-1）。
 *   调用方**只**能按 `broadcastIds` 清删除队列：被挡下的那几条（属于本机上的
 *   另一个账号）必须留在队列里，等用户登录到那个账号时再广播 ——
 *   清掉它们等于那条会话在对端复活，而用户看见的是「我删掉了」。
 */
export async function markCloudGroupsAsDeleted(
  deletedIds: string[]
): Promise<DeleteBroadcastResult> {
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
