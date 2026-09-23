/**
 * 语义命令的纯函数核心（规格 §3.2 + §4.1/§5）：输入 groups 快照，输出新 groups。
 * 与 tabSlice 各 thunk 的存储写语义逐字段一致（阶段一行为保持）；
 * 纯函数无 IO，node:test 直测。阶段二统一加盖操作印记。
 *
 * stamp 盖印决策（§5.3 + P0-3）：
 * - 组级命令（saveGroup/deleteGroup/deleteAllGroups/restoreGroup/purgeGroup/
 *   renameGroup/toggleGroupLock/updateGroupFields/moveGroup/moveTab/importGroups/
 *   cleanDuplicates）→ 盖 group.lastOp = stamp
 * - 标签级命令（removeTab）→ 被墓碑 tab 盖 lastOp，且组 lastOp 同步提升
 *   （P0-3：digest 以单调 seq 为主信号，组 stamp 不动会让删 tab 在探活与合并时不可见）
 */
import type { TabGroup, Tab } from '../types/tab';
import type { OpStamp } from './opStamp';
import { shouldAutoDeleteAfterTabRemoval } from './tabGroupUtils';
import { updateDisplayOrder, updateGroupWithVersion } from './versionHelper';

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
 * removeTab 语义（= 现有 deleteTabAndSync thunk）：
 * 删除 tabId 后若组内无活跃 tab 且未锁定 → 整组软删墓碑；否则只墓碑该 tab。
 * 幂等：已删除的 tab 不重复处理（version 不膨胀）。
 *
 * 标签级删除同步提升组级印记（updatedAt/version/lastOp）：digest 以单调 seq 为主
 * 信号做探活，组 stamp 不动会导致“删 tab”在指纹层不可见；且合并时组字段按组
 * stamp 决胜——不盖组 stamp 会让对端稍新的组 stamp 把本次删除连带覆盖。
 */
export function applyRemoveTab(
  groups: TabGroup[],
  groupId: string,
  tabId: string,
  now: string,
  stamp: OpStamp
): { groups: TabGroup[]; group: TabGroup | null } {
  const idx = groups.findIndex(g => g.id === groupId);
  if (idx === -1) return { groups, group: null };
  const current = groups[idx];

  if (shouldAutoDeleteAfterTabRemoval(current, tabId)) {
    // 整组软删：这是组级删除语义（与 deleteGroup 同），所以组 lastOp 也要盖。
    const out = groups.map(g =>
      g.id === groupId && !g.isDeleted
        ? { ...g, isDeleted: true, lastOp: stamp, version: (g.version || 1) + 1, updatedAt: now }
        : g
    );
    return { groups: out, group: null };
  }

  const updatedTabs: Tab[] = current.tabs.map(tab =>
    tab.id === tabId && !tab.isDeleted ? { ...tab, isDeleted: true, lastOp: stamp, lastAccessed: now } : tab
  );
  // P0-3：标签级删除同样提升组级印记。digest 以单调 seq 为主信号做探活，
  // 组 stamp 不动会导致“删 tab”在指纹层不可见；且合并时组字段（name/lock 等）
  // 按组 stamp 决胜——不盖组 stamp 会让对端稍新的组 stamp 把本次删除连带覆盖。
  // 跨设备组名并发修改的冲突仍由全序 seq 比较裁决（后写赢），不靠“盖不盖”取巧。
  const updatedGroup: TabGroup = {
    ...current,
    tabs: updatedTabs,
    updatedAt: now,
    version: (current.version || 1) + 1,
    lastOp: stamp,
  };
  const out = [...groups];
  out[idx] = updatedGroup;
  return { groups: out, group: updatedGroup };
}

/** deleteGroup 语义（对应 tabSlice.deleteGroup）：软删墓碑，幂等（已墓碑不重复处理） */
export function applyDeleteGroup(
  groups: TabGroup[],
  groupId: string,
  now: string,
  stamp: OpStamp
): TabGroup[] {
  return groups.map(g =>
    g.id === groupId && !g.isDeleted
      ? { ...g, isDeleted: true, lastOp: stamp, version: (g.version || 1) + 1, updatedAt: now }
      : g
  );
}

/** deleteAllGroups 语义（对应 tabSlice.deleteAllGroups）：仅活跃组加墓碑；count = groups.length（与 thunk 口径一致） */
export function applyDeleteAllGroups(
  groups: TabGroup[],
  now: string,
  stamp: OpStamp
): { groups: TabGroup[]; count: number } {
  return {
    groups: groups.map(g =>
      g.isDeleted
        ? g
        : { ...g, isDeleted: true, lastOp: stamp, version: (g.version || 1) + 1, updatedAt: now }
    ),
    count: groups.length,
  };
}

