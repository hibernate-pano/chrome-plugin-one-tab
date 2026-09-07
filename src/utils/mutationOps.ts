/**
 * 语义命令的纯函数核心（规格 §3.2）：输入 groups 快照，输出新 groups。
 * 与 tabSlice 各 thunk 的存储写语义逐字段一致（阶段一行为保持）；
 * 纯函数无 IO，node:test 直测。阶段二在此统一加盖操作印记。
 */
import type { TabGroup, Tab } from '@/types/tab';
import { shouldAutoDeleteAfterTabRemoval } from '@/utils/tabGroupUtils';

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
