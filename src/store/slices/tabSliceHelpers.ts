/**
 * P0 手术 · tabSlice 纯函数抽离（行为零变化）。
 * 回环过滤 / 代际 guard / 墓碑过滤均为纯函数（仅依赖 TabState/TabGroup 类型），
 * 与 Redux 样板分离，便于单测直测与后续 syncEngine 收口。
 */
import type { TabGroup, TabState, OptimisticTabBackup } from '@/types/tab';
import { isEmptyGroup } from '@/core/mutationOps';

/** 乐观备份槽位 key：按 tab 维度隔离，避免连点不同 tab 时错位回滚 */
export const backupKeyOf = (groupId: string, tabId: string): string => `${groupId}:${tabId}`;

/**
 * 回环 payload 过滤：剥掉仍在途的乐观删除项（与 deleteTab.fulfilled 重放过滤同语义）。
 *
 * 代际 guard 只拦「发起早于 pending」的 load；pending 之后、SW 落盘之前发起的 load
 * 快照与当前**同代际**，会带着删除前的旧 KV 结算——这里按在途状态补刀，堵住复活窗口：
 * - 组内部分标签在途：过滤掉在途 tab，其余变更正常应用；
 * - 整组被拿空（过滤后为空且 payload 非空）：组不进 active；
 * - **整组在途删除**：组直接不进 active（见下）。
 *
 * 【为什么必须同时处理组级】任何「从磁盘真值重推 UI」的路径都有同一个失效模式：
 * 磁盘还没删，重推就会把乐观删掉的东西带回来。tab 级和组级是**同一类 bug**，
 * 分成两个函数就迟早有人只调其中一个（v1.22.9 前正是如此：清理重复标签的
 * fulfilled 从快照重推时，会把用户刚刚在途删除的整个会话复活）。
 * 组级在途删除的来源是 deleteGroup.pending（备份记在 state.deletedGroupBackups），
 * fulfilled/rejected 落定后即出队，因此这里只需按 id 集合过滤。
 *
 * 【为什么函数名从 stripInFlightTabs 改成 stripInFlightDeletions】
 * 它现在剥的是「在途删除项」，含 tab 级与组级。留着旧名字会让人以为只管标签，
 * 从而在新调用点上漏掉组级 —— 那正是要防的那个 bug。
 */
export const stripInFlightDeletions = (
  groups: TabGroup[],
  backups: OptimisticTabBackup[],
  deletedGroupIds?: Iterable<string>
): TabGroup[] => {
  const pendingGroups = deletedGroupIds ? new Set(deletedGroupIds) : null;
  if (backups.length === 0 && (!pendingGroups || pendingGroups.size === 0)) return groups;

  const pendingByGroup = new Map<string, Set<string>>();
  for (const b of backups) {
    const set = pendingByGroup.get(b.groupId) ?? new Set<string>();
    set.add(b.tabId);
    pendingByGroup.set(b.groupId, set);
  }
  const out: TabGroup[] = [];
  for (const g of groups) {
    // 组级在途删除：整组不进结果（用户已看到它消失，回环不得让它回来）
    if (pendingGroups?.has(g.id)) continue;
    const pend = pendingByGroup.get(g.id);
    if (!pend) {
      out.push(g);
      continue;
    }
    const tabs = g.tabs.filter(t => !pend.has(t.id));
    if (tabs.length === 0 && g.tabs.length > 0) continue;
    out.push(tabs.length === g.tabs.length ? g : { ...g, tabs });
  }
  return out;
};

/**
 * P1-5 · 乐观写失败回滚快照（纯函数，reducer 与单测共用）。
 *
 * 根因：重命名/锁定/收藏/备注四条写路径都是「先乐观改 Redux，再 sendMutation」，
 * 而 sendMutation 失败时没有任何人把 Redux 改回去——UI 显示新值、storage 还是旧值，
 * 且此后无人再收敛（loadGroups 只有回环才触发）。锁定尤其致命：UI 认为已锁定、
 * storage 认为未锁定，自动清理与删除保护全部按 UI 之外的 storage 判据执行，
 * 用户刚锁上的会话会被当成普通空组清掉。
 *
 * 修法：写入前在 thunk 里抓一份快照，失败时 rejectWithValue 带回来，
 * rejected reducer 用它精确还原。快照只含本次动过的字段，
 * 避免把并发的其他字段改动一起覆盖掉。
 */
export type GroupMetaSnapshot = {
  name: string;
  isLocked: boolean;
  version: number;
  updatedAt: string;
};

