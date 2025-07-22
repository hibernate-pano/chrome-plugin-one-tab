/**
 * 同步功能状态管理
 * 处理云端同步、实时同步、同步状态等
 */
import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { logger } from '@/shared/utils/logger';
import { errorHandler } from '@/shared/utils/errorHandler';
import { storage } from '@/shared/utils/storage';
import { sync as supabaseSync } from '@/shared/utils/supabase';

export type SyncStatus = 'idle' | 'syncing' | 'success' | 'error';
export type SyncOperation = 'none' | 'upload' | 'download' | 'merge';
export type SyncStrategy = 'newest' | 'local' | 'remote' | 'ask';

interface SyncState {
  status: SyncStatus;
  operation: SyncOperation;
  progress: number;
  lastSyncTime: string | null;
  isRealtimeEnabled: boolean;
  isAutoSyncEnabled: boolean;
  syncInterval: number; // 分钟
  syncStrategy: SyncStrategy;
  error: string | null;
  pendingOperations: string[];
  backgroundSync: boolean;
}

const initialState: SyncState = {
  status: 'idle',
  operation: 'none',
  progress: 0,
  lastSyncTime: null,
  isRealtimeEnabled: false,
  isAutoSyncEnabled: false,
  syncInterval: 10,
  syncStrategy: 'newest',
  error: null,
  pendingOperations: [],
  backgroundSync: false,
};

// 异步操作 - 标签组同步
export const syncTabsToCloud = createAsyncThunk(
  'sync/syncTabsToCloud',
  async (
    { background = false, overwriteCloud = false }: { background?: boolean; overwriteCloud?: boolean } = {},
    { dispatch, getState, rejectWithValue }
  ) => {
    try {
      logger.sync('开始上传标签组到云端', { background, overwriteCloud });

      if (!background) {
        dispatch(setSyncStatus('syncing'));
        dispatch(setSyncOperation('upload'));
        dispatch(setSyncProgress(0));
      }

      // 获取本地标签组
      const localGroups = await storage.getGroups();

      if (!background) {
        dispatch(setSyncProgress(25));
      }

      // 上传到云端 - 根据参数决定是否覆盖
      await supabaseSync.uploadTabGroups(localGroups, overwriteCloud);

      if (!background) {
        dispatch(setSyncProgress(100));
        dispatch(setSyncStatus('success'));
        dispatch(setSyncOperation('none'));
      }

      const syncTime = new Date().toISOString();
      dispatch(setLastSyncTime(syncTime));

      logger.success('标签组上传完成', { syncTime, groupCount: localGroups.length });

      return { syncTime, background, groupCount: localGroups.length };

    } catch (error) {
      const friendlyError = errorHandler.handleSyncError(error as Error, {
        component: 'SyncSlice',
        action: 'syncTabsToCloud',
      });

      if (!background) {
        dispatch(setSyncStatus('error'));
        dispatch(setSyncOperation('none'));
        dispatch(setError(friendlyError.message));
      }

      return rejectWithValue(friendlyError.message);
    }
  }
);

export const syncTabsFromCloud = createAsyncThunk(
  'sync/syncTabsFromCloud',
  async (
    { background = false, forceRemoteStrategy = false }: { background?: boolean; forceRemoteStrategy?: boolean } = {},
    { dispatch, getState, rejectWithValue }
  ) => {
    try {
      logger.sync('开始从云端下载标签组', { background, forceRemoteStrategy });

      if (!background) {
        dispatch(setSyncStatus('syncing'));
        dispatch(setSyncOperation('download'));
        dispatch(setSyncProgress(0));
      }

      // 从云端下载标签组
      const cloudGroups = await supabaseSync.downloadTabGroups();

      if (!background) {
        dispatch(setSyncProgress(50));
      }

      // 根据策略处理数据
      if (forceRemoteStrategy) {
        // 直接使用云端数据覆盖本地
        await storage.setGroups(cloudGroups);
      } else {
        // 合并本地和云端数据
        const localGroups = await storage.getGroups();
        // 这里可以实现更复杂的合并逻辑
        const mergedGroups = [...cloudGroups, ...localGroups.filter(local =>
          !cloudGroups.some(cloud => cloud.id === local.id)
        )];
        await storage.setGroups(mergedGroups);
      }

      if (!background) {
        dispatch(setSyncProgress(100));
        dispatch(setSyncStatus('success'));
        dispatch(setSyncOperation('none'));
      }

      const syncTime = new Date().toISOString();
      dispatch(setLastSyncTime(syncTime));

      logger.success('标签组下载完成', { syncTime, groupCount: cloudGroups.length });

      return { syncTime, background, groupCount: cloudGroups.length };

    } catch (error) {
      const friendlyError = errorHandler.handleSyncError(error as Error, {
        component: 'SyncSlice',
        action: 'syncTabsFromCloud',
      });

      if (!background) {
        dispatch(setSyncStatus('error'));
        dispatch(setSyncOperation('none'));
        dispatch(setError(friendlyError.message));
      }

      return rejectWithValue(friendlyError.message);
    }
  }
);

