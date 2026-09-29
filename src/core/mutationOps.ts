/**
 * 语义命令的纯函数核心：输入 groups 快照，输出新 groups。
 * 纯函数无 IO，node:test 直测。
 *
 * ── 2026-09-29 删除语义重写：无墓碑（奥卡姆剃刀，产品拍板）──
 *
 * 旧模型（v1.21.0–1.21.7）：删除盖墓碑（组级 isDeleted / tab 级 isDeleted），
 * 靠墓碑做「7 天回收站」与「跨设备删除广播」。实践暴露的根因级问题：
 * 墓碑只增不减（tab 墓碑永久留在组内）→ 计数虚高、恢复不完整、URL 去重坟场、
 * 空壳清理补丁层层叠加。
 *
 * 新模型：
 * - **本地删除一律物理移除**。删除前由 UI 确认（confirmBeforeDelete / 删除全部强制确认）。
 * - **跨设备删除广播只剩一个载体：云端行的 is_deleted 标记**。
 *   组删除 → 本地物理删 + pendingDeleteIds 队列 → upload 时 markCloudGroupsAsDeleted
 *   （UPDATE is_deleted=true，行保留）→ 对端下载合并时服从（见 opStampMerge）。
 *   tab 删除 → 物理移除 + 组 stamp 提升 → 整组行上传覆盖（组级 LWW，无 tab 级合并）。
 * - 读取防御：老版本设备（商店 1.21.4）仍会写入墓碑形状数据，读路径统一剥离
 *   （tabSlice.toActiveGroupsView / download 归一化），本文件写路径永远产出干净数据。
 */
import type { TabGroup, Tab } from '../types/tab';
import type { OpStamp } from './opStamp';
import { shouldAutoDeleteAfterTabRemoval } from './tabGroupUtils';
import { updateDisplayOrder, updateGroupWithVersion } from './versionHelper';

/**
 * 空组判据（v1.21.5 拍板沿用）：组内没有标签且未锁定。
 * 锁定组豁免——锁定是用户显式的防误删保护，任何自动清理都不得越过。
 * 判据复用 tabGroupUtils.shouldAutoDeleteAfterTabRemoval（其内部跳过 isDeleted tab，
 * 对老版本写入的墓碑形状数据保持防御），规则只此一处。
 */
export const isEmptyGroup = (group: TabGroup): boolean =>
  shouldAutoDeleteAfterTabRemoval(group, '');

/** 合并/导入结果的统一兜底：剔除空组（无内容可恢复，物理移除）。 */
export const dropEmptyGroups = (groups: TabGroup[]): TabGroup[] =>
  groups.filter(g => !isEmptyGroup(g));

/** 本次操作中被物理删除的组 id（供调用方登记云端删除广播队列）。 */
export const removedGroupIds = (before: TabGroup[], after: TabGroup[]): string[] => {
  const kept = new Set(after.map(g => g.id));
  return before.filter(g => !kept.has(g.id)).map(g => g.id);
};

