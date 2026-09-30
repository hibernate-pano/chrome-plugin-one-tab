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
