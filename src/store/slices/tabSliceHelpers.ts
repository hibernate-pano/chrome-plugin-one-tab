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
 * 代际 guard 只拦“发起早于 pending”的 load；pending 之后、SW 落盘之前发起的 load
 * 快照与当前同代际，会带着删除前的旧 KV 结算——这里按在途备份补刀，堵住复活窗口：
 * - 组内部分在途：过滤掉在途 tab，其余变更正常应用；
 * - 整组在途软删（过滤后为空且 payload 非空）：组不进 active（pending 已放入误删视图）。
 */
export const stripInFlightTabs = (
  groups: TabGroup[],
  backups: OptimisticTabBackup[]
): TabGroup[] => {
  if (backups.length === 0) return groups;
  const pendingByGroup = new Map<string, Set<string>>();
  for (const b of backups) {
    const set = pendingByGroup.get(b.groupId) ?? new Set<string>();
    set.add(b.tabId);
    pendingByGroup.set(b.groupId, set);
  }
  const out: TabGroup[] = [];
  for (const g of groups) {
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

export type GroupLocalFields = { isFavorite?: boolean; notes?: string };

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

/** 写入前抓取本地偏好字段快照：只取本次实际要写的键（不写 isFavorite 就不还原它） */
export const snapshotGroupLocalFields = (
  groups: TabGroup[],
  groupId: string,
  fields: GroupLocalFields
): GroupLocalFields | null => {
  const group = groups.find(g => g.id === groupId);
  if (!group) return null;
  const snapshot: GroupLocalFields = {};
  if ('isFavorite' in fields) snapshot.isFavorite = !!group.isFavorite;
  if ('notes' in fields) snapshot.notes = group.notes;
  return snapshot;
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

/** 收藏/备注回滚：只还原快照里出现过的键 */
export const restoreGroupLocalFields = (
  group: TabGroup,
  snapshot: GroupLocalFields
): void => {
  if ('isFavorite' in snapshot) group.isFavorite = snapshot.isFavorite;
  if ('notes' in snapshot) group.notes = snapshot.notes;
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
