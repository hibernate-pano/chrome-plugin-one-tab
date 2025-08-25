/**
 * 批量操作状态管理
 * 处理多选模式、批量操作等功能
 */
import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { logger } from '@/shared/utils/logger';
import { errorHandler } from '@/shared/utils/errorHandler';
import { storage } from '@/shared/utils/storage';
// import { TabGroup } from '@/shared/types/tab';

export type BatchOperationType = 'delete' | 'move' | 'export' | 'lock' | 'unlock';
export type SelectionMode = 'none' | 'groups' | 'tabs';

interface BatchOperationsState {
  // 选择模式
  selectionMode: SelectionMode;
  
  // 选中的标签组ID列表
  selectedGroupIds: string[];
  
  // 选中的标签页（按组织织）
  selectedTabs: Record<string, string[]>; // groupId -> tabIds[]
  
  // 批量操作状态
  isProcessing: boolean;
  currentOperation: BatchOperationType | null;
  progress: number;
  
  // 错误状态
  error: string | null;
  
  // 操作历史（用于撤销）
  operationHistory: Array<{
    id: string;
    type: BatchOperationType;
    timestamp: string;
    affectedItems: string[];
    canUndo: boolean;
  }>;
}

const initialState: BatchOperationsState = {
  selectionMode: 'none',
  selectedGroupIds: [],
  selectedTabs: {},
  isProcessing: false,
  currentOperation: null,
  progress: 0,
  error: null,
  operationHistory: [],
};

// 异步操作
export const batchDeleteGroups = createAsyncThunk(
  'batchOperations/batchDeleteGroups',
  async (groupIds: string[], { rejectWithValue }) => {
    try {
      logger.debug('批量删除标签组', { count: groupIds.length, groupIds });
      
      const groups = await storage.getGroups();
      const remainingGroups = groups.filter(group => !groupIds.includes(group.id));
      
      await storage.setGroups(remainingGroups);
      
      return {
        deletedCount: groupIds.length,
        operationId: `batch-delete-${Date.now()}`,
      };
    } catch (error) {
      const friendlyError = errorHandler.handleAsyncError(error as Error, { component: 'batchOperationsSlice' });
      const message = friendlyError.message;
      logger.error('批量删除标签组失败', error);
      return rejectWithValue(message);
    }
  }
);

export const batchToggleGroupLock = createAsyncThunk(
  'batchOperations/batchToggleGroupLock',
  async ({ groupIds, lock }: { groupIds: string[]; lock: boolean }, { rejectWithValue }) => {
    try {
      logger.debug('批量切换标签组锁定状态', { count: groupIds.length, lock });
      
      const groups = await storage.getGroups();
      const updatedGroups = groups.map(group => {
        if (groupIds.includes(group.id)) {
          return {
            ...group,
            isLocked: lock,
            updatedAt: new Date().toISOString(),
          };
        }
        return group;
      });
      
      await storage.setGroups(updatedGroups);
      
      return {
        updatedCount: groupIds.length,
        operationId: `batch-lock-${Date.now()}`,
        lock,
      };
    } catch (error) {
      const friendlyError = errorHandler.handleAsyncError(error as Error, { component: 'batchOperationsSlice' });
      const message = friendlyError.message;
      logger.error('批量切换锁定状态失败', error);
      return rejectWithValue(message);
    }
  }
);

export const batchMoveGroups = createAsyncThunk(
  'batchOperations/batchMoveGroups',
  async ({ groupIds, targetIndex }: { groupIds: string[]; targetIndex: number }, { rejectWithValue }) => {
    try {
      logger.debug('批量移动标签组', { count: groupIds.length, targetIndex });

      const groups = await storage.getGroups();
      const selectedGroups = groups.filter(group => groupIds.includes(group.id));
      const remainingGroups = groups.filter(group => !groupIds.includes(group.id));

      // 在目标位置插入选中的标签组
      const newGroups = [...remainingGroups];
      const insertIndex = Math.max(0, Math.min(targetIndex, newGroups.length));
      newGroups.splice(insertIndex, 0, ...selectedGroups);

      await storage.setGroups(newGroups);

      return {
        movedCount: selectedGroups.length,
        operationId: `batch-move-${Date.now()}`,
      };
    } catch (error) {
      const friendlyError = errorHandler.handleAsyncError(error as Error, { component: 'batchOperationsSlice' });
      const message = friendlyError.message;
      logger.error('批量移动失败', error);
      return rejectWithValue(message);
    }
  }
);

export const batchExportGroups = createAsyncThunk(
  'batchOperations/batchExportGroups',
  async (groupIds: string[], { rejectWithValue }) => {
    try {
      logger.debug('批量导出标签组', { count: groupIds.length });

      const groups = await storage.getGroups();
      const selectedGroups = groups.filter(group => groupIds.includes(group.id));

      const exportData = {
        version: '1.0',
        exportTime: new Date().toISOString(),
        groups: selectedGroups,
        metadata: {
          totalGroups: selectedGroups.length,
          totalTabs: selectedGroups.reduce((sum, group) => sum + group.tabs.length, 0),
        },
      };

      // 创建下载链接
      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);

      // 触发下载
      const link = document.createElement('a');
      link.href = url;
      link.download = `onetab-plus-export-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      return {
        exportedCount: selectedGroups.length,
        operationId: `batch-export-${Date.now()}`,
      };
    } catch (error) {
      const friendlyError = errorHandler.handleAsyncError(error as Error, { component: 'batchOperationsSlice' });
      const message = friendlyError.message;
      logger.error('批量导出失败', error);
      return rejectWithValue(message);
    }
  }
);

// 批量操作slice
const batchOperationsSlice = createSlice({
  name: 'batchOperations',
  initialState,
  reducers: {
    // 设置选择模式
    setSelectionMode: (state, action: PayloadAction<SelectionMode>) => {
      state.selectionMode = action.payload;
      
      // 切换模式时清空选择
      if (action.payload === 'none') {
        state.selectedGroupIds = [];
        state.selectedTabs = {};
      }
    },

    // 选择/取消选择标签组
    toggleGroupSelection: (state, action: PayloadAction<string>) => {
      const groupId = action.payload;
      const index = state.selectedGroupIds.indexOf(groupId);
      
      if (index === -1) {
        state.selectedGroupIds.push(groupId);
      } else {
        state.selectedGroupIds.splice(index, 1);
      }
    },

    // 选择所有标签组
    selectAllGroups: (state, action: PayloadAction<string[]>) => {
      state.selectedGroupIds = [...action.payload];
    },

    // 清空所有选择
    clearAllSelections: (state) => {
      state.selectedGroupIds = [];
      state.selectedTabs = {};
    },

    // 选择/取消选择标签页
    toggleTabSelection: (state, action: PayloadAction<{ groupId: string; tabId: string }>) => {
      const { groupId, tabId } = action.payload;
      
      if (!state.selectedTabs[groupId]) {
        state.selectedTabs[groupId] = [];
      }
      
      const tabIds = state.selectedTabs[groupId];
      const index = tabIds.indexOf(tabId);
      
      if (index === -1) {
        tabIds.push(tabId);
      } else {
        tabIds.splice(index, 1);
        
        // 如果组内没有选中的标签页，删除该组的记录
        if (tabIds.length === 0) {
          delete state.selectedTabs[groupId];
        }
      }
    },

    // 选择组内所有标签页
    selectAllTabsInGroup: (state, action: PayloadAction<{ groupId: string; tabIds: string[] }>) => {
      const { groupId, tabIds } = action.payload;
      state.selectedTabs[groupId] = [...tabIds];
    },

    // 设置操作进度
    setProgress: (state, action: PayloadAction<number>) => {
      state.progress = Math.max(0, Math.min(100, action.payload));
    },

    // 清除错误
    clearError: (state) => {
      state.error = null;
    },

    // 添加操作历史
    addOperationHistory: (state, action: PayloadAction<{
      type: BatchOperationType;
      affectedItems: string[];
      canUndo: boolean;
    }>) => {
      const operation = {
        id: `op-${Date.now()}`,
        timestamp: new Date().toISOString(),
        ...action.payload,
      };
      
      state.operationHistory.unshift(operation);
      
      // 只保留最近10个操作记录
      if (state.operationHistory.length > 10) {
        state.operationHistory = state.operationHistory.slice(0, 10);
      }
    },
  },
  extraReducers: (builder) => {
    builder
      // 批量删除标签组
      .addCase(batchDeleteGroups.pending, (state) => {
        state.isProcessing = true;
        state.currentOperation = 'delete';
        state.progress = 0;
        state.error = null;
      })
      .addCase(batchDeleteGroups.fulfilled, (state, _action) => {
        state.isProcessing = false;
        state.currentOperation = null;
        state.progress = 100;
        state.selectedGroupIds = [];
        
        // 添加操作历史
        batchOperationsSlice.caseReducers.addOperationHistory(state, {
          type: 'addOperationHistory',
          payload: {
            type: 'delete',
            affectedItems: state.selectedGroupIds,
            canUndo: false, // 删除操作暂不支持撤销
          },
        });
      })
      .addCase(batchDeleteGroups.rejected, (state, action) => {
        state.isProcessing = false;
        state.currentOperation = null;
        state.error = action.payload as string;
      })

      // 批量切换锁定状态
      .addCase(batchToggleGroupLock.pending, (state) => {
        state.isProcessing = true;
        state.currentOperation = 'lock';
        state.progress = 0;
        state.error = null;
      })
      .addCase(batchToggleGroupLock.fulfilled, (state, action) => {
        state.isProcessing = false;
        state.currentOperation = null;
        state.progress = 100;
        
        // 添加操作历史
        batchOperationsSlice.caseReducers.addOperationHistory(state, {
          type: 'addOperationHistory',
          payload: {
            type: action.payload.lock ? 'lock' : 'unlock',
            affectedItems: state.selectedGroupIds,
            canUndo: true,
          },
        });
      })
      .addCase(batchToggleGroupLock.rejected, (state, action) => {
        state.isProcessing = false;
        state.currentOperation = null;
        state.error = action.payload as string;
      })

      // 批量移动
      .addCase(batchMoveGroups.pending, (state) => {
        state.isProcessing = true;
        state.currentOperation = 'move';
        state.progress = 0;
        state.error = null;
      })
      .addCase(batchMoveGroups.fulfilled, (state) => {
        state.isProcessing = false;
        state.currentOperation = null;
        state.progress = 100;

        // 添加操作历史
        batchOperationsSlice.caseReducers.addOperationHistory(state, {
          type: 'addOperationHistory',
          payload: {
            type: 'move',
            affectedItems: state.selectedGroupIds,
            canUndo: true,
          },
        });
      })
      .addCase(batchMoveGroups.rejected, (state, action) => {
        state.isProcessing = false;
        state.currentOperation = null;
        state.error = action.payload as string;
      })

      // 批量导出
      .addCase(batchExportGroups.pending, (state) => {
        state.isProcessing = true;
        state.currentOperation = 'export';
        state.progress = 0;
        state.error = null;
      })
      .addCase(batchExportGroups.fulfilled, (state) => {
        state.isProcessing = false;
        state.currentOperation = null;
        state.progress = 100;
      })
      .addCase(batchExportGroups.rejected, (state, action) => {
        state.isProcessing = false;
        state.currentOperation = null;
        state.error = action.payload as string;
      });
  },
});

export const {
  setSelectionMode,
  toggleGroupSelection,
  selectAllGroups,
  clearAllSelections,
  toggleTabSelection,
  selectAllTabsInGroup,
  setProgress,
  clearError,
  addOperationHistory,
} = batchOperationsSlice.actions;

export default batchOperationsSlice.reducer;
