import type { TabGroup } from '@/types/tab';
import { mergeOpStamped } from '@/core/opStampMerge';
import { planOverwriteUpload } from '@/core/overwriteUploadGuard';
import { preservedLocalGroups } from '@/core/overwriteDownloadPreserve';
import { dropSyncMergedGroups, removedGroupIds } from '@/core/mutationOps';

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
   * 覆盖时**目标侧被保住**（不删、也不覆盖）的会话数。
   *
   * ⚠️ 2026-10-23（第 51 轮）**改名**：原名 `preservedRemoteCount` 把「哪一侧」
   * 写死在名字里 ⇒ 下载方向沿用它就会变成「说远程」而实际说的是**本地**那份
   * （同名不同义 = 谎话的温床）。语义没变，只是改成目标侧中性的说法：
   *   · 上传覆盖 ⇒ 保住在**云端**的那几行（云端有、这台设备读不出来、本机没副本）；
   *   · 下载覆盖 ⇒ 保住在**本地**的那几份（云端有、这台设备读不出来、本机有副本）。
   *
   * 上传方向：判据见 core/overwriteUploadGuard.ts 的 planOverwriteUpload
   * （与执行侧 utils/supabase/upload.ts 同一个函数 ⇒ 预览与实际同源）。
   * 非覆盖模式恒为 0（合并模式不删任何一侧的行）。
   */
  preservedCount: number;
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
    // 覆盖时被保住的会话数由两个 build*PreviewSummary 单独算
    // （它们各自需要「读不出来的清单」这份额外事实）⇒ 这里恒为 0。
    preservedCount: 0,
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
    return { ...summary, preservedCount: protectedIds.length };
  }

  return { ...summary, preservedCount: 0 };
};

export interface DownloadPreviewOptions {
  /**
   * 云端那些「这台设备读不出来」的会话 id（下载跳过清单）。
   *
   * 覆盖下载时，这些组的**本机副本会被保住**（执行侧见
   * services/syncEngine.ts 第 4 步：`forceRemote` 时本机参与合并的只有
   * `skippedIds` 命中的那几份 —— 也就是「云端只是这轮没读到」的那几份）。
   *
   * 为什么必须由调用方传入：读不出来是**下载侧**的事实，而被跳过的那些组
   * **不在** `remoteGroups` 里（那是「读到的」）。不把跳过清单一起给进来，
   * 预览就会算成「覆盖下载后本地只剩云端读到的那些」⇒ **把不会发生的事说成
   * 会发生**（把保住的几份报成「将删除」）。
   *
   * ⚠️ **必填**（2026-10-23，第 51 轮）：它不是「可选的补充信息」——
   * 缺了它，预览就会退回**已知会撒谎**的旧口径（把保住的几份报成「将删除」）。
   * 让「忘了传」变成编译期错误，比让它静默说谎好。
   */
  skippedRemoteIds: readonly string[];
}

export const buildDownloadPreviewSummary = (
  localGroups: TabGroup[],
  remoteGroups: TabGroup[],
  mode: SyncPreviewMode,
  options: DownloadPreviewOptions
) => {
  const activeLocalGroups = toActiveGroups(localGroups);
  // 「云端这轮读不出来」的那几组：它们的**云端行仍在**，而执行侧会保住
  // **本机**对应的副本（见 options.skippedRemoteIds 的说明）。
  const skippedIds = new Set(options.skippedRemoteIds);
  // ⚠️ 判据与执行侧**同一个函数**（core/overwriteDownloadPreserve.ts）⇒
  // 预览预告的「覆盖后本地还剩什么」与真正落盘的结果必然一致。
  const preserved = preservedLocalGroups(activeLocalGroups, skippedIds);

  // ── 落盘集合：**与执行侧同函数同公式**（2026-10-23，第 51 轮）────────────
  //
  // 执行侧（services/syncEngine.ts 第 4/5/7 步）：
  //   ① 本机参与合并的 = 覆盖时只有「被跳过的」那几份；合并时是全部活跃组；
  //   ② merged = mergeOpStamped(本机参与的那几份, 云端读到的);
  //   ③ finalGroups = merged 剔掉「零标签空壳」，但**被跳过的组豁免**。
  //
  // ⚠️ 为什么不能手写拼接（第 51 轮之前的写法）：
  //   · **不去重**：同一个 id 若同时出现在「读到的」与「读不出来的」两份清单里
  //     （云端 tabs 表回填抛错时那一组**既在结果里又被记成跳过**，
  //     见 utils/supabase/download.ts 的 catch 分支）⇒ 预览把它数两遍，
  //     而引擎按 id 去重 ⇒ 预览说「还剩 2 个」，实际落盘 1 个。
  //   · **不建模空壳清理**：云端带来的零标签组会被引擎当空壳剔掉**并登记删除
  //     广播**（1.22.0 起 = 永久删除）⇒ 预览却算成「保留/更新」，
  //     风险文案会说「不会删除本地上的任何会话」—— **方向相反的谎话**。
  const mergeInputLocal = mode === 'overwrite' ? preserved : activeLocalGroups;
  const merged = mergeOpStamped(mergeInputLocal, remoteGroups);
  const shellDropped = dropSyncMergedGroups(merged);
  const shellDroppedIds = new Set(removedGroupIds(merged, shellDropped));
  const afterGroups = merged.filter(
    group => !shellDroppedIds.has(group.id) || skippedIds.has(group.id),
  );

  const summary = buildPreviewFromBeforeAndAfter(activeLocalGroups, afterGroups);
  return {
    ...summary,
    // 合并模式没有「目标侧被保住」这回事（它压根不删云端行）⇒ 恒 0。
    preservedCount: mode === 'overwrite' ? preserved.length : 0,
  };
};
