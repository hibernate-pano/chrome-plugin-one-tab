/**
 * 语义命令的纯函数核心（规格 §3.2）：输入 groups 快照，输出新 groups。
 * 与 tabSlice 各 thunk 的存储写语义逐字段一致（阶段一行为保持）；
 * 纯函数无 IO，node:test 直测。阶段二在此统一加盖操作印记。
 */
import type { TabGroup, Tab } from '@/types/tab';
import { shouldAutoDeleteAfterTabRemoval } from '@/utils/tabGroupUtils';
import { updateGroupWithVersion } from '@/utils/versionHelper';

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
