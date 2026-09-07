/**
 * 语义命令的纯函数核心（规格 §3.2）：输入 groups 快照，输出新 groups。
 * 与 tabSlice 各 thunk 的存储写语义逐字段一致（阶段一行为保持）；
 * 纯函数无 IO，node:test 直测。阶段二在此统一加盖操作印记。
 */
import type { TabGroup, Tab } from '@/types/tab';
import { shouldAutoDeleteAfterTabRemoval } from '@/utils/tabGroupUtils';
import { updateDisplayOrder, updateGroupWithVersion } from '@/utils/versionHelper';

/** saveGroup 语义（tabSlice.ts:58）：新组置顶，按 createdAt 倒序 */
export function applySaveGroup(groups: TabGroup[], group: TabGroup, _now: string): TabGroup[] {
  return [group, ...groups].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

/**
 * removeTab 语义（= 现有 deleteTabAndSync thunk，tabSlice.ts:1021）：
 * 删除 tabId 后若组内无活跃 tab 且未锁定 → 整组软删墓碑；否则只墓碑该 tab。
 * 幂等：已删除的 tab 不重复处理（version 不膨胀）。
 */
export function applyRemoveTab(
  groups: TabGroup[],
  groupId: string,
  tabId: string,
  now: string
): { groups: TabGroup[]; group: TabGroup | null } {
  const idx = groups.findIndex(g => g.id === groupId);
  if (idx === -1) return { groups, group: null };
  const current = groups[idx];

  if (shouldAutoDeleteAfterTabRemoval(current, tabId)) {
    const out = groups.map(g =>
      g.id === groupId && !g.isDeleted
        ? { ...g, isDeleted: true, version: (g.version || 1) + 1, updatedAt: now }
        : g
    );
    return { groups: out, group: null };
  }

  const updatedTabs: Tab[] = current.tabs.map(tab =>
    tab.id === tabId && !tab.isDeleted ? { ...tab, isDeleted: true, lastAccessed: now } : tab
  );
  const updatedGroup: TabGroup = {
    ...current,
    tabs: updatedTabs,
    updatedAt: now,
    version: (current.version || 1) + 1,
  };
  const out = [...groups];
  out[idx] = updatedGroup;
  return { groups: out, group: updatedGroup };
}

/** deleteGroup 语义（tabSlice.ts:112）：软删墓碑，幂等（已墓碑不重复处理） */
export function applyDeleteGroup(groups: TabGroup[], groupId: string, now: string): TabGroup[] {
  return groups.map(g =>
    g.id === groupId && !g.isDeleted
      ? { ...g, isDeleted: true, version: (g.version || 1) + 1, updatedAt: now }
      : g
  );
}

/** deleteAllGroups 语义（tabSlice.ts:140）：仅活跃组加墓碑；count = groups.length（与 thunk 口径一致） */
export function applyDeleteAllGroups(
  groups: TabGroup[],
  now: string
): { groups: TabGroup[]; count: number } {
  return {
    groups: groups.map(g => (g.isDeleted ? g : { ...g, isDeleted: true, version: (g.version || 1) + 1, updatedAt: now })),
    count: groups.length,
  };
}

/** restoreGroup 语义（tabSlice.ts:172）：置回活跃 + version+1；restored=null 表示未找到 */
export function applyRestoreGroup(
  groups: TabGroup[],
  groupId: string,
  now: string
): { groups: TabGroup[]; restored: TabGroup | null } {
  const target = groups.find(g => g.id === groupId);
  if (!target) return { groups, restored: null };
  return {
    groups: groups.map(g =>
      g.id === groupId ? { ...g, isDeleted: false, version: (target.version || 1) + 1, updatedAt: now } : g
    ),
    restored: { ...target, isDeleted: false, version: (target.version || 1) + 1, updatedAt: now },
  };
}

/** purgeGroup 语义（tabSlice.ts:203）：物理移除（仅回收站场景） */
export function applyPurgeGroup(groups: TabGroup[], groupId: string): TabGroup[] {
  return groups.filter(g => g.id !== groupId);
}

/** renameGroup 语义（updateGroupNameAndSync，tabSlice.ts:251）：
 * 走 updateGroupWithVersion（version+1），再覆写 updatedAt=now 保持与 thunk 现行语义一致
 * （versionHelper 内部固定使用 new Date().toISOString()，不接受 updatedAt 入参）。 */
export function applyRenameGroup(
  groups: TabGroup[],
  groupId: string,
  name: string,
  now: string
): { groups: TabGroup[]; renamed: TabGroup | null } {
  let renamed: TabGroup | null = null;
  const out = groups.map(g => {
    if (g.id !== groupId) return g;
    const updated = updateGroupWithVersion(g, { name });
    renamed = { ...updated, updatedAt: now };
    return renamed;
  });
  return { groups: out, renamed };
}

/** toggleGroupLock 语义（toggleGroupLockAndSync，tabSlice.ts:282）：
 * 翻转 isLocked；同 updateGroupWithVersion 路径，并覆写 updatedAt=now。 */
export function applyToggleGroupLock(
  groups: TabGroup[],
  groupId: string,
  now: string
): { groups: TabGroup[]; isLocked: boolean | null } {
  const group = groups.find(g => g.id === groupId);
  if (!group) return { groups, isLocked: null };
  const updated = updateGroupWithVersion(group, { isLocked: !group.isLocked });
  const withStamp = { ...updated, updatedAt: now };
  return { groups: groups.map(g => (g.id === groupId ? withStamp : g)), isLocked: withStamp.isLocked };
}

/**
 * updateGroupFields 语义（持久化 isFavorite/notes 等本地 UI 偏好）：
 * 仅覆写传入字段；【不】bump version/updatedAt（这些字段不在云端 sync 范围内，
 * 不应触发远端 version 噪声）。stage1 review fix：替代旧 persistGroupFields 直接写 storage
 * 的回归路径，单写者保证。
 * _now 入参仅用于签名一致（本函数不使用，避免与其他 apply* 形参形状不齐）。
 */
export function applyUpdateGroupFields(
  groups: TabGroup[],
  groupId: string,
  fields: { isFavorite?: boolean; notes?: string },
  _now: string
): { groups: TabGroup[]; updated: TabGroup | null } {
  const target = groups.find(g => g.id === groupId);
  if (!target) return { groups, updated: null };
  const updated: TabGroup = { ...target, ...fields };
  return { groups: groups.map(g => (g.id === groupId ? updated : g)), updated };
}

/** importGroups 语义（tabSlice.ts:219）：新 id、URL 清洗、置顶按 createdAt DESC；
 * genId/sanitizeUrl 注入便于测试。 */
export function applyImportGroups(
  groups: TabGroup[],
  incoming: TabGroup[],
  deps: { genId: () => string; sanitizeUrl: (url: string) => string | null },
  _now: string
): { groups: TabGroup[]; imported: TabGroup[] } {
  const processed = incoming.map(group => ({
    ...group,
    id: deps.genId(),
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

/** moveGroup 语义（moveGroupAndSync，tabSlice.ts:316）：索引非法返回 null */
export function applyMoveGroup(
  groups: TabGroup[],
  dragIndex: number,
  hoverIndex: number
): TabGroup[] | null {
  if (dragIndex < 0 || dragIndex >= groups.length || hoverIndex < 0 || hoverIndex >= groups.length) {
    return null;
  }
  const newGroups = [...groups];
  const [dragGroup] = newGroups.splice(dragIndex, 1);
  newGroups.splice(hoverIndex, 0, dragGroup);
  return updateDisplayOrder(newGroups);
}

/** moveTab 语义（moveTabAndSync，tabSlice.ts:511）：跨组移空源组→墓碑（含空组自动删除判断） */
export function applyMoveTab(
  groups: TabGroup[],
  args: { sourceGroupId: string; sourceIndex: number; targetGroupId: string; targetIndex: number },
  now: string
): { groups: TabGroup[]; autoDeletedGroupId: string | null } {
  const source = groups.find(g => g.id === args.sourceGroupId);
  const target = groups.find(g => g.id === args.targetGroupId);
  if (!source || !target) return { groups, autoDeletedGroupId: null };
  const tab = source.tabs[args.sourceIndex];
  if (!tab) return { groups, autoDeletedGroupId: null };

  const newSourceTabs = [...source.tabs];
  const newTargetTabs = args.sourceGroupId === args.targetGroupId ? newSourceTabs : [...target.tabs];
  newSourceTabs.splice(args.sourceIndex, 1);
  const adjusted = Math.max(0, Math.min(args.targetIndex, newTargetTabs.length));
  newTargetTabs.splice(adjusted, 0, tab);

  const bump = (g: TabGroup, tabs: Tab[]): TabGroup => ({
    ...g, tabs, updatedAt: now, version: (g.version || 1) + 1,
  });

  let out = groups.map(g => {
    if (g.id === args.sourceGroupId) return bump(g, newSourceTabs);
    if (g.id === args.targetGroupId) return bump(g, newTargetTabs);
    return g;
  });

  let autoDeletedGroupId: string | null = null;
  const movedSource = out.find(g => g.id === args.sourceGroupId)!;
  if (args.sourceGroupId !== args.targetGroupId && movedSource.tabs.length === 0
      && shouldAutoDeleteAfterTabRemoval(movedSource, '')) {
    autoDeletedGroupId = args.sourceGroupId;
    out = out.map(g =>
      g.id === args.sourceGroupId && !g.isDeleted
        ? { ...g, isDeleted: true, version: (g.version || 1) + 1, updatedAt: now }
        : g
    );
  }
  return { groups: out, autoDeletedGroupId };
}

/** cleanDuplicateTabs 语义（tabSlice.ts:380）：同 URL 留最新，余者墓碑；清空未锁定组→墓碑 */
export function applyCleanDuplicates(
  groups: TabGroup[],
  now: string
): { groups: TabGroup[]; removedTabsCount: number; removedGroupsCount: number } {
  let removedTabsCount = 0;
  const urlMap = new Map<string, { tab: Tab; groupId: string }[]>();
  groups.forEach(group => {
    group.tabs.forEach(tab => {
      if (tab.isDeleted) return;
      if (!tab.url) return;
      const key = tab.url.startsWith('loading://') ? `${tab.url}|${tab.title}` : tab.url;
      if (!urlMap.has(key)) urlMap.set(key, []);
      urlMap.get(key)!.push({ tab, groupId: group.id });
    });
  });

  const tombstoned = new Map<string, Set<string>>(); // groupId -> 待墓碑 tabId 集
  urlMap.forEach(list => {
    if (list.length <= 1) return;
    const sorted = [...list].sort(
      (a, b) => new Date(b.tab.lastAccessed).getTime() - new Date(a.tab.lastAccessed).getTime()
    );
    for (let i = 1; i < sorted.length; i++) {
      const { groupId, tab } = sorted[i];
      if (!tombstoned.has(groupId)) tombstoned.set(groupId, new Set());
      tombstoned.get(groupId)!.add(tab.id);
      removedTabsCount++;
    }
  });

  let removedGroupsCount = 0;
  const withTombstones = groups.map(g => {
    const ids = tombstoned.get(g.id);
    if (!ids) return g;
    return {
      ...g,
      tabs: g.tabs.map(t => (ids.has(t.id) && !t.isDeleted ? { ...t, isDeleted: true, lastAccessed: now } : t)),
      updatedAt: now,
      version: (g.version || 1) + 1,
    };
  });

  const finalGroups = withTombstones.map(g => {
    const hasActive = g.tabs.some(t => !t.isDeleted);
    if (!hasActive && !g.isLocked && !g.isDeleted) {
      removedGroupsCount++;
      return { ...g, isDeleted: true, version: (g.version || 1) + 1, updatedAt: now };
    }
    return g;
  });

  return { groups: finalGroups, removedTabsCount, removedGroupsCount };
}