/** saveGroup 语义（对应 tabSlice.saveGroup）：新组置顶，按 createdAt 倒序 */
export function applySaveGroup(
  groups: TabGroup[],
  group: TabGroup,
  _now: string,
  stamp: OpStamp
): TabGroup[] {
  return [{ ...group, lastOp: stamp }, ...groups].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

/**
 * removeTab 语义（= deleteTabAndSync thunk）：
 * 物理**移除该 tab**；组内无剩余标签且未锁定 → 整组物理移除
 * （删除意图由调用方经 pendingDeleteIds 广播，见文件头）。
 * 幂等：tab 不存在时原样返回（version 不膨胀）。
 */
export function applyRemoveTab(
  groups: TabGroup[],
  groupId: string,
  tabId: string,
  now: string,
  stamp: OpStamp
): { groups: TabGroup[]; group: TabGroup | null; removedGroupId: string | null } {
  const idx = groups.findIndex(g => g.id === groupId);
  if (idx === -1) return { groups, group: null, removedGroupId: null };
  const current = groups[idx];
  const tabIndex = current.tabs.findIndex(t => t.id === tabId);
  if (tabIndex === -1) return { groups, group: null, removedGroupId: null };

  const remainingTabs = current.tabs.filter(t => t.id !== tabId);
  if (shouldAutoDeleteAfterTabRemoval(current, tabId)) {
    // 拿空最后一个（活跃）标签 → 整组物理移除（无内容可保留）。
    // 判据走 shouldAutoDeleteAfterTabRemoval（跳过 isDeleted tab）：老版本残留的
    // 墓碑 tab 不算内容，最后一个活跃 tab 被删时整组连同残留一并清掉。
    return {
      groups: groups.filter(g => g.id !== groupId),
      group: null,
      removedGroupId: groupId,
    };
  }

  const updatedGroup: TabGroup = {
    ...current,
    tabs: remainingTabs,
    updatedAt: now,
    version: (current.version || 1) + 1,
    lastOp: stamp,
  };
  const out = [...groups];
  out[idx] = updatedGroup;
  return { groups: out, group: updatedGroup, removedGroupId: null };
}

/**
 * deleteGroup 语义（= deleteGroup thunk）：物理移除。幂等（组不存在原样返回）。
 */
export function applyDeleteGroup(
  groups: TabGroup[],
  groupId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 物理移除无实体可盖 stamp（签名与其它 apply* 一致）
  _now: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 同上
  _stamp: OpStamp
): { groups: TabGroup[]; removedGroupId: string | null } {
  const target = groups.find(g => g.id === groupId);
  if (!target) return { groups, removedGroupId: null };
  return { groups: groups.filter(g => g.id !== groupId), removedGroupId: groupId };
}

/** deleteAllGroups 语义：全部物理移除。count = groups.length（与 thunk 口径一致）。 */
export function applyDeleteAllGroups(
  groups: TabGroup[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 物理移除无实体可盖 stamp（签名与其它 apply* 一致）
  _now: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 同上
  _stamp: OpStamp
): { groups: TabGroup[]; count: number; removedGroupIds: string[] } {
  return {
    groups: [],
    count: groups.length,
    removedGroupIds: groups.map(g => g.id),
  };
}

/** renameGroup 语义（= updateGroupNameAndSync thunk）：走 updateGroupWithVersion（version+1）。 */
export function applyRenameGroup(
  groups: TabGroup[],
  groupId: string,
  name: string,
  now: string,
  stamp: OpStamp
): { groups: TabGroup[]; renamed: TabGroup | null } {
  let renamed: TabGroup | null = null;
  const out = groups.map(g => {
    if (g.id !== groupId) return g;
    const updated = updateGroupWithVersion(g, { name });
    renamed = { ...updated, updatedAt: now, lastOp: stamp };
    return renamed;
  });
  return { groups: out, renamed };
}

/** toggleGroupLock 语义（= toggleGroupLockAndSync thunk）：翻转 isLocked + stamp 提升。 */
export function applyToggleGroupLock(
  groups: TabGroup[],
  groupId: string,
  now: string,
  stamp: OpStamp
): { groups: TabGroup[]; isLocked: boolean | null } {
  const group = groups.find(g => g.id === groupId);
  if (!group) return { groups, isLocked: null };
  const updated = updateGroupWithVersion(group, { isLocked: !group.isLocked });
  const withStamp = { ...updated, updatedAt: now, lastOp: stamp };
  return { groups: groups.map(g => (g.id === groupId ? withStamp : g)), isLocked: withStamp.isLocked };
}

/**
 * updateGroupFields 语义（持久化 isFavorite/notes 等本地 UI 偏好）：
 * 仅覆写传入字段；【不】bump version/updatedAt（这些字段不在云端 sync 范围内，
 * 不应触发远端 version 噪声）。
 * 仍盖 stamp——本设备这次修改是意图，必须能被对端合并决胜（即便字段是本地偏好）。
 */
export function applyUpdateGroupFields(
  groups: TabGroup[],
  groupId: string,
  fields: { isFavorite?: boolean; notes?: string },
  _now: string,
  stamp: OpStamp
): { groups: TabGroup[]; updated: TabGroup | null } {
  const target = groups.find(g => g.id === groupId);
  if (!target) return { groups, updated: null };
  const updated: TabGroup = { ...target, ...fields, lastOp: stamp };
  return { groups: groups.map(g => (g.id === groupId ? updated : g)), updated };
}

/** importGroups 语义（= importGroups thunk）：新 id、URL 清洗、置顶按 createdAt DESC。
 * genId/sanitizeUrl 注入便于测试。所有导入组盖统一 stamp——它们属于同一次导入意图。 */
export function applyImportGroups(
  groups: TabGroup[],
  incoming: TabGroup[],
  deps: { genId: () => string; sanitizeUrl: (url: string) => string | null },
  _now: string,
  stamp: OpStamp
): { groups: TabGroup[]; imported: TabGroup[] } {
  const processed = incoming.map(group => ({
    ...group,
    id: deps.genId(),
    lastOp: stamp,
    tabs: group.tabs.reduce<Tab[]>((acc, tab) => {
      const url = deps.sanitizeUrl(tab.url);
      if (!url) return acc;
      acc.push({ ...tab, url, id: deps.genId() });
      return acc;
    }, []),
  }));
  return {
    groups: [...processed, ...groups].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    ),
    imported: processed,
  };
}

/** moveGroup 语义（= moveGroupAndSync thunk）：索引非法返回 null；被拖动组盖 stamp。 */
export function applyMoveGroup(
  groups: TabGroup[],
  dragIndex: number,
  hoverIndex: number,
  stamp: OpStamp
): TabGroup[] | null {
  if (dragIndex < 0 || dragIndex >= groups.length || hoverIndex < 0 || hoverIndex >= groups.length) {
    return null;
  }
  const newGroups = [...groups];
  const [dragGroup] = newGroups.splice(dragIndex, 1);
  newGroups.splice(hoverIndex, 0, dragGroup);
  return updateDisplayOrder(newGroups).map(g =>
    g.id === dragGroup.id ? { ...g, lastOp: stamp } : g
  );
}

/** moveTab 语义（= moveTabAndSync thunk）：物理移动；跨组移空源组 → 整组物理移除。 */
export function applyMoveTab(
  groups: TabGroup[],
  args: { sourceGroupId: string; sourceIndex: number; targetGroupId: string; targetIndex: number },
  now: string,
  stamp: OpStamp
): { groups: TabGroup[]; removedGroupId: string | null } {
  const source = groups.find(g => g.id === args.sourceGroupId);
  const target = groups.find(g => g.id === args.targetGroupId);
  if (!source || !target) return { groups, removedGroupId: null };
  const tab = source.tabs[args.sourceIndex];
  if (!tab) return { groups, removedGroupId: null };

  const newSourceTabs = [...source.tabs];
  const newTargetTabs = args.sourceGroupId === args.targetGroupId ? newSourceTabs : [...target.tabs];
  newSourceTabs.splice(args.sourceIndex, 1);
  const adjusted = Math.max(0, Math.min(args.targetIndex, newTargetTabs.length));
  newTargetTabs.splice(adjusted, 0, tab);

  const bump = (g: TabGroup, tabs: Tab[]): TabGroup => ({
    ...g, tabs, updatedAt: now, version: (g.version || 1) + 1, lastOp: stamp,
  });

  let out = groups.map(g => {
    if (g.id === args.sourceGroupId) return bump(g, newSourceTabs);
    if (g.id === args.targetGroupId) return bump(g, newTargetTabs);
    return g;
  });

  let removedGroupId: string | null = null;
  const movedSource = out.find(g => g.id === args.sourceGroupId)!;
  if (args.sourceGroupId !== args.targetGroupId && isEmptyGroup(movedSource)) {
    // 源组被搬空 → 物理移除
    removedGroupId = args.sourceGroupId;
    out = out.filter(g => g.id !== args.sourceGroupId);
  }
  return { groups: out, removedGroupId };
}

/** cleanDuplicateTabs 语义（= cleanDuplicateTabs thunk）：同 URL 留最新，余者物理移除；
 * 被清空且未锁定的组整组物理移除。去重范围 = 全部组（物理模型下不存在墓碑组）。 */
export function applyCleanDuplicates(
  groups: TabGroup[],
  now: string,
  stamp: OpStamp
): { groups: TabGroup[]; removedTabsCount: number; removedGroupsCount: number; removedGroupIds: string[] } {
  let removedTabsCount = 0;
  const urlMap = new Map<string, { tab: Tab; groupId: string }[]>();
  groups.forEach(group => {
    group.tabs.forEach(tab => {
      if (!tab.url) return;
      const key = tab.url.startsWith('loading://') ? `${tab.url}|${tab.title}` : tab.url;
      if (!urlMap.has(key)) urlMap.set(key, []);
      urlMap.get(key)!.push({ tab, groupId: group.id });
    });
  });

  const toRemove = new Map<string, Set<string>>(); // groupId -> 待移除 tabId 集
  urlMap.forEach(list => {
    if (list.length <= 1) return;
    const sorted = [...list].sort(
      (a, b) => new Date(b.tab.lastAccessed).getTime() - new Date(a.tab.lastAccessed).getTime()
    );
    for (let i = 1; i < sorted.length; i++) {
      const { groupId, tab } = sorted[i];
      if (!toRemove.has(groupId)) toRemove.set(groupId, new Set());
      toRemove.get(groupId)!.add(tab.id);
      removedTabsCount++;
    }
  });

  let removedGroupsCount = 0;
  const withRemovals = groups.map(g => {
    const ids = toRemove.get(g.id);
    if (!ids) return g;
    return {
      ...g,
      tabs: g.tabs.filter(t => !ids.has(t.id)),
      updatedAt: now,
      version: (g.version || 1) + 1,
      lastOp: stamp,
    };
  });

  const finalGroups = withRemovals.filter(g => {
    if (isEmptyGroup(g)) {
      removedGroupsCount++;
      return false;
    }
    return true;
  });

  const kept = new Set(finalGroups.map(g => g.id));
  const removedGroupIds = withRemovals.filter(g => !kept.has(g.id)).map(g => g.id);

  return { groups: finalGroups, removedTabsCount, removedGroupsCount, removedGroupIds };
}
