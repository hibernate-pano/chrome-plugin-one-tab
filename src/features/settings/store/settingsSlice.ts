/**
 * 设置功能状态管理
 * 处理用户设置的加载、保存和同步
 */
import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { UserSettings } from '@/shared/types/tab';
import { storage } from '@/shared/utils/storage';
import { logger } from '@/shared/utils/logger';
import { errorHandler } from '@/shared/utils/errorHandler';
import { sync as supabaseSync } from '@/shared/utils/supabase';

// 默认设置
const DEFAULT_SETTINGS: UserSettings = {
  themeMode: 'auto',
  showFavicons: true,
  showTabCount: true,
  showNotifications: true,
  confirmBeforeDelete: true,
  allowDuplicateTabs: false,
  autoCloseTabsAfterSaving: true,
  groupNameTemplate: '标签组 {date}',
  syncEnabled: false,
  autoSyncEnabled: false,
  syncInterval: 30, // 分钟
  useDoubleColumnLayout: false,
  showManualSyncButtons: true,
};

interface SettingsState extends UserSettings {
  isLoading: boolean;
  error: string | null;
  lastSyncTime: string | null;
}

const initialState: SettingsState = {
  ...DEFAULT_SETTINGS,
  isLoading: false,
  error: null,
  lastSyncTime: null,
};

// 异步操作
export const loadSettings = createAsyncThunk(
  'settings/loadSettings',
  async (_, { rejectWithValue }) => {
    try {
      logger.debug('加载用户设置');
      const settings = await storage.getSettings();
      return { ...DEFAULT_SETTINGS, ...settings };
    } catch (error) {
      const message = errorHandler.getErrorMessage(error);
      logger.error('加载设置失败', error);
      return rejectWithValue(message);
    }
  }
);

export const saveSettings = createAsyncThunk(
  'settings/saveSettings',
  async (settings: Partial<UserSettings>, { getState, rejectWithValue }) => {
    try {
      const currentState = getState() as { settings: SettingsState };
      const newSettings = { ...currentState.settings, ...settings };

      // 移除非设置字段
      const { isLoading, error, lastSyncTime, ...settingsToSave } = newSettings;

      logger.debug('保存用户设置', settingsToSave);
      await storage.setSettings(settingsToSave);
      return settingsToSave;
    } catch (error) {
      const message = errorHandler.getErrorMessage(error);
      logger.error('保存设置失败', error);
      return rejectWithValue(message);
    }
  }
);

export const resetSettings = createAsyncThunk(
  'settings/resetSettings',
  async (_, { rejectWithValue }) => {
    try {
      logger.debug('重置用户设置');
      await storage.setSettings(DEFAULT_SETTINGS);
      return DEFAULT_SETTINGS;
    } catch (error) {
      const message = errorHandler.getErrorMessage(error);
      logger.error('重置设置失败', error);
      return rejectWithValue(message);
    }
  }
);

export const syncSettingsToCloud = createAsyncThunk(
  'settings/syncSettingsToCloud',
  async (_, { getState, rejectWithValue }) => {
    try {
      logger.debug('上传设置到云端');
      const currentState = getState() as { settings: SettingsState };
      const { isLoading, error, lastSyncTime, ...settingsToSync } = currentState.settings;

      await supabaseSync.uploadSettings(settingsToSync);

      const syncTime = new Date().toISOString();
      logger.success('设置上传完成', { syncTime });

      return { syncTime };
    } catch (error) {
      const message = errorHandler.getErrorMessage(error);
      logger.error('上传设置失败', error);
      return rejectWithValue(message);
    }
  }
);

export const syncSettingsFromCloud = createAsyncThunk(
  'settings/syncSettingsFromCloud',
  async (_, { rejectWithValue }) => {
    try {
      logger.debug('从云端下载设置');
      const cloudSettings = await supabaseSync.downloadSettings();

      if (cloudSettings) {
        await storage.setSettings(cloudSettings);
        const syncTime = new Date().toISOString();
        logger.success('设置下载完成', { syncTime });

        return { settings: cloudSettings, syncTime };
      } else {
        logger.debug('云端没有设置数据');
        return { settings: null, syncTime: null };
      }
    } catch (error) {
      const message = errorHandler.getErrorMessage(error);
      logger.error('下载设置失败', error);
      return rejectWithValue(message);
    }
  }
);

