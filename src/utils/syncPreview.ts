import type { TabGroup } from '@/types/tab';
import { mergeOpStamped } from '@/core/opStampMerge';
import { planOverwriteUpload } from '@/core/overwriteUploadGuard';

export interface SyncPreviewSummary {
  additions: number;
  updates: number;
  deletions: number;
  unchanged: number;
  beforeCount: number;
  afterCount: number;
  addedNames: string[];
  updatedNames: string[];
  deletedNames: string[];
  /**
   * 覆盖上传时**留在云端、不会被删除或覆盖**的会话数（2026-10-20 P1）。
   *
   * 指「云端有、这台设备读不出来、而本机又没有副本」的那几组：删掉它们就是
   * 永久丢失（无回收站），所以覆盖上传会跳过它们（见
   * utils/supabase/upload.ts 与 core/overwriteUploadGuard.ts）。
   *
   * 数字来自**同一个判据函数**（planOverwriteUpload）⇒ 预览预告的「会保留哪几行」
   * 与执行时真正保留的是同一套规则算出来的（预览与实际同源）。
   * 非覆盖模式恒为 0（合并模式不删云端行）。
   */
  preservedRemoteCount: number;
}

type SyncPreviewMode = 'overwrite' | 'merge';

const MAX_NAME_PREVIEW = 3;

const toActiveGroups = (groups: TabGroup[]) => groups.filter(group => !group.isDeleted);

/**
 * 一个时间戳的**规范形** —— 同一个时刻在两条后端上写着不同的字符串。
 *
 * ── 为什么必须规范化（2026-10-20 审计 A-10 续）──────────────────────────
 *   · 本地存的 `updatedAt` 来自 `new Date().toISOString()`
 *     ⇒ `2026-10-20T10:00:00.000Z`
 *   · 云端 `updated_at` 是 Postgres 的 `timestamptz`
 *     ⇒ PostgREST 回读是 `2026-10-20T10:00:00+00:00`
 *     （老 `tabs` 表回填路径甚至是 Postgres 文本格式 `2026-10-20 10:00:00+00`）
 *   三个字符串是**同一个时刻**，按字符串比就不相等 ⇒ 指纹判成「内容变了」
 *   ⇒ 覆盖预览把一个字节都没变过的会话报成「将更新」。
 *
 * 规范成「毫秒数」之后：写法的差异不再进指纹，而**真正不同的时刻**
 * （哪怕只差 1 毫秒）照样被检出 —— 判据没被放宽，只是换了等价表示。
 *
 * 解析不了的值（脏数据 / 非日期串）退回按**原字符串**比，并加前缀与毫秒数
 * 区分开：宁可当成「变了」，也不要把两份不同的内容判成一样（fail-safe）。
 */
const normalizeInstant = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) return 'absent';
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? `raw:${value}` : `ms:${ms}`;
};

/**
 * 「两个会话是不是同一个内容」的指纹 —— 只覆盖**用户看得见 / 影响裁决**的字段。
 *
 * ── 这条指纹必须与「哪条后端解出来的」脱钩 ──────────────────────────────
 * 同一个会话在两条后端上解出来的**形状不一样**（Supabase 侧多出
 * `version` / `isDeleted` / `deletedAt`，WebDAV 侧一个都没有）。
 * 指纹一旦读了任何「只有一边有」的键，同一份数据就会被判成「内容变了」
 * ⇒ 覆盖预览把没变过的会话报成「将更新」。
 * 所以这里的规则是：**只读两条后端都有的、且值本身跨后端可比的字段**。
 * 这条不变量由 `tests/guards/retiredDisplayOrder.test.ts` 的
 * 「形状差异必须与指纹口径脱钩」一组守卫钉住。
 *
 * ⚠️ 2026-10-20 审计 A-10：这里曾包含 `displayOrder`。
 * 它是一个**存着但从不被读来排序**的死字段，却混进了内容指纹 ⇒
 * 同一份会话在两条后端上解出来的形状不同（Supabase 侧从不上传它，
 * WebDAV 侧曾往返它），指纹一比就判成「内容变了」⇒ 覆盖预览会把
 * 没变过的会话报成「将更新」。删掉它，两条后端的指纹口径就对齐了。
 *
 * ⚠️ 2026-10-20 审计 A-10 续：这里曾包含 `version`，同一个病：
 *   · Supabase 侧解出来**带** `version`（数据库列的回读值）
 *   · WebDAV 侧解出来**不带**（文件后端给不出这个概念）
 *   ⇒ 同一份会话，两条后端的指纹必然不等 ⇒ 预览永远报「将更新」。
 * 去掉它的理由不是「它是死字段」，而是三条更硬的理由：
 *   1. **它不决定胜负**：真正的裁决是 op-stamp 全序
 *      （`core/opStamp.ts` 的 `compareStamps` + 服务端 `guard_tab_group_op_stamp` 触发器）；
 *      `version` 判据早已被迁移 `20261020150000_align_version_guard_with_op_stamp.sql`
 *      降级为「两侧都没有印记时」的兜底。
 *   2. **它不是用户可见的内容**：`src/components/` 全仓没有任何一处读 `.version`
 *      （grep 结果为空）⇒ 它进「内容指纹」＝ 让用户为一个看不见的字段看到「将更新」。
 *   3. **它跨设备根本不可比**：`version` 是**每台设备各自的本地计数器**
 *      （`core/versionHelper.ts` 只在本机递增），设备 A 的 5 和设备 B 的 3
 *      之间没有可比性 —— 拿它做「两份内容是否相同」的判据，方向就是错的。
 *      顺带一提：正因为如此，候选方案「让 WebDAV 也带上 version」是**不能做的**
 *      —— 那会把一台设备的计数器写进共享文件，再当成对方的本地计数器读回来。
 * 唯一还在读 `version` 的是探活短路 `core/syncDecision.ts` 的 `hasRemoteChanges`，
 * 它**不走这条指纹**，且方向是 fail-safe（多下一次全量，不会漏检）。
 */
export const getComparableFingerprint = (group: TabGroup) =>
  JSON.stringify({
    name: group.name,
    isLocked: !!group.isLocked,
    updatedAt: normalizeInstant(group.updatedAt),
    tabs: (Array.isArray(group.tabs) ? group.tabs : []).map(tab => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      pinned: !!tab.pinned,
      lastAccessed: normalizeInstant(tab.lastAccessed),
      createdAt: normalizeInstant(tab.createdAt),
    })),
  });

const applySourceUpsertToTarget = (targetGroups: TabGroup[], sourceGroups: TabGroup[]) => {
  const nextGroups = new Map(targetGroups.map(group => [group.id, group]));

  sourceGroups.forEach(group => {
    nextGroups.set(group.id, group);
  });

  return Array.from(nextGroups.values());
};

const buildPreviewFromBeforeAndAfter = (
  beforeGroups: TabGroup[],
  afterGroups: TabGroup[]
): SyncPreviewSummary => {
  const beforeMap = new Map(beforeGroups.map(group => [group.id, group]));
  const afterMap = new Map(afterGroups.map(group => [group.id, group]));

  let additions = 0;
  let updates = 0;
  let deletions = 0;
  let unchanged = 0;
  const addedNames: string[] = [];
  const updatedNames: string[] = [];
  const deletedNames: string[] = [];

  afterGroups.forEach(group => {
    const previousGroup = beforeMap.get(group.id);

    if (!previousGroup) {
      additions += 1;
      if (addedNames.length < MAX_NAME_PREVIEW) {
        addedNames.push(group.name);
      }
      return;
    }

    if (getComparableFingerprint(previousGroup) !== getComparableFingerprint(group)) {
      updates += 1;
      if (updatedNames.length < MAX_NAME_PREVIEW) {
        updatedNames.push(group.name);
      }
      return;
    }

    unchanged += 1;
  });

  beforeGroups.forEach(group => {
    if (!afterMap.has(group.id)) {
      deletions += 1;
      if (deletedNames.length < MAX_NAME_PREVIEW) {
        deletedNames.push(group.name);
      }
    }
  });

  return {
    additions,
    updates,
    deletions,
    unchanged,
    beforeCount: beforeGroups.length,
    afterCount: afterGroups.length,
    addedNames,
    updatedNames,
    deletedNames,
    // 覆盖上传时被保留的云端会话数由 buildUploadPreviewSummary 单独算
    // （它需要「读不出来的清单」这份额外事实）⇒ 这里恒为 0。
    preservedRemoteCount: 0,
  };
};