// 通用同步操作
export const uploadToCloud = createAsyncThunk(
  'sync/uploadToCloud',
  async (
    { background = false, overwrite = false }: { background?: boolean; overwrite?: boolean } = {},
    { dispatch, getState: _getState, rejectWithValue }
  ) => {
    try {
      logger.sync('开始上传到云端', { background, overwrite });

      // 设置同步状态
      if (!background) {
        dispatch(setSyncStatus('syncing'));
        dispatch(setSyncOperation('upload'));
        dispatch(setSyncProgress(0));
      }

      // 这里应该调用实际的同步服务
      // 暂时模拟异步操作
      await new Promise(resolve => setTimeout(resolve, 1000));

      const syncTime = new Date().toISOString();

      if (!background) {
        dispatch(setSyncProgress(100));
        dispatch(setSyncStatus('success'));
        dispatch(setSyncOperation('none'));
      }

      dispatch(setLastSyncTime(syncTime));

      logger.success('上传到云端完成', { syncTime });

      return { syncTime, background };

    } catch (error) {
      const friendlyError = errorHandler.handleSyncError(error as Error, {
        component: 'SyncSlice',
        action: 'uploadToCloud',
      });

      if (!background) {
        dispatch(setSyncStatus('error'));
        dispatch(setSyncOperation('none'));
        dispatch(setError(friendlyError.message));
      }

      return rejectWithValue(friendlyError.message);
    }
  }
);

export const downloadFromCloud = createAsyncThunk(
  'sync/downloadFromCloud',
  async (
    { background = false, overwrite = false }: { background?: boolean; overwrite?: boolean } = {},
    { dispatch, getState: _getState, rejectWithValue }
  ) => {
    try {
      logger.sync('开始从云端下载', { background, overwrite });

      if (!background) {
        dispatch(setSyncStatus('syncing'));
        dispatch(setSyncOperation('download'));
        dispatch(setSyncProgress(0));
      }

      // 模拟下载过程
      await new Promise(resolve => setTimeout(resolve, 1500));

      const syncTime = new Date().toISOString();

      if (!background) {
        dispatch(setSyncProgress(100));
        dispatch(setSyncStatus('success'));
        dispatch(setSyncOperation('none'));
      }

      dispatch(setLastSyncTime(syncTime));

      logger.success('从云端下载完成', { syncTime });

      return { syncTime, background };

    } catch (error) {
      const friendlyError = errorHandler.handleSyncError(error as Error, {
        component: 'SyncSlice',
        action: 'downloadFromCloud',
      });

      if (!background) {
        dispatch(setSyncStatus('error'));
        dispatch(setSyncOperation('none'));
        dispatch(setError(friendlyError.message));
      }

      return rejectWithValue(friendlyError.message);
    }
  }
);

export const performBidirectionalSync = createAsyncThunk(
  'sync/performBidirectionalSync',
  async (
    { strategy }: { strategy?: SyncStrategy } = {},
    { dispatch, getState: _getState, rejectWithValue }
  ) => {
    try {
      logger.sync('开始双向同步', { strategy });

      dispatch(setSyncStatus('syncing'));
      dispatch(setSyncOperation('merge'));
      dispatch(setSyncProgress(0));

      // 模拟双向同步过程
      // 1. 检查云端更新
      dispatch(setSyncProgress(25));
      await new Promise(resolve => setTimeout(resolve, 500));

      // 2. 比较数据差异
      dispatch(setSyncProgress(50));
      await new Promise(resolve => setTimeout(resolve, 500));

      // 3. 合并数据
      dispatch(setSyncProgress(75));
      await new Promise(resolve => setTimeout(resolve, 500));

      // 4. 上传合并结果
      dispatch(setSyncProgress(100));
      await new Promise(resolve => setTimeout(resolve, 500));

      const syncTime = new Date().toISOString();

      dispatch(setSyncStatus('success'));
      dispatch(setSyncOperation('none'));
      dispatch(setLastSyncTime(syncTime));

      logger.success('双向同步完成', { syncTime, strategy });

      return { syncTime, strategy };

    } catch (error) {
      const friendlyError = errorHandler.handleSyncError(error as Error, {
        component: 'SyncSlice',
        action: 'performBidirectionalSync',
      });

      dispatch(setSyncStatus('error'));
      dispatch(setSyncOperation('none'));
      dispatch(setError(friendlyError.message));

      return rejectWithValue(friendlyError.message);
    }
  }
);

