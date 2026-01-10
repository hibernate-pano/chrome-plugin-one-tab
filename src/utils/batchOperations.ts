import { Tab, TabGroup } from '@/types/tab';
import { storage } from '@/utils/storage';

export type BatchAction = 'delete' | 'move' | 'export' | 'lock' | 'unlock';

export interface BatchOperation {
  tabs: Array<{ tabId: string; groupId: string }>;
  groups: string[];
  action: BatchAction;
  targetGroupId?: string;
}

export interface BatchResult {
  success: boolean;
  modifiedTabs: number;
  modifiedGroups: number;
  error?: string;
}

export async function executeBatchOperation(operation: BatchOperation): Promise<BatchResult> {
  const { tabs, groups, action } = operation;

  try {
    const allGroups = await storage.getGroups();

    switch (action) {
      case 'delete':
        return await batchDelete(allGroups, tabs, groups);

      case 'move':
        return await batchMove(allGroups, tabs, operation.targetGroupId || '');

      case 'export':
        return await batchExport(allGroups, tabs, groups);

      case 'lock':
        return await batchToggleLock(allGroups, groups, true);

      case 'unlock':
        return await batchToggleLock(allGroups, groups, false);

      default:
        return {
          success: false,
          modifiedTabs: 0,
          modifiedGroups: 0,
          error: '未知操作',
        };
    }
  } catch (error) {
    console.error('批量操作失败:', error);
    return {
      success: false,
      modifiedTabs: 0,
      modifiedGroups: 0,
      error: error instanceof Error ? error.message : '未知错误',
    };
  }
}

async function batchDelete(
  groups: TabGroup[],
  tabs: Array<{ tabId: string; groupId: string }>,
  groupIds: string[]
): Promise<BatchResult> {
  let modifiedTabs = 0;
  let modifiedGroups = 0;
  const updatedGroups = groups.map(group => {
    if (groupIds.includes(group.id)) {
      modifiedGroups++;
      return { ...group, isDeleted: true };
    }

    const groupTabIds = tabs.filter(t => t.groupId === group.id).map(t => t.tabId);

    if (groupTabIds.length > 0) {
      const updatedTabs = group.tabs.filter(tab => !groupTabIds.includes(tab.id));
      modifiedTabs += groupTabIds.length;
      return { ...group, tabs: updatedTabs };
    }

    return group;
  });

  await storage.setGroups(updatedGroups);

  return { success: true, modifiedTabs, modifiedGroups };
}

async function batchMove(
  groups: TabGroup[],
  tabs: Array<{ tabId: string; groupId: string }>,
  targetGroupId: string
): Promise<BatchResult> {
  if (!targetGroupId) {
    return {
      success: false,
      modifiedTabs: 0,
      modifiedGroups: 0,
      error: '未指定目标标签组',
    };
  }

  const targetGroup = groups.find(g => g.id === targetGroupId);

  if (!targetGroup) {
    return {
      success: false,
      modifiedTabs: 0,
      modifiedGroups: 0,
      error: '目标标签组不存在',
    };
  }

  const tabsByGroup = new Map<string, Tab[]>();
  tabs.forEach(({ tabId, groupId }) => {
    if (!tabsByGroup.has(groupId)) {
      tabsByGroup.set(groupId, []);
    }
    tabsByGroup.get(groupId)!.push({ id: tabId } as Tab);
  });

  const updatedGroups = groups.map(group => {
    const tabsToMove = tabsByGroup.get(group.id);

    if (!tabsToMove) return group;

    const updatedGroupTabs = group.tabs.filter(tab => !tabsToMove.some(t => t.id === tab.id));

    return { ...group, tabs: updatedGroupTabs };
  });

  const updatedTargetIndex = updatedGroups.findIndex(g => g.id === targetGroupId);
  const movedTabs = tabs.map(({ tabId, groupId }) => {
    const sourceGroup = groups.find(g => g.id === groupId);
    const tab = sourceGroup?.tabs.find(t => t.id === tabId);
    return tab || ({ id: tabId } as Tab);
  });

  updatedGroups[updatedTargetIndex] = {
    ...targetGroup,
    tabs: [...targetGroup.tabs, ...movedTabs],
  };

  await storage.setGroups(updatedGroups);

  return { success: true, modifiedTabs: tabs.length, modifiedGroups: 0 };
}

async function batchExport(
  groups: TabGroup[],
  tabs: Array<{ tabId: string; groupId: string }>,
  groupIds: string[]
): Promise<BatchResult> {
  const selectedGroups = groups.filter(
    g => groupIds.includes(g.id) || tabs.some(t => t.groupId === g.id)
  );

  if (selectedGroups.length === 0) {
    return {
      success: false,
      modifiedTabs: 0,
      modifiedGroups: 0,
      error: '没有选择要导出的内容',
    };
  }

  const data = await storage.exportData();
  const filteredData = {
    ...data,
    data: {
      ...data.data,
      groups: selectedGroups,
    },
  };

  const blob = new Blob([JSON.stringify(filteredData, null, 2)], {
    type: 'application/json',
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tabvault-export-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  return { success: true, modifiedTabs: 0, modifiedGroups: selectedGroups.length };
}

async function batchToggleLock(
  groups: TabGroup[],
  groupIds: string[],
  locked: boolean
): Promise<BatchResult> {
  const updatedGroups = groups.map(group => {
    if (groupIds.includes(group.id)) {
      return { ...group, isLocked: locked };
    }
    return group;
  });

  await storage.setGroups(updatedGroups);

  return { success: true, modifiedTabs: 0, modifiedGroups: groupIds.length };
}

export function getSelectedTabsCount(tabs: Array<{ tabId: string; groupId: string }>): number {
  return tabs.length;
}

export function getSelectedGroupsCount(groupIds: string[]): number {
  return groupIds.length;
}

export function getAffectedGroups(
  groups: TabGroup[],
  tabs: Array<{ tabId: string; groupId: string }>,
  groupIds: string[]
): TabGroup[] {
  const affectedGroupIds = new Set([...groupIds, ...tabs.map(t => t.groupId)]);

  return groups.filter(g => affectedGroupIds.has(g.id));
}
