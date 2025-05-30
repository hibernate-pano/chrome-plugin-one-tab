import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { UserSettings } from '@/types/tab';
import { storage, DEFAULT_SETTINGS as defaultSettings } from '@/utils/storage';
import { sync as supabaseSync } from '@/utils/supabase';

// 更新默认设置
const updatedDefaultSettings = {
  ...defaultSettings,
};

const initialState: UserSettings = {
  ...updatedDefaultSettings,
  reorderMode: false, // 新增：全局重新排序模式
};

export const loadSettings = createAsyncThunk('settings/loadSettings', async () => {
  return await storage.getSettings();
});

export const saveSettings = createAsyncThunk(
  'settings/saveSettings',
  async (settings: UserSettings) => {
    await storage.setSettings(settings);
    return settings;
  }
);

// 新增：同步设置到云端
export const syncSettingsToCloud = createAsyncThunk<UserSettings, void, { state: { settings: UserSettings, auth: { isAuthenticated: boolean } } }>(
  'settings/syncSettingsToCloud',
  async (_, { getState }) => {
    const { settings, auth } = getState();

    // 检查用户是否已登录
    if (!auth.isAuthenticated) {
      console.log('用户未登录，无法同步设置到云端');
      return settings;
    }

    await supabaseSync.uploadSettings(settings);
    return settings;
  }
);

// 新增：从云端同步设置
export const syncSettingsFromCloud = createAsyncThunk<UserSettings | null, void, { state: { auth: { isAuthenticated: boolean }, settings: UserSettings } }>(
  'settings/syncSettingsFromCloud',
  async (_, { getState }) => {
    const { auth, settings } = getState();

    // 检查用户是否已登录
    if (!auth.isAuthenticated) {
      console.log('用户未登录，无法从云端同步设置');
      return settings;
    }

    const cloudSettings = await supabaseSync.downloadSettings();
    if (cloudSettings) {
      // 保存到本地存储
      await storage.setSettings(cloudSettings);
      return cloudSettings;
    }
    return null;
  }
);

const settingsSlice = createSlice({
  name: 'settings',
  initialState,
  reducers: {
    // 更新设置（可以更新多个设置项）
    updateSettings: (state, action: PayloadAction<Partial<UserSettings>>) => {
      return { ...state, ...action.payload };
    },

    // 设置主题模式
    setThemeMode: (state, action: PayloadAction<'light' | 'dark' | 'auto'>) => {
      state.themeMode = action.payload;
    },

    setShowFavicons: (state, action: PayloadAction<boolean>) => {
      state.showFavicons = action.payload;
    },
    setShowTabCount: (state, action: PayloadAction<boolean>) => {
      state.showTabCount = action.payload;
    },
    setShowNotifications: (state, action: PayloadAction<boolean>) => {
      state.showNotifications = action.payload;
    },

    setGroupNameTemplate: (state, action: PayloadAction<string>) => {
      state.groupNameTemplate = action.payload;
    },

    toggleShowFavicons: (state) => {
      state.showFavicons = !state.showFavicons;
    },
    toggleConfirmBeforeDelete: (state) => {
      state.confirmBeforeDelete = !state.confirmBeforeDelete;
    },
    toggleAllowDuplicateTabs: (state) => {
      state.allowDuplicateTabs = !state.allowDuplicateTabs;
    },
    // 切换通知开关
    toggleShowNotifications: (state) => {
      state.showNotifications = !state.showNotifications;
    },
    // 新增：切换同步开关
    toggleSyncEnabled: (state) => {
      state.syncEnabled = !state.syncEnabled;
    },
    // 切换布局模式
    toggleLayoutMode: (state) => {
      state.useDoubleColumnLayout = !state.useDoubleColumnLayout;
    },
    setReorderMode(state, action) {
      state.reorderMode = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadSettings.fulfilled, (_, action) => {
        return action.payload;
      })
      .addCase(saveSettings.fulfilled, (_, action) => {
        return action.payload;
      })

      // 同步设置到云端
      .addCase(syncSettingsToCloud.fulfilled, (_, action) => {
        return action.payload;
      })

      // 从云端同步设置
      .addCase(syncSettingsFromCloud.fulfilled, (state, action) => {
        if (action.payload) {
          return {
            ...updatedDefaultSettings,
            ...action.payload,
          };
        }
        return state;
      });
  },
});

export const {
  updateSettings,
  setThemeMode,
  setShowFavicons,
  setShowTabCount,
  setShowNotifications,
  setGroupNameTemplate,

  toggleShowFavicons,
  toggleConfirmBeforeDelete,
  toggleAllowDuplicateTabs,
  toggleShowNotifications,
  toggleSyncEnabled,
  toggleLayoutMode,
  setReorderMode,
} = settingsSlice.actions;

export default settingsSlice.reducer;