// 设置slice
const settingsSlice = createSlice({
  name: 'settings',
  initialState,
  reducers: {
    // 批量更新设置
    updateSettings: (state, action: PayloadAction<Partial<UserSettings>>) => {
      Object.assign(state, action.payload);
    },

    // 主题设置
    setThemeMode: (state, action: PayloadAction<'light' | 'dark' | 'auto'>) => {
      state.themeMode = action.payload;
    },

    // 显示设置
    setShowFavicons: (state, action: PayloadAction<boolean>) => {
      state.showFavicons = action.payload;
    },

    setShowTabCount: (state, action: PayloadAction<boolean>) => {
      state.showTabCount = action.payload;
    },

    setShowNotifications: (state, action: PayloadAction<boolean>) => {
      state.showNotifications = action.payload;
    },

    setShowManualSyncButtons: (state, action: PayloadAction<boolean>) => {
      state.showManualSyncButtons = action.payload;
    },

    // 行为设置
    setConfirmBeforeDelete: (state, action: PayloadAction<boolean>) => {
      state.confirmBeforeDelete = action.payload;
    },

    setAllowDuplicateTabs: (state, action: PayloadAction<boolean>) => {
      state.allowDuplicateTabs = action.payload;
    },

    setUseDoubleColumnLayout: (state, action: PayloadAction<boolean>) => {
      state.useDoubleColumnLayout = action.payload;
    },

    // 同步设置
    setSyncEnabled: (state, action: PayloadAction<boolean>) => {
      state.syncEnabled = action.payload;
    },

    setAutoSyncEnabled: (state, action: PayloadAction<boolean>) => {
      state.autoSyncEnabled = action.payload;
    },

    setSyncInterval: (state, action: PayloadAction<number>) => {
      state.syncInterval = Math.max(1, action.payload); // 最小1分钟
    },

    // 模板设置
    setGroupNameTemplate: (state, action: PayloadAction<string>) => {
      state.groupNameTemplate = action.payload || DEFAULT_SETTINGS.groupNameTemplate;
    },

    // 切换操作
    toggleShowFavicons: (state) => {
      state.showFavicons = !state.showFavicons;
    },

    toggleShowTabCount: (state) => {
      state.showTabCount = !state.showTabCount;
    },

    toggleShowNotifications: (state) => {
      state.showNotifications = !state.showNotifications;
    },

    toggleConfirmBeforeDelete: (state) => {
      state.confirmBeforeDelete = !state.confirmBeforeDelete;
    },

    toggleAllowDuplicateTabs: (state) => {
      state.allowDuplicateTabs = !state.allowDuplicateTabs;
    },

    toggleAutoCloseTabsAfterSaving: (state) => {
      state.autoCloseTabsAfterSaving = !state.autoCloseTabsAfterSaving;
    },

    toggleSyncEnabled: (state) => {
      state.syncEnabled = !state.syncEnabled;
    },

    toggleAutoSyncEnabled: (state) => {
      state.autoSyncEnabled = !state.autoSyncEnabled;
    },

    toggleUseDoubleColumnLayout: (state) => {
      state.useDoubleColumnLayout = !state.useDoubleColumnLayout;
    },

    toggleShowManualSyncButtons: (state) => {
      state.showManualSyncButtons = !state.showManualSyncButtons;
    },

    // 清除错误
    clearError: (state) => {
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      // 加载设置
      .addCase(loadSettings.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(loadSettings.fulfilled, (state, action) => {
        state.isLoading = false;
        Object.assign(state, action.payload);
      })
      .addCase(loadSettings.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload as string;
      })

      // 保存设置
      .addCase(saveSettings.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(saveSettings.fulfilled, (state, action) => {
        state.isLoading = false;
        Object.assign(state, action.payload);
        state.lastSyncTime = new Date().toISOString();
      })
      .addCase(saveSettings.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload as string;
      })

      // 重置设置
      .addCase(resetSettings.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(resetSettings.fulfilled, (state, action) => {
        state.isLoading = false;
        Object.assign(state, action.payload);
        state.lastSyncTime = new Date().toISOString();
      })
      .addCase(resetSettings.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload as string;
      })

      // 同步设置到云端
      .addCase(syncSettingsToCloud.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(syncSettingsToCloud.fulfilled, (state, action) => {
        state.isLoading = false;
        state.lastSyncTime = action.payload.syncTime;
      })
      .addCase(syncSettingsToCloud.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload as string;
      })

      // 从云端同步设置
      .addCase(syncSettingsFromCloud.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(syncSettingsFromCloud.fulfilled, (state, action) => {
        state.isLoading = false;
        if (action.payload.settings) {
          Object.assign(state, action.payload.settings);
        }
        if (action.payload.syncTime) {
          state.lastSyncTime = action.payload.syncTime;
        }
      })
      .addCase(syncSettingsFromCloud.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload as string;
      });
  },
});

export const {
  updateSettings,
  setThemeMode,
  setShowFavicons,
  setShowTabCount,
  setShowNotifications,
  setShowManualSyncButtons,
  setConfirmBeforeDelete,
  setAllowDuplicateTabs,
  setUseDoubleColumnLayout,
  setSyncEnabled,
  setAutoSyncEnabled,
  setSyncInterval,
  setGroupNameTemplate,
  toggleShowFavicons,
  toggleShowTabCount,
  toggleShowNotifications,
  toggleConfirmBeforeDelete,
  toggleAllowDuplicateTabs,
  toggleSyncEnabled,
  toggleAutoSyncEnabled,
  toggleUseDoubleColumnLayout,
  toggleShowManualSyncButtons,
  clearError,
} = settingsSlice.actions;

export default settingsSlice.reducer;
