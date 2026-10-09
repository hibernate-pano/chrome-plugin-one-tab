import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { UserSettings, LayoutMode, ThemeStyle } from '@/types/tab';
import { storage, DEFAULT_SETTINGS as defaultSettings } from '@/utils/storage';

/**
 * 本会话是否成功读到过真实设置（2026-10-09 数据安全 P1-3）。
 *
 * 【为什么需要这个标记】`storage.getSettings()` 是 fail-closed 的（读失败抛错），
 * 但它的调用方曾把它 fail-open 架空了：
 *   1. loadSettings rejected → extraReducers 只有 fulfilled → Redux 停在 DEFAULT_SETTINGS；
 *   2. ThemeContext catch 后 `finally(setSettingsReady(true))` → 界面照常可用、无提示；
 *   3. 用户此时改任意设置 → saveSettings **盲写整份 state**（不是读-改-写）
 *      → 一整份出厂默认值覆盖真实设置，且无任何报错；
 *   4. 若之后手动上传，还会把默认值 upsert 到云端、扩散到其它设备。
 *
 * 关键陷阱：storage 层的 fail-closed 只保护「读」，**写路径完全没问过
 * 「我手里的这份 state 到底是不是真值」**——同一判据两个调用方口径不一：
 * 后台 backgroundSync 读不到设置会中止本轮同步（见其 :97 的对照注释），
 * UI 侧却继续放行。这条把口径拉回 fail-closed。
 *
 * 放模块级而不是塞进 Redux state：state 的类型就是 UserSettings，混进元数据字段
 * 会让 `setSettings(state)` 把标记本身也写进存储，制造新的污染面。
 */
let settingsReadFailed = false;

// 更新默认设置
const updatedDefaultSettings = {
  ...defaultSettings,
};

const initialState: UserSettings = {
  ...updatedDefaultSettings,
};

export const loadSettings = createAsyncThunk('settings/loadSettings', async () => {
  try {
    const settings = await storage.getSettings();
    settingsReadFailed = false;
    return settings;
  } catch (error) {
    settingsReadFailed = true;
    throw error; // 原样抛给 rejected：调用方要能看到真实失败原因
  }
});

export const saveSettings = createAsyncThunk<UserSettings, void, { state: { settings: UserSettings } }>(
  'settings/saveSettings',
  async (_, { getState }) => {
    // ── 2026-10-09 P1-3 fail-closed：没读到过真值就不许写 ────────────────
    // 此时 state 里是 DEFAULT_SETTINGS（不是用户的设置）。盲写等于把整份
    // 出厂默认值覆盖上去 —— 用户设置无声丢失，手动上传还会扩散到云端。
    // 抛错而不是静默 return：写失败与写成功必须可区分，否则又是一个谎报成功。
    if (settingsReadFailed) {
      throw new Error(
        '设置读取失败，已拒绝写入（避免用默认值覆盖真实设置）。读路径恢复后重试即可。'
      );
    }
    const { settings } = getState();
    await storage.setSettings(settings);
    return settings;
  }
);

/**
 * 调一次 saveSettings 并把**失败原因**交给调用方出声（2026-10-09 P2-1）。
 *
 * 【为什么不直接 await dispatch(...)】`dispatch(thunk)` **永远 resolve**——
 * 即使 thunk 被 reject，它返回的也只是那个 rejected action，不会抛。
 * 所以原代码里 `dispatch(saveSettings())` 不会有 unhandled rejection，
 * 但也**永远不会有人知道写失败了**：开关保持新状态、刷新后回退，全程无声。
 *
 * 【为什么要一个 helper】同一条判定散在 6 个调用点（ThemeContext ×2、
 * Header ×1、HeaderDropdown ×3）迟早改漏一处。判据写一处，调用点只管出声。
 *
 * @returns null = 真的保存成功；否则是用户可读的失败原因
 */
export async function dispatchSaveSettings(
  dispatch: (action: ReturnType<typeof saveSettings>) => unknown
): Promise<string | null> {
  const action = await dispatch(saveSettings());
  const rejectedAction = action as { type?: string; error?: { message?: string } } | undefined;
  if (rejectedAction?.type?.endsWith('/rejected')) {
    return rejectedAction.error?.message ?? '保存设置失败，请重试';
  }
  return null;
}

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
} = settingsSlice.actions;

export default settingsSlice.reducer;
