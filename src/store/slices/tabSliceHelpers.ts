/**
 * P0 手术 · tabSlice 纯函数抽离（行为零变化）。
 * 回环过滤 / 代际 guard / 墓碑过滤均为纯函数（仅依赖 TabState/TabGroup 类型），
 * 与 Redux 样板分离，便于单测直测与后续 syncEngine 收口。
 */
import type { TabGroup, TabState, OptimisticTabBackup } from '@/types/tab';
import { shouldAutoDeleteAfterTabRemoval } from '@/core/tabGroupUtils';

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
 * 剔除组级墓碑 + 组内标签级墓碑 + 空壳会话。所有把 storage 数据灌回 state.groups
 * 的路径（loadGroups / cleanDuplicateTabs.fulfilled 等）必须经此管线，否则墓碑组与
 * 墓碑 tab 涌入主状态——TabCounter/渲染不过滤墓碑，计数会反增、回收站内容泄漏。
 * 排序由调用方自理（loadGroups 按 createdAt 倒序；fulfilled 沿用 storage 序）。
 *
 * 【空壳会话必须熄掉】组内标签被非 moveTab 路径清空时（同步合并把远端删除意图
 * 落成本地 tab 墓碑、云端删光整组、URL 去重败者盖墓碑），组级墓碑不会置位，
 * stripTombstonedTabs 剥完标签级墓碑就剩一个 tabs: [] 的空壳，会在列表里渲染成
 * 一张空会话卡且永远不消失——用户看到的"凭空多出的空标签组"。
 * 判据复用 moveTab reducer 既有的 shouldAutoDeleteAfterTabRemoval（锁定组豁免，
 * 用户显式保护的会话不静默隐藏），规则只此一处。
 * 只过滤视图、不写 storage：读路径绝不产生写（v1.21.2 墓碑灌入事故的教训），
 * 空壳本身没有可恢复的标签内容，storage 保留原样由同步语义自行裁决。
 */
export const toActiveGroupsView = (groups: TabGroup[]): TabGroup[] =>
  groups
    .filter(g => !g.isDeleted)
    .map(stripTombstonedTabs)
    .filter(g => !shouldAutoDeleteAfterTabRemoval(g, ''));
