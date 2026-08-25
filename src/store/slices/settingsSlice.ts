import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { UserSettings, LayoutMode, ThemeStyle } from '@/types/tab';
import { storage, DEFAULT_SETTINGS as defaultSettings } from '@/utils/storage';

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

export const saveSettings = createAsyncThunk<UserSettings, void, { state: { settings: UserSettings } }>(
  'settings/saveSettings',
  async (_, { getState }) => {
    const { settings } = getState();
    await storage.setSettings(settings);
    return settings;
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

    // 设置主题风格
    setThemeStyle: (state, action: PayloadAction<ThemeStyle>) => {
      state.themeStyle = action.payload;
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
    // 切换是否收集固定标签页
    toggleCollectPinnedTabs: (state) => {
      state.collectPinnedTabs = !state.collectPinnedTabs;
    },
    // 设置布局模式
    setLayoutMode: (state, action: PayloadAction<LayoutMode>) => {
      state.layoutMode = action.payload;
    },

    // 切换布局模式（循环切换：单栏 -> 双栏 -> 单栏）
    toggleLayoutMode: (state) => {
      switch (state.layoutMode) {
        case 'single':
          state.layoutMode = 'double';
          break;
        case 'double':
          state.layoutMode = 'single';
          break;
        default:
          state.layoutMode = 'single';
      }
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
  },
});

export const {
  updateSettings,
  setThemeMode,
  setThemeStyle,
  setShowFavicons,
  setShowTabCount,
  setShowNotifications,
  setGroupNameTemplate,

  toggleShowFavicons,
  toggleConfirmBeforeDelete,
  toggleAllowDuplicateTabs,
  toggleShowNotifications,
   toggleCollectPinnedTabs,
  setLayoutMode,
  toggleLayoutMode,
  setReorderMode,
} = settingsSlice.actions;

export default settingsSlice.reducer;