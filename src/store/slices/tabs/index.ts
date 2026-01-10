/**
 * Tab Slice - 模块化重构版本
 * 将原来 1295 行的 tabSlice.ts 拆分为多个独立模块
 *
 * 模块结构:
 * - types.ts: 类型定义
 * - initialState.ts: 初始状态
 * - reducers.ts: 同步 reducer
 * - crudThunks.ts: CRUD 异步操作
 * - syncThunks.ts: 同步相关异步操作
 * - dndThunks.ts: 拖拽相关异步操作
 * - selectors.ts: 记忆化选择器
 */

import { createSlice } from '@reduxjs/toolkit';
import { sortGroupsByCreatedAt } from '@/utils/tabSortUtils';

// 导入初始状态
import { initialState } from './initialState';

// 导入 reducers
import { reducers } from './reducers';

// 导入 CRUD thunks
import {
  loadGroups,
  saveGroup,
  updateGroup,
  deleteGroup,
  deleteAllGroups,
  importGroups,
  deleteTabAndSync,
  cleanDuplicateTabs,
} from './crudThunks';

// 导入同步 thunks
import {
  syncTabsToCloud,
  syncTabsFromCloud,
  syncLocalChangesToCloud,
  updateGroupNameAndSync,
  toggleGroupLockAndSync,
} from './syncThunks';

// 导入拖拽 thunks
import { moveGroupAndSync, moveTabAndSync } from './dndThunks';

// 创建 slice
export const tabSlice = createSlice({
  name: 'tabs',
  initialState,
  reducers,
  extraReducers: builder => {
    builder
      // Load Groups
      .addCase(loadGroups.pending, state => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(loadGroups.fulfilled, (state, action) => {
        state.isLoading = false;
        state.groups = action.payload;
      })
      .addCase(loadGroups.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || '加载标签组失败';
      })

      // Save Group
      .addCase(saveGroup.fulfilled, (state, action) => {
        state.groups = sortGroupsByCreatedAt([...state.groups, action.payload]);
      })

      // Update Group
      .addCase(updateGroup.fulfilled, (state, action) => {
        const index = state.groups.findIndex(g => g.id === action.payload.id);
        if (index !== -1) {
          state.groups[index] = action.payload;
        }
      })

      // Delete Group
      .addCase(deleteGroup.fulfilled, (state, action) => {
        state.groups = state.groups.filter(g => g.id !== action.payload);
        if (state.activeGroupId === action.payload) {
          state.activeGroupId = null;
        }
      })

      // Delete All Groups
      .addCase(deleteAllGroups.pending, state => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(deleteAllGroups.fulfilled, state => {
        state.isLoading = false;
        state.groups = [];
        state.activeGroupId = null;
      })
      .addCase(deleteAllGroups.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || '删除所有标签组失败';
      })

      // Sync to Cloud
      .addCase(syncTabsToCloud.pending, (state, action) => {
        const isBackground = action.meta.arg?.background || false;
        state.backgroundSync = isBackground;
        if (!isBackground) {
          state.syncStatus = 'syncing';
        }
      })
      .addCase(syncTabsToCloud.fulfilled, (state, action) => {
        state.lastSyncTime = action.payload.syncTime;
        state.compressionStats = action.payload.stats || null;
        if (!state.backgroundSync) {
          state.syncStatus = 'success';
        }
        state.backgroundSync = false;
      })
      .addCase(syncTabsToCloud.rejected, (state, action) => {
        if (!state.backgroundSync) {
          state.syncStatus = 'error';
          state.error = action.error.message || '同步到云端失败';
        }
        state.backgroundSync = false;
      })

      // Sync from Cloud
      .addCase(syncTabsFromCloud.pending, (state, action) => {
        const isBackground = action.meta.arg?.background || false;
        state.backgroundSync = isBackground;
        if (!isBackground) {
          state.syncStatus = 'syncing';
          state.isLoading = true;
        }
      })
      .addCase(syncTabsFromCloud.fulfilled, (state, action) => {
        const activeGroups = action.payload.groups.filter(g => !g.isDeleted);
        state.groups = activeGroups;
        state.lastSyncTime = action.payload.syncTime;
        state.compressionStats = action.payload.stats || null;

        console.log(
          `[SyncFromCloud] 已同步 ${activeGroups.length} 个活跃标签组（已过滤 ${action.payload.groups.length - activeGroups.length} 个已删除）`
        );

        if (!state.backgroundSync) {
          state.syncStatus = 'success';
          state.isLoading = false;
        }
        state.backgroundSync = false;
      })
      .addCase(syncTabsFromCloud.rejected, (state, action) => {
        if (!state.backgroundSync) {
          state.syncStatus = 'error';
          state.isLoading = false;
          state.error = action.error.message || '从云端同步失败';
        }
        state.backgroundSync = false;
      })

      // Sync Local Changes (no-op for UI)
      .addCase(syncLocalChangesToCloud.pending, () => {})
      .addCase(syncLocalChangesToCloud.fulfilled, () => {})
      .addCase(syncLocalChangesToCloud.rejected, () => {})

      // Update Group Name and Sync (no-op for UI)
      .addCase(updateGroupNameAndSync.pending, () => {})
      .addCase(updateGroupNameAndSync.fulfilled, () => {})
      .addCase(updateGroupNameAndSync.rejected, () => {})

      // Toggle Group Lock and Sync (no-op for UI)
      .addCase(toggleGroupLockAndSync.pending, () => {})
      .addCase(toggleGroupLockAndSync.fulfilled, () => {})
      .addCase(toggleGroupLockAndSync.rejected, () => {})

      // Move Group and Sync (no-op for UI)
      .addCase(moveGroupAndSync.pending, () => {})
      .addCase(moveGroupAndSync.fulfilled, () => {})
      .addCase(moveGroupAndSync.rejected, () => {})

      // Move Tab and Sync (no-op for UI)
      .addCase(moveTabAndSync.pending, () => {})
      .addCase(moveTabAndSync.fulfilled, () => {})
      .addCase(moveTabAndSync.rejected, () => {})

      // Clean Duplicate Tabs
      .addCase(cleanDuplicateTabs.pending, state => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(cleanDuplicateTabs.fulfilled, (state, action) => {
        state.isLoading = false;
        state.groups = action.payload.updatedGroups;
      })
      .addCase(cleanDuplicateTabs.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || '清理重复标签和空标签组失败';
      });
  },
});

// 导出 actions
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
} = tabSlice.actions;

// 导出 thunks
export {
  // CRUD
  loadGroups,
  saveGroup,
  updateGroup,
  deleteGroup,
  deleteAllGroups,
  importGroups,
  deleteTabAndSync,
  cleanDuplicateTabs,
  // Sync
  syncTabsToCloud,
  syncTabsFromCloud,
  syncLocalChangesToCloud,
  updateGroupNameAndSync,
  toggleGroupLockAndSync,
  // DnD
  moveGroupAndSync,
  moveTabAndSync,
};

// 导出 selectors
export {
  selectFilteredGroups,
  selectSortedGroups,
  selectTotalTabCount,
  selectLockedGroups,
  selectGroupCount,
  selectSyncStatus,
  selectIsLoading,
  selectError,
  selectGroupById,
  selectActiveGroup,
} from './selectors';

// 导出 reducer
export default tabSlice.reducer;