export interface UploadPreviewOptions {
  /**
   * 覆盖模式下**目标侧的独有会话会不会被删掉**。
   *
   * 自带存储（WebDAV）的覆盖不是「替换」而是「全量上行 + 清单并集」：
   * `webdav/adapter.ts` 的 uploadGroups 把本地全部组写上去，写清单时以最新 base 为底
   * 只覆盖本批写过的条目（其余原样保留）⇒ 云端独有会话**一个都不会删**。
   * 于是预览若照 Supabase 的「替换」口径算，会报出一个不存在的删除数
   * （用户被吓得不敢用覆盖），还与同一后端的设置页口径（`WebDavSettings`：
   * 「云端独有会话未被删除」）互相矛盾。判据必须按后端分流。
   */
  preserveRemoteOnly?: boolean;
  /**
   * 云端那些「这台设备读不出来」的会话 id（下载跳过清单）。
   *
   * 覆盖上传时，其中「本机又没有副本」的那几组**不会**被删除或覆盖
   * （删了就是永久丢失 —— 无回收站）。判据见 core/overwriteUploadGuard.ts，
   * 与执行侧（utils/supabase/upload.ts）**同一个函数** ⇒ 预览预告的保留数与
   * 实际保留的必然一致。
   *
   * 为什么必须由调用方传入：读不出来是**下载侧**的事实，而下载结果里被跳过的
   * 那几组**不在** `remoteGroups` 里（那是「读到的」）。不把跳过清单一起给进来，
   * 预览就会算成「云端只有读得到的那几组」⇒ 保留数算错。
   */
  unrestorableRemoteIds?: readonly string[];
}

export const buildUploadPreviewSummary = (
  localGroups: TabGroup[],
  remoteGroups: TabGroup[],
  mode: SyncPreviewMode,
  options?: UploadPreviewOptions
) => {
  const activeLocalGroups = toActiveGroups(localGroups);
  const activeRemoteGroups = toActiveGroups(remoteGroups);
  // 合并模式本来就是 upsert 并集；覆盖模式只在「替换」型后端（Supabase）才是替换。
  const upsertOnly = mode === 'merge' || options?.preserveRemoteOnly === true;
  const afterGroups = upsertOnly
    ? applySourceUpsertToTarget(activeRemoteGroups, activeLocalGroups)
    : activeLocalGroups;

  const summary = buildPreviewFromBeforeAndAfter(activeRemoteGroups, afterGroups);

  // 覆盖上传时被保住的云端会话数（2026-10-20 P1）。
  //
  // 只在「替换」型后端上有意义：自带存储（WebDAV）的覆盖本来就一个都不删
  // ⇒ 保留数恒为 0（那里不存在「被删掉」这回事）。
  //
  // 数字来自**与执行侧同一个判据函数** ⇒ 预览与实际同源。
  if (mode === 'overwrite' && !upsertOnly) {
    const unrestorableIds = options?.unrestorableRemoteIds ?? [];
    const protectedIds = planOverwriteUpload({
      // 云端行的全集 = 读得到的 + 读不出来的（读不出来的那几行并没有从云端消失）。
      cloudIds: [...activeRemoteGroups.map(group => group.id), ...unrestorableIds],
      localIds: localGroups.map(group => group.id),
      unrestorableIds,
    }).protectedIds;
    return { ...summary, preservedRemoteCount: protectedIds.length };
  }

  return { ...summary, preservedRemoteCount: 0 };
};

export const buildDownloadPreviewSummary = (
  localGroups: TabGroup[],
  remoteGroups: TabGroup[],
  mode: SyncPreviewMode
) => {
  const activeLocalGroups = toActiveGroups(localGroups);
  const activeRemoteGroups = toActiveGroups(remoteGroups);
  // 必须用与实际下载相同的合并函数与相同入参（含墓碑行/墓碑组的完整列表），
  // 否则预览会预告一个与实际结果相反的胜负：预先 toActiveGroups 过滤会把云端
  // 墓碑行滤掉 → 预览说「组还在」，实际删除广播却把它删了。合并结果再按活跃态展示。
  const afterGroups =
    mode === 'overwrite'
      ? activeRemoteGroups
      : toActiveGroups(mergeOpStamped(localGroups, remoteGroups));

  return buildPreviewFromBeforeAndAfter(activeLocalGroups, afterGroups);
};