/** restoreGroup 语义（对应 tabSlice.restoreGroup）：置回活跃 + version+1；restored=null 表示未找到 */
export function applyRestoreGroup(
  groups: TabGroup[],
  groupId: string,
  now: string,
  stamp: OpStamp
): { groups: TabGroup[]; restored: TabGroup | null } {
  const target = groups.find(g => g.id === groupId);
  if (!target) return { groups, restored: null };
  return {
    groups: groups.map(g =>
      g.id === groupId
        ? { ...g, isDeleted: false, lastOp: stamp, version: (target.version || 1) + 1, updatedAt: now }
        : g
    ),
    restored: {
      ...target,
      isDeleted: false,
      lastOp: stamp,
      version: (target.version || 1) + 1,
      updatedAt: now,
    },
  };
}

/** purgeGroup 语义（对应 tabSlice.purgeGroup）：物理移除（仅回收站场景）；stamp 参数保留以
 * 统一签名，但物理移除无实体承接 stamp——保留为调用方需要的"同一意图"语义。 */
export function applyPurgeGroup(
  groups: TabGroup[],
  groupId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 物理移除无实体可盖 stamp
  _now: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 同上
  _stamp: OpStamp
): TabGroup[] {
  return groups.filter(g => g.id !== groupId);
}

/** renameGroup 语义（对应 tabSlice.updateGroupNameAndSync）：
 * 走 updateGroupWithVersion（version+1），再覆写 updatedAt=now 保持与 thunk 现行语义一致
 * （versionHelper 内部固定使用 new Date().toISOString()，不接受 updatedAt 入参）。 */
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

/** toggleGroupLock 语义（对应 tabSlice.toggleGroupLockAndSync）：
 * 翻转 isLocked；同 updateGroupWithVersion 路径，并覆写 updatedAt=now。 */
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
 * 不应触发远端 version 噪声）。stage1 review fix：替代旧 persistGroupFields 直接写 storage
 * 的回归路径，单写者保证。
 *
 * 阶段二：仍然盖 stamp——本设备这次修改是意图，必须能被对端合并决胜（即便字段是本地偏好）。
 * _now 入参仅用于签名一致（本函数不使用）。
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

/** importGroups 语义（对应 tabSlice.importGroups）：新 id、URL 清洗、置顶按 createdAt DESC；
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

/** moveGroup 语义（对应 tabSlice.moveGroupAndSync）：索引非法返回 null
 * 被拖动组盖 stamp（这是用户主动排序意图） */
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

/** moveTab 语义（对应 tabSlice.moveTabAndSync）：跨组移空源组→墓碑（含空组自动删除判断）
 * 源组与目标组都盖 stamp（这是组级拖动意图）；跨组自动墓碑路径组 stamp 也由同一 stamp 覆盖。 */
export function applyMoveTab(
  groups: TabGroup[],
  args: { sourceGroupId: string; sourceIndex: number; targetGroupId: string; targetIndex: number },
  now: string,
  stamp: OpStamp
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
    ...g, tabs, updatedAt: now, version: (g.version || 1) + 1, lastOp: stamp,
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
        ? { ...g, isDeleted: true, lastOp: stamp, version: (g.version || 1) + 1, updatedAt: now }
        : g
    );
  }
  return { groups: out, autoDeletedGroupId };
}

/** cleanDuplicateTabs 语义（对应 tabSlice.cleanDuplicateTabs）：同 URL 留最新，余者墓碑；清空未锁定组→墓碑
 * 所有被墓碑实体盖同一 stamp——本设备一次 cleanDuplicates 是同一次清理意图。 */
export function applyCleanDuplicates(
  groups: TabGroup[],
  now: string,
  stamp: OpStamp
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
      tabs: g.tabs.map(t => (ids.has(t.id) && !t.isDeleted ? { ...t, isDeleted: true, lastOp: stamp, lastAccessed: now } : t)),
      updatedAt: now,
      version: (g.version || 1) + 1,
      lastOp: stamp,
    };
  });

  const finalGroups = withTombstones.map(g => {
    const hasActive = g.tabs.some(t => !t.isDeleted);
    if (!hasActive && !g.isLocked && !g.isDeleted) {
      removedGroupsCount++;
      return { ...g, isDeleted: true, lastOp: stamp, version: (g.version || 1) + 1, updatedAt: now };
    }
    return g;
  });

  return { groups: finalGroups, removedTabsCount, removedGroupsCount };
}