/** 写入前抓取组元信息快照；组不存在返回 null（无组可回滚） */
export const snapshotGroupMeta = (
  groups: TabGroup[],
  groupId: string
): GroupMetaSnapshot | null => {
  const group = groups.find(g => g.id === groupId);
  if (!group) return null;
  return {
    name: group.name,
    isLocked: !!group.isLocked,
    version: group.version || 1,
    updatedAt: group.updatedAt,
  };
};

/**
 * 重命名回滚：name + version + updatedAt 一起还原。
 * 只还原 name 会留下「本地 version 比 storage 高、updatedAt 更新」的假新状态，
 * 下一次同步合并会把 storage 的旧名当陈旧版本丢掉——比 UI 显示错更隐蔽。
 * 不碰 isLocked：并发锁定不该被这次重命名失败顺手改回去。
 */
export const restoreGroupName = (group: TabGroup, snapshot: GroupMetaSnapshot): void => {
  group.name = snapshot.name;
  group.version = snapshot.version;
  group.updatedAt = snapshot.updatedAt;
};

/**
 * 锁定回滚：只还原 isLocked。
 * 不还原 version/updatedAt —— 与上面相反，那两个字段是共享的元信息，
 * 一次还原会盖掉并发写入方的 bump；残留的版本偏差由下次 loadGroups 读真值收口，
 * 锁定判据（用户显式保护的那条）本身不含 version。
 */
export const restoreGroupLock = (group: TabGroup, snapshot: GroupMetaSnapshot): void => {
  group.isLocked = snapshot.isLocked;
};

/** load 回环代际判定：在途 mutation（epoch 前进）之后发起的旧快照一律忽略 */
export const isStaleLoad = (
  guards: Record<string, number> | undefined,
  requestId: string,
  mutationEpoch: number | undefined
): boolean => {
  const initiatedEpoch = guards?.[requestId];
  // 无快照（historical 状态/未知来源）一律放行，避免外部变更刷新被饿死
  if (initiatedEpoch === undefined) return false;
  return initiatedEpoch < (mutationEpoch ?? 0);
};

export const takeLoadGuard = (
  state: TabState,
  requestId: string
): void => {
  if (!state.pendingLoadGuards) state.pendingLoadGuards = {};
  state.pendingLoadGuards[requestId] = state.mutationEpoch ?? 0;
};

export const dropLoadGuard = (state: TabState, requestId: string): void => {
  if (state.pendingLoadGuards) delete state.pendingLoadGuards[requestId];
};

/** 过滤组内标签级墓碑（storage 保留墓碑用于同步删除意图，Redux/UI 不感知） */
export const stripTombstonedTabs = (group: TabGroup): TabGroup =>
  group.tabs.some(t => t.isDeleted) ? { ...group, tabs: group.tabs.filter(t => !t.isDeleted) } : group;

/**
 * storage 全量 → UI 活跃视图（loadGroups 建立的主状态不变量）：
 * **id 去重** + 剔除组级墓碑 + 组内标签级墓碑 + 空壳会话。所有把 storage 数据灌回
 * state.groups 的路径（loadGroups / cleanDuplicateTabs.fulfilled 等）必须经此管线。
 * 排序由调用方自理（loadGroups 按 createdAt 倒序；fulfilled 沿用 storage 序）。
 *
 * 【id 去重为什么必须有】storage 允许出现同 id 多条记录——真实故障（2026-09-30）
 * 是一次读-改-写竞态把整条记录追加了两遍。云端不会重复（id 是主键，上传走
 * upsert onConflict id），但本地合并路径不碰它。重复 id 会让 TabList 的
 * key={group.id} 撞车：单栏凑合不炸，双栏分支把数组重切成两半后 React 协调复制
 * DOM，33 张卡渲染成 39 张，用户看到「切双栏凭空多出空标签组」。
 * 策略与 mergeOpStamped / upload.uniqueGroups 一致：Map 按 id 收敛、后写入者胜，
 * Map 保留首次插入位置 → 视图顺序不变。
 *
 * 【空壳会话必须熄掉】组内标签被非 moveTab 路径清空时（同步合并把远端删除意图
 * 落成本地 tab 墓碑、云端删光整组、URL 去重败者盖墓碑），组级墓碑不会置位，
 * stripTombstonedTabs 剥完标签级墓碑就剩一个 tabs: [] 的空壳，会在列表里渲染成
 * 一张空会话卡且永远不消失。判据用 core/mutationOps.isEmptyGroup——锁定组只有在
 * 零标签时才算空壳；有内容的锁定组照旧豁免（用户显式保护，见 shouldAutoDelete
 * AfterTabRemoval，那条管的是用户当场删 tab 的实时流程，本视图不碰）。
 *
 * 只过滤视图、不写 storage：读路径绝不产生写（v1.21.2 墓碑灌入事故的教训），
 * 空壳本身没有可恢复的标签内容，storage 保留原样由同步语义自行裁决。
 */
export const toActiveGroupsView = (groups: TabGroup[]): TabGroup[] => {
  const byId = new Map<string, TabGroup>();
  for (const g of groups) {
    if (!g.isDeleted) byId.set(g.id, g);
  }
  return [...byId.values()]
    .map(stripTombstonedTabs)
    .filter(g => !isEmptyGroup(g));
};

// ── 清理重复标签：乐观更新与收敛（v1.22.9）──────────────────────────────
//
// 【要解决的问题】原先清理的 UI 反馈完全依赖 SW 回传的 updatedGroups 全量：
// 用户点下去之后，要等「排队 → 读全量 → 计算 → 写全量 → 跨进程克隆几 MB 回来
// → 全量重算 toActiveGroupsView → React 全量重渲染」整条链跑完，列表才动一下。
// 而清理是纯本地去重，磁盘上早已改完，UI 却在等一次跨进程的大数据搬运。
//
// 【修法】两段：
//   pending   —— 用同一个纯函数 planCleanDuplicates 在本地算出删除计划并立即应用，
//                用户当场看到结果（乐观更新，与 deleteTabAndSync 同一套思路）；
//   fulfilled —— 用 SW 回传的**权威计划**从清理前的快照重新推导，收敛到磁盘真值。
//
// 【为什么 fulfilled 必须从快照重推，而不是把 SW 的计划叠加在乐观结果上】
// 本地计划是拿 popup 的 state.groups 算的，而 SW 拿的是 storage 真值。两者可能不一致
// （popup 状态陈旧、或老版本设备写入的墓碑形状数据已被剥成活跃视图）。叠加只在
// 「本地多删了」时凑巧正确；一旦本地误删了 SW 认为该留的项，叠加永远补不回来，
// 而 popup 又会忽略自己写出的 groups 回声（见 TabList 的 originId 过滤），
// 于是 UI 与磁盘长期分叉，直到下次重开页面。从快照重推则无条件等于 SW 的结果。
import type { CleanDuplicatesPlan } from '@/core/mutationOps';
import type { OpStamp } from '@/core/opStamp';
import { applyCleanDuplicatesPlan, planCleanDuplicates } from '@/core/mutationOps';

/**
 * 把计划应用到活跃视图上（乐观更新与收敛共用同一条管线）。
 *
 * 收尾必须过 toActiveGroupsView：锁定组被清空后 SW 会在磁盘上保留空壳
 * （shouldAutoDeleteAfterTabRemoval 豁免锁定），而主状态不变量是「只含活跃视图」
 * （isEmptyGroup 不豁免锁定）。少了这一步，被清空的锁定组会以空卡片留在列表里。
 */
export const applyCleanPlanToActiveView = (
  groups: TabGroup[],
  plan: CleanDuplicatesPlan,
  now: string,
  stamp: OpStamp
): TabGroup[] => toActiveGroupsView(applyCleanDuplicatesPlan(groups, plan, now, stamp));

/**
 * 乐观清理：本地算计划并立即应用。
 *
 * 计划与 SW 用的是同一个纯函数 ⇒ 去重规则不可能在两端漂移
 * （各自实现一份的话，「本地显示删了、磁盘上没删」迟早会出现）。
 *
 * @returns 应用后的活跃视图，以及本地算出的计划（供调试/断言）
 */
export const planOptimisticClean = (
  groups: TabGroup[]
): { groups: TabGroup[]; plan: CleanDuplicatesPlan } => {
  const plan = planCleanDuplicates(groups);
  // 乐观阶段刻意**不**改 updatedAt / version / lastOp：
  // 这些字段参与组级 LWW 裁决，写一个本地编造的值（空串时间戳、s:0 印记）
  // 会让这一瞬的 UI 状态在语义上变成「一次比磁盘更旧的写入」；而且它们只在
  // 磁盘上有意义，乐观视图根本不消费。fulfilled 会立刻用 SW 的权威
  // now/stamp 从快照重推，所以这里只删标签、不动元信息，最安全也最省事。
  const removedGroups = new Set(plan.removedGroupIds);
  const byGroup = new Map(plan.removedTabsByGroup.map(e => [e.groupId, new Set(e.tabIds)]));
  const next = groups
    .filter(g => !removedGroups.has(g.id))
    .map(g => {
      const ids = byGroup.get(g.id);
      return ids && ids.size > 0 ? { ...g, tabs: g.tabs.filter(t => !ids.has(t.id)) } : g;
    });
  return { groups: toActiveGroupsView(next), plan };
};
