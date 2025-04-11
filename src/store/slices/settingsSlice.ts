import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { UserSettings } from '@/types/tab';
import { storage, DEFAULT_SETTINGS as defaultSettings } from '@/utils/storage';
import { sync as supabaseSync } from '@/utils/supabase';

// 更新默认设置
const updatedDefaultSettings = {
  ...defaultSettings,
};

const initialState: UserSettings = updatedDefaultSettings;

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
export const syncSettingsToCloud = createAsyncThunk<UserSettings, void, { state: { settings: UserSettings } }>(
  'settings/syncSettingsToCloud',
  async (_, { getState }) => {
    const settings = getState().settings;
    await supabaseSync.uploadSettings(settings);
    return settings;
  }
);

// 新增：从云端同步设置
export const syncSettingsFromCloud = createAsyncThunk(
  'settings/syncSettingsFromCloud',
  async () => {
    const settings = await supabaseSync.downloadSettings();
    if (settings) {
      // 保存到本地存储
      await storage.setSettings(settings);
      return settings;
    }
    return null;
  }
);

const settingsSlice = createSlice({
  name: 'settings',
  initialState,
  reducers: {

    setShowFavicons: (state, action: PayloadAction<boolean>) => {
      state.showFavicons = action.payload;
    },
    setShowTabCount: (state, action: PayloadAction<boolean>) => {
      state.showTabCount = action.payload;
    },
    setAutoCloseTabsAfterSaving: (state, action: PayloadAction<boolean>) => {
      state.autoCloseTabsAfterSaving = action.payload;
    },
    setAutoSaveInterval: (state, action: PayloadAction<number>) => {
      state.autoSaveInterval = action.payload;
    },
    setGroupNameTemplate: (state, action: PayloadAction<string>) => {
      state.groupNameTemplate = action.payload;
    },
    // 删除定时同步间隔设置
    toggleAutoSave: (state) => {
      state.autoSave = !state.autoSave;
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
    // 新增：切换同步开关
    toggleSyncEnabled: (state) => {
      state.syncEnabled = !state.syncEnabled;
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
  setShowFavicons,
  setShowTabCount,
  setAutoCloseTabsAfterSaving,
  setAutoSaveInterval,
  setGroupNameTemplate,

  toggleAutoSave,
  toggleShowFavicons,
  toggleConfirmBeforeDelete,
  toggleAllowDuplicateTabs,
  toggleSyncEnabled,
} = settingsSlice.actions;

export default settingsSlice.reducer;