/**
 * Supabase 后端的 SyncBackendPort 适配器（2026-10-13，阶段 0）。
 *
 * ── 为什么是「适配」而不是「重写」──────────────────────────────────────
 * 本类的每一步都**透传**给现有 `utils/supabase/*`，不重新实现任何逻辑。
 * 原因是那些实现里埋着一整年的教训：
 *   · 分页的 offset 漂移交叉校验（download.ts:192-263，created_at 并列曾丢 25%）
 *   · 上传的加密失败 fail-closed（upload.ts:709-716，绝不明文上云）
 *   · 上传后的读回校验、认输预检 findConcededGroupIds（upload.ts:595-611）
 *   · 探测列支持的降级链（probe.ts supportsOpStamp / supportsCloudTombstone）
 * 本阶段的任务是**加接缝**，不是重写。任何「顺手简化」都会把这些丢掉。
 *
 * ── 一处**语义收窄**（如实说明，不是遗漏）──────────────────────────────
 * `SupabaseSyncPort.uploadTabGroups` 返回 `writtenTombstoneIds`（只含墓碑 id），
 * 而 `SyncBackendPort.uploadGroups` 的 `writtenIds` 语义是
 * 「本轮确实写上远端的 id」。
 *
 * 两者**不相等**，且这个差距是**故意保留**的：
 *   合并上传路径只传活跃组，此时 `writtenTombstoneIds` 恒为空；
 *   覆盖模式才可能带上本地墓碑。
 * 若把入参 groups 的 id 全塞进 `writtenIds`，就会谎报「这些都写成功了」——
 * 而 upsert 可能因认输预检（findConcededGroupIds）过滤掉其中一部分。
 * **谎报的后果是删除队列被错误消费**（见 storage.clearPendingDeleteIds 的论证）。
 *
 * 结论：这里只转发 Supabase 真实报告的信息，不做任何扩大解释。
 */
import type { TabGroup, UserSettings } from '@/types/tab';
import type {
  DownloadSettingsResult,
  RemoteGroupFingerprint,
  SyncBackendPort,
  UploadGroupsResult,
} from './ports';
import type { DownloadSkippedGroup } from '@/types/tab';
import type { DeleteBroadcastResult } from '@/core/accountScope';
import { loadSupabaseFacade } from '@/utils/supabaseRuntime';

/**
 * 加载 Supabase 读写实现（**按需加载**）。
 *
 * ── 为什么不是静态 import ────────────────────────────────────────────────
 * `@/utils/supabaseFacade` 是整条 Supabase 链的入口：Supabase SDK
 * （auth-js / postgrest-js / realtime-js / storage-js / functions-js /
 * phoenix，gzip 后约 58KB）加上 upload / download / probe / readback
 * 四份实现（约 140KB 源码）。适配器本身只有本文件这几十行，
 * 真正干活的是那套实现 ⇒ **在第一次真的同步时才加载它**。
 *
 * 否则：弹窗首屏（用户只想看本机会话列表）也得下载这一整条栈。
 *
 * 代价：每次调用多一次 `await`（动态加载命中已加载模块 ⇒ 一次
 * Promise 微任务，不是重新下载、也不是重新求值）。端口的每个方法本来就
 * 是 async 的 ⇒ 调用方**感知不到**这次多出来的微任务。
 *
 * ⚠️ **service worker 里不能用 `import()`**（Chrome 按 HTML 规范禁止），
 * 而 SW 侧同样要同步 ⇒ 取法由 `utils/supabaseRuntime.ts` 统一：
 * 页面动态加载，SW 由入口注册静态加载器。
 */
async function loadSupabaseSync() {
  const { sync } = await loadSupabaseFacade();
  return sync;
}

/** `T | null | undefined` → `T | undefined`。指纹字段用 undefined 表示「后端没给」。 */
function nn<T>(v: T | null | undefined): T | undefined {
  return v === null || v === undefined ? undefined : v;
}

export class SupabaseBackendAdapter implements SyncBackendPort {
  readonly id = 'supabase' as const;
  readonly label = 'TapStack 云端';

  async fetchFingerprints(): Promise<RemoteGroupFingerprint[]> {
    const supabaseSync = await loadSupabaseSync();
    const digest = await supabaseSync.fetchTabGroupsDigest();
    return digest.map(d => ({
      id: d.id,
      // updated_at 在 TabGroupDigest 里是必填 string，直接透传（端口已收紧为必填）。
      updatedAt: d.updated_at,
      // Supabase 没有 ETag（它不在 HTTP 层做条件写），所以 etag 不设值——
      // 而不是拿 version 冒充。两者语义不同，见 ports.ts 的字段注释。
      // version 原样透传（v1.22 起已冻结，但消费方仍在用它做变更判定）。
      version: d.version ?? undefined,
      isDeleted: d.is_deleted === true,
      lastOp:
        nn(d.last_op_device) !== undefined && typeof d.last_op_seq === 'number'
          ? { d: String(d.last_op_device), s: d.last_op_seq }
          : undefined,
    }));
  }

  async downloadGroups(): Promise<TabGroup[]> {
    const supabaseSync = await loadSupabaseSync();
    return (await supabaseSync.downloadTabGroups()) as TabGroup[];
  }

  /**
   * 只取给定 ids 的那些行（2026-10-23 第 53 轮）。
   *
   * 为什么这条必须存在：全量下载把**每一行**的加密 tabs_data 都拉回来
   * （实测占响应体 93.5%），而绝大多数行没变 ⇒ 云端出网按字节计费时
   * 「每轮全量」会把配额吃光 ⇒ 整个项目被限流（Supabase 是项目级封禁）。
   * ⇒ 出网量必须 ∝ 变更量。
   *
   * 判据在 core/cloudDelta.ts（纯函数）：哪些行「本地那份就能代表它」
   * （印记相同 ⇒ 合并必然选本地）⇒ 那些行根本不必回源。
   */
  async downloadGroupsByIds(ids: string[]): Promise<TabGroup[]> {
    const supabaseSync = await loadSupabaseSync();
    return (await supabaseSync.downloadTabGroups({ onlyIds: ids })) as TabGroup[];
  }

  /**
   * D-6：云端后端**会**产生「读不出来的那几组」。
   *
   * 那些组被整组跳过（形状不可恢复 / 还原率不达标 / tabs 表回填被截断 /
   * 单组处理异常），**云端行原封保留**（一个字节都没被动过）。
   *
   * 为什么必须把它们报出去：覆盖下载（forceRemote）会用云端**替换**本地。
   * 若「这轮没读到」在返回值里消失，引擎就会把「没读到」当成「云端没有」
   * ⇒ 本机那一份被物理清除 ⇒ 云端的数据被用户自己的下载吃掉，UI 还报成功。
   *
   * ⚠️ 同轮保证：清单与 `downloadGroups()` 的结果来自**同一轮**下载
   * （见 utils/supabase/download.ts 的 lastDownloadSkipped：那里把本轮的
   * 跳过清单记下来，本方法读它，而不是**再读一次云端**）。
   * 分两次读会拿到两轮不同的云端状态，而引擎需要的是「这一轮拿到了哪些、
   * 没拿到哪些」的**同一个快照**。
   */
  async downloadSkippedGroups(): Promise<DownloadSkippedGroup[]> {
    const supabaseSync = await loadSupabaseSync();
    return (await supabaseSync.downloadSkippedGroups()) ?? [];
  }

  async uploadGroups(
    groups: TabGroup[],
    opts?: { overwriteRemote?: boolean }
  ): Promise<UploadGroupsResult> {
    // overwriteCloud 的语义与 Supabase 实现的第二参数逐字对应：
    // 先 DELETE 该 user 全部行再 upsert（逐条语义见 upload.ts 的覆盖模式段）。
    const supabaseSync = await loadSupabaseSync();
    const up = await supabaseSync.uploadTabGroups(groups, opts?.overwriteRemote === true);

    // writtenIds 只含 Supabase 真实报告已写的墓碑（覆盖模式才可能非空）。
    // 不做扩大解释，理由见文件头「一处语义收窄」。
    return {
      writtenIds: [...new Set(up?.writtenTombstoneIds ?? [])],
      overwroteRemote: opts?.overwriteRemote === true,
      // 覆盖被跳过时**必须透出去**（2026-10-23 回归审计 R-1）：
      // `overwroteRemote` 只说明「请求是覆盖模式」，不说明「覆盖真的发生了」。
      // 换账号后本机没有属于当前账号的会话 ⇒ 闸门放行 0 个 ⇒ 覆盖被跳过、
      // 云端原样保留 —— 上层要据此**不**给用户报「已覆盖云端」。
      ...(up?.overwriteSkipped ? { overwriteSkipped: up.overwriteSkipped } : {}),
      // 账号闸门拦下的那批（2026-10-22 DS-1 收口）：它们**没进上行集合**，
      // 上层对账时必须知道它们「不算已提交」。
      ...(up?.blockedAccountIds ? { blockedAccountIds: up.blockedAccountIds } : {}),
    };
  }

  async broadcastDeletes(ids: string[]): Promise<DeleteBroadcastResult> {
    // 失败必须抛（markCloudGroupsAsDeleted 内部已保证读回确认后才返回）。
    //
    // ⚠️ 账号闸门在**里面**（utils/supabase/upload.ts 的 markCloudGroupsAsDeleted
    // —— 全仓唯一真正写 `.eq('user_id', userId)` 的地方）：属于本机另一个账号的
    // 删除意图**不写云端**，由返回值里的 blockedIds 报上来 ⇒ 调用方只清
    // broadcastIds ⇒ 被挡下的那几条留在删除队列里，等登录到那个账号时再广播。
    const supabaseSync = await loadSupabaseSync();
    return supabaseSync.markCloudGroupsAsDeleted(ids);
  }

  async purgeExpiredDeletes(maxAgeDays?: number): Promise<number> {
    const supabaseSync = await loadSupabaseSync();
    return supabaseSync.purgeExpiredCloudTombstones(maxAgeDays);
  }

  async uploadSettings(settings: UserSettings): Promise<void> {
    const supabaseSync = await loadSupabaseSync();
    await supabaseSync.uploadSettings(settings);
  }

  async downloadSettings(): Promise<DownloadSettingsResult> {
    const supabaseSync = await loadSupabaseSync();
    return (await supabaseSync.downloadSettings()) as DownloadSettingsResult;
  }
}

