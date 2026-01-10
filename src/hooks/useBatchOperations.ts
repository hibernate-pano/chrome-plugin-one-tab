/**
 * 批量操作 Hook
 * 提供标签页和标签组的批量选择和操作功能
 */

import { useState, useCallback, useMemo } from 'react';
import { TabGroup, Tab } from '@/types/tab';

export interface BatchSelection {
  // 选中的标签页 ID 集合（格式：groupId:tabId）
  selectedTabs: Set<string>;
  // 选中的标签组 ID 集合
  selectedGroups: Set<string>;
}

export interface BatchOperationsHook {
  // 选择状态
  selection: BatchSelection;
  isSelectionMode: boolean;

  // 选中数量
  selectedTabCount: number;
  selectedGroupCount: number;

  // 切换选择模式
  toggleSelectionMode: () => void;
  exitSelectionMode: () => void;

  // 标签页选择操作
  selectTab: (groupId: string, tabId: string) => void;
  deselectTab: (groupId: string, tabId: string) => void;
  toggleTabSelection: (groupId: string, tabId: string) => void;
  isTabSelected: (groupId: string, tabId: string) => boolean;

  // 标签组选择操作
  selectGroup: (groupId: string) => void;
  deselectGroup: (groupId: string) => void;
  toggleGroupSelection: (groupId: string) => void;
  isGroupSelected: (groupId: string) => boolean;

  // 批量选择
  selectAllTabs: (groups: TabGroup[]) => void;
  deselectAll: () => void;
  selectAllInGroup: (group: TabGroup) => void;

  // 获取选中项
  getSelectedTabs: (groups: TabGroup[]) => Array<{ group: TabGroup; tab: Tab }>;
  getSelectedGroups: (groups: TabGroup[]) => TabGroup[];
}

export function useBatchOperations(): BatchOperationsHook {
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selection, setSelection] = useState<BatchSelection>({
    selectedTabs: new Set(),
    selectedGroups: new Set(),
  });

  // 选中数量
  const selectedTabCount = useMemo(() => selection.selectedTabs.size, [selection.selectedTabs]);
  const selectedGroupCount = useMemo(() => selection.selectedGroups.size, [selection.selectedGroups]);

  // 切换选择模式
  const toggleSelectionMode = useCallback(() => {
    setIsSelectionMode(prev => {
      if (prev) {
        // 退出选择模式时清空选择
        setSelection({ selectedTabs: new Set(), selectedGroups: new Set() });
      }
      return !prev;
    });
  }, []);

  const exitSelectionMode = useCallback(() => {
    setIsSelectionMode(false);
    setSelection({ selectedTabs: new Set(), selectedGroups: new Set() });
  }, []);

  // 标签页选择操作
  const selectTab = useCallback((groupId: string, tabId: string) => {
    const key = `${groupId}:${tabId}`;
    setSelection(prev => ({
      ...prev,
      selectedTabs: new Set([...prev.selectedTabs, key]),
    }));
  }, []);

  const deselectTab = useCallback((groupId: string, tabId: string) => {
    const key = `${groupId}:${tabId}`;
    setSelection(prev => {
      const newSet = new Set(prev.selectedTabs);
      newSet.delete(key);
      return { ...prev, selectedTabs: newSet };
    });
  }, []);

  const toggleTabSelection = useCallback((groupId: string, tabId: string) => {
    const key = `${groupId}:${tabId}`;
    setSelection(prev => {
      const newSet = new Set(prev.selectedTabs);
      if (newSet.has(key)) {
        newSet.delete(key);
      } else {
        newSet.add(key);
      }
      return { ...prev, selectedTabs: newSet };
    });
  }, []);

  const isTabSelected = useCallback(
    (groupId: string, tabId: string) => {
      const key = `${groupId}:${tabId}`;
      return selection.selectedTabs.has(key);
    },
    [selection.selectedTabs]
  );

  // 标签组选择操作
  const selectGroup = useCallback((groupId: string) => {
    setSelection(prev => ({
      ...prev,
      selectedGroups: new Set([...prev.selectedGroups, groupId]),
    }));
  }, []);

  const deselectGroup = useCallback((groupId: string) => {
    setSelection(prev => {
      const newSet = new Set(prev.selectedGroups);
      newSet.delete(groupId);
      return { ...prev, selectedGroups: newSet };
    });
  }, []);

  const toggleGroupSelection = useCallback((groupId: string) => {
    setSelection(prev => {
      const newSet = new Set(prev.selectedGroups);
      if (newSet.has(groupId)) {
        newSet.delete(groupId);
      } else {
        newSet.add(groupId);
      }
      return { ...prev, selectedGroups: newSet };
    });
  }, []);

  const isGroupSelected = useCallback(
    (groupId: string) => {
      return selection.selectedGroups.has(groupId);
    },
    [selection.selectedGroups]
  );

  // 批量选择
  const selectAllTabs = useCallback((groups: TabGroup[]) => {
    const allTabs = new Set<string>();
    groups.forEach(group => {
      group.tabs.forEach(tab => {
        allTabs.add(`${group.id}:${tab.id}`);
      });
    });
    setSelection(prev => ({ ...prev, selectedTabs: allTabs }));
  }, []);

  const deselectAll = useCallback(() => {
    setSelection({ selectedTabs: new Set(), selectedGroups: new Set() });
  }, []);

  const selectAllInGroup = useCallback((group: TabGroup) => {
    setSelection(prev => {
      const newTabs = new Set(prev.selectedTabs);
      group.tabs.forEach(tab => {
        newTabs.add(`${group.id}:${tab.id}`);
      });
      return { ...prev, selectedTabs: newTabs };
    });
  }, []);

  // 获取选中项
  const getSelectedTabs = useCallback(
    (groups: TabGroup[]) => {
      const result: Array<{ group: TabGroup; tab: Tab }> = [];
      groups.forEach(group => {
        group.tabs.forEach(tab => {
          if (selection.selectedTabs.has(`${group.id}:${tab.id}`)) {
            result.push({ group, tab });
          }
        });
      });
      return result;
    },
    [selection.selectedTabs]
  );

  const getSelectedGroups = useCallback(
    (groups: TabGroup[]) => {
      return groups.filter(group => selection.selectedGroups.has(group.id));
    },
    [selection.selectedGroups]
  );

  return {
    selection,
    isSelectionMode,
    selectedTabCount,
    selectedGroupCount,
    toggleSelectionMode,
    exitSelectionMode,
    selectTab,
    deselectTab,
    toggleTabSelection,
    isTabSelected,
    selectGroup,
    deselectGroup,
    toggleGroupSelection,
    isGroupSelected,
    selectAllTabs,
    deselectAll,
    selectAllInGroup,
    getSelectedTabs,
    getSelectedGroups,
  };
}