export const initializeRealtimeSync = createAsyncThunk(
  'sync/initializeRealtimeSync',
  async (_, { dispatch, getState: _getState, rejectWithValue }) => {
    try {
      logger.sync('初始化实时同步');

      // 这里应该初始化实时同步连接
      // 比如WebSocket或者Supabase实时订阅

      dispatch(setRealtimeEnabled(true));

      logger.success('实时同步已启用');

      return true;

    } catch (error) {
      const friendlyError = errorHandler.handleSyncError(error as Error, {
        component: 'SyncSlice',
        action: 'initializeRealtimeSync',
      });

      dispatch(setError(friendlyError.message));

      return rejectWithValue(friendlyError.message);
    }
  }
);

// Slice定义
const syncSlice = createSlice({
  name: 'sync',
  initialState,
  reducers: {
    setSyncStatus: (state, action: PayloadAction<SyncStatus>) => {
      state.status = action.payload;
      if (action.payload !== 'error') {
        state.error = null;
      }
    },

    setSyncOperation: (state, action: PayloadAction<SyncOperation>) => {
      state.operation = action.payload;
    },

    setSyncProgress: (state, action: PayloadAction<number>) => {
      state.progress = Math.max(0, Math.min(100, action.payload));
    },

    setLastSyncTime: (state, action: PayloadAction<string>) => {
      state.lastSyncTime = action.payload;
    },

    setRealtimeEnabled: (state, action: PayloadAction<boolean>) => {
      state.isRealtimeEnabled = action.payload;
      logger.sync(`实时同步${action.payload ? '已启用' : '已禁用'}`);
    },

    setAutoSyncEnabled: (state, action: PayloadAction<boolean>) => {
      state.isAutoSyncEnabled = action.payload;
      logger.sync(`自动同步${action.payload ? '已启用' : '已禁用'}`);
    },

    setSyncInterval: (state, action: PayloadAction<number>) => {
      state.syncInterval = Math.max(1, action.payload);
      logger.sync('同步间隔已更新', { interval: action.payload });
    },

    setSyncStrategy: (state, action: PayloadAction<SyncStrategy>) => {
      state.syncStrategy = action.payload;
      logger.sync('同步策略已更新', { strategy: action.payload });
    },

    setError: (state, action: PayloadAction<string | null>) => {
      state.error = action.payload;
      if (action.payload) {
        state.status = 'error';
      }
    },

    addPendingOperation: (state, action: PayloadAction<string>) => {
      if (!state.pendingOperations.includes(action.payload)) {
        state.pendingOperations.push(action.payload);
      }
    },

    removePendingOperation: (state, action: PayloadAction<string>) => {
      state.pendingOperations = state.pendingOperations.filter(op => op !== action.payload);
    },

    clearPendingOperations: (state) => {
      state.pendingOperations = [];
    },

    setBackgroundSync: (state, action: PayloadAction<boolean>) => {
      state.backgroundSync = action.payload;
    },

    resetSyncState: (state) => {
      state.status = 'idle';
      state.operation = 'none';
      state.progress = 0;
      state.error = null;
      state.pendingOperations = [];
      state.backgroundSync = false;
    },
  },
  extraReducers: (builder) => {
    builder
      // syncTabsToCloud
      .addCase(syncTabsToCloud.pending, (state, action) => {
        const background = action.meta.arg?.background || false;
        state.backgroundSync = background;

        if (!background) {
          state.status = 'syncing';
          state.operation = 'upload';
          state.progress = 0;
          state.error = null;
        }
      })
      .addCase(syncTabsToCloud.fulfilled, (state, action) => {
        const { syncTime, background } = action.payload;
        state.lastSyncTime = syncTime;

        if (!background) {
          state.status = 'success';
          state.operation = 'none';
          state.progress = 100;
        }

        state.backgroundSync = false;
      })
      .addCase(syncTabsToCloud.rejected, (state, action) => {
        const background = state.backgroundSync;

        if (!background) {
          state.status = 'error';
          state.operation = 'none';
          state.error = action.payload as string;
        }

        state.backgroundSync = false;
      })

      // syncTabsFromCloud
      .addCase(syncTabsFromCloud.pending, (state, action) => {
        const background = action.meta.arg?.background || false;
        state.backgroundSync = background;

        if (!background) {
          state.status = 'syncing';
          state.operation = 'download';
          state.progress = 0;
          state.error = null;
        }
      })
      .addCase(syncTabsFromCloud.fulfilled, (state, action) => {
        const { syncTime, background } = action.payload;
        state.lastSyncTime = syncTime;

        if (!background) {
          state.status = 'success';
          state.operation = 'none';
          state.progress = 100;
        }

        state.backgroundSync = false;
      })
      .addCase(syncTabsFromCloud.rejected, (state, action) => {
        const background = state.backgroundSync;

        if (!background) {
          state.status = 'error';
          state.operation = 'none';
          state.error = action.payload as string;
        }

        state.backgroundSync = false;
      })

      // uploadToCloud
      .addCase(uploadToCloud.pending, (state, action) => {
        const background = action.meta.arg?.background || false;
        state.backgroundSync = background;

        if (!background) {
          state.status = 'syncing';
          state.operation = 'upload';
          state.progress = 0;
          state.error = null;
        }
      })
      .addCase(uploadToCloud.fulfilled, (state, action) => {
        const { syncTime, background } = action.payload;
        state.lastSyncTime = syncTime;

        if (!background) {
          state.status = 'success';
          state.operation = 'none';
          state.progress = 100;
        }

        state.backgroundSync = false;
      })
      .addCase(uploadToCloud.rejected, (state, action) => {
        if (!state.backgroundSync) {
          state.status = 'error';
          state.operation = 'none';
          state.error = action.payload as string;
        }

        state.backgroundSync = false;
      })

      // downloadFromCloud
      .addCase(downloadFromCloud.pending, (state, action) => {
        const background = action.meta.arg?.background || false;
        state.backgroundSync = background;

        if (!background) {
          state.status = 'syncing';
          state.operation = 'download';
          state.progress = 0;
          state.error = null;
        }
      })
      .addCase(downloadFromCloud.fulfilled, (state, action) => {
        const { syncTime, background } = action.payload;
        state.lastSyncTime = syncTime;

        if (!background) {
          state.status = 'success';
          state.operation = 'none';
          state.progress = 100;
        }

        state.backgroundSync = false;
      })
      .addCase(downloadFromCloud.rejected, (state, action) => {
        if (!state.backgroundSync) {
          state.status = 'error';
          state.operation = 'none';
          state.error = action.payload as string;
        }

        state.backgroundSync = false;
      })

      // performBidirectionalSync
      .addCase(performBidirectionalSync.pending, (state) => {
        state.status = 'syncing';
        state.operation = 'merge';
        state.progress = 0;
        state.error = null;
      })
      .addCase(performBidirectionalSync.fulfilled, (state, action) => {
        const { syncTime } = action.payload;
        state.status = 'success';
        state.operation = 'none';
        state.progress = 100;
        state.lastSyncTime = syncTime;
      })
      .addCase(performBidirectionalSync.rejected, (state, action) => {
        state.status = 'error';
        state.operation = 'none';
        state.error = action.payload as string;
      })

      // initializeRealtimeSync
      .addCase(initializeRealtimeSync.fulfilled, (state) => {
        state.isRealtimeEnabled = true;
      })
      .addCase(initializeRealtimeSync.rejected, (state, action) => {
        state.isRealtimeEnabled = false;
        state.error = action.payload as string;
      });
  },
});

export const {
  setSyncStatus,
  setSyncOperation,
  setSyncProgress,
  setLastSyncTime,
  setRealtimeEnabled,
  setAutoSyncEnabled,
  setSyncInterval,
  setSyncStrategy,
  setError,
  addPendingOperation,
  removePendingOperation,
  clearPendingOperations,
  setBackgroundSync,
  resetSyncState,
} = syncSlice.actions;

export default syncSlice.reducer;