/**
 * Tab Slice Reducers
 * 同步操作的状态更新
 */

import { PayloadAction } from '@reduxjs/toolkit';
import { TabState, TabGroup } from '@/types/tab';
import type { MoveGroupParams, MoveTabParams, SyncProgressPayload } from './types';

export const reducers = {
  setActiveGroup: (state: TabState, action: PayloadAction<string | null>) => {
    state.activeGroupId = action.payload;
  },

  updateGroupName: (state: TabState, action: PayloadAction<{ groupId: string; name: string }>) => {
    const { groupId, name } = action.payload;
    const group = state.groups.find(g => g.id === groupId);
    if (group) {
      group.name = name;
      group.version = (group.version || 1) + 1;
      group.updatedAt = new Date().toISOString();
    }
  },

  toggleGroupLock: (state: TabState, action: PayloadAction<string>) => {
    const group = state.groups.find(g => g.id === action.payload);
    if (group) {
      group.isLocked = !group.isLocked;
      group.version = (group.version || 1) + 1;
      group.updatedAt = new Date().toISOString();
    }
  },

  setSearchQuery: (state: TabState, action: PayloadAction<string>) => {
    state.searchQuery = action.payload;
  },

  setSyncStatus: (
    state: TabState,
    action: PayloadAction<'idle' | 'syncing' | 'success' | 'error'>
  ) => {
    state.syncStatus = action.payload;
  },

  moveGroup: (state: TabState, action: PayloadAction<MoveGroupParams>) => {
    const { dragIndex, hoverIndex } = action.payload;
    const dragGroup = state.groups[dragIndex];
    const newGroups = [...state.groups];
    newGroups.splice(dragIndex, 1);
    newGroups.splice(hoverIndex, 0, dragGroup);
    state.groups = newGroups;
  },

  moveTab: (state: TabState, action: PayloadAction<MoveTabParams>) => {
    const { sourceGroupId, sourceIndex, targetGroupId, targetIndex } = action.payload;

    const sourceGroup = state.groups.find(g => g.id === sourceGroupId);
    const targetGroup = state.groups.find(g => g.id === targetGroupId);

    if (
      !sourceGroup ||
      !targetGroup ||
      !sourceGroup.tabs ||
      !Array.isArray(sourceGroup.tabs) ||
      !targetGroup.tabs ||
      !Array.isArray(targetGroup.tabs)
    ) {
      console.error('无效的标签组数据:', {
        sourceGroup: sourceGroup?.id,
        targetGroup: targetGroup?.id,
        sourceTabsValid: Array.isArray(sourceGroup?.tabs),
        targetTabsValid: Array.isArray(targetGroup?.tabs),
      });
      return;
    }

    if (sourceIndex < 0 || sourceIndex >= sourceGroup.tabs.length) {
      console.error('无效的源标签索引:', { sourceIndex, tabsLength: sourceGroup.tabs.length });
      return;
    }

    const tab = { ...sourceGroup.tabs[sourceIndex] };
    const now = new Date().toISOString();

    if (sourceGroupId === targetGroupId) {
      const newTabs = [...sourceGroup.tabs];
      newTabs.splice(sourceIndex, 1);

      const adjustedIndex = Math.max(0, Math.min(targetIndex, newTabs.length));
      newTabs.splice(adjustedIndex, 0, tab);

      const updatedSourceGroup: TabGroup = {
        ...sourceGroup,
        tabs: newTabs,
        updatedAt: now,
      };

      state.groups = state.groups.map(g => (g.id === sourceGroupId ? updatedSourceGroup : g));
    } else {
      const newSourceTabs = sourceGroup.tabs.filter((_, i) => i !== sourceIndex);

      const updatedSourceGroup: TabGroup = {
        ...sourceGroup,
        tabs: newSourceTabs,
        updatedAt: now,
      };

      const newTargetTabs = [...targetGroup.tabs];
      const existingIndex = newTargetTabs.findIndex(t => t.id === tab.id);
      if (existingIndex !== -1) {
        newTargetTabs.splice(existingIndex, 1);
      }

      const safeTargetIndex = Math.max(0, Math.min(targetIndex, newTargetTabs.length));
      newTargetTabs.splice(safeTargetIndex, 0, tab);

      const updatedTargetGroup: TabGroup = {
        ...targetGroup,
        tabs: newTargetTabs,
        updatedAt: now,
      };

      state.groups = state.groups.map(g => {
        if (g.id === sourceGroupId) return updatedSourceGroup;
        if (g.id === targetGroupId) return updatedTargetGroup;
        return g;
      });
    }
  },

  updateSyncProgress: (state: TabState, action: PayloadAction<SyncProgressPayload>) => {
    const { progress, operation } = action.payload;
    state.syncProgress = progress;
    state.syncOperation = operation;
  },

  setGroups: (state: TabState, action: PayloadAction<TabGroup[]>) => {
    state.groups = action.payload;
  },
};

// 导出独立的 action creators 类型
export const {
  setActiveGroup,
  updateGroupName,
  toggleGroupLock,
  setSearchQuery,
  setSyncStatus,
  moveGroup,
  moveTab,
  updateSyncProgress,
  setGroups,
} = {
  setActiveGroup: (payload: string | null) => ({ type: 'tabs/setActiveGroup', payload }),
  updateGroupName: (payload: { groupId: string; name: string }) => ({
    type: 'tabs/updateGroupName',
    payload,
  }),
  toggleGroupLock: (payload: string) => ({ type: 'tabs/toggleGroupLock', payload }),
  setSearchQuery: (payload: string) => ({ type: 'tabs/setSearchQuery', payload }),
  setSyncStatus: (payload: 'idle' | 'syncing' | 'success' | 'error') => ({
    type: 'tabs/setSyncStatus',
    payload,
  }),
  moveGroup: (payload: MoveGroupParams) => ({ type: 'tabs/moveGroup', payload }),
  moveTab: (payload: MoveTabParams) => ({ type: 'tabs/moveTab', payload }),
  updateSyncProgress: (payload: SyncProgressPayload) => ({
    type: 'tabs/updateSyncProgress',
    payload,
  }),
  setGroups: (payload: TabGroup[]) => ({ type: 'tabs/setGroups', payload }),
};
