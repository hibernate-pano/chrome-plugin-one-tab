import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { UserSettings, LayoutMode, ThemeStyle } from '@/types/tab';
import { storage, DEFAULT_SETTINGS as defaultSettings, invalidateSettingsCache } from '@/utils/storage';
import type { SessionSortKey } from '@/core/sessionSort';

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
 *
 * ── 2026-10-12 P0-2：boolean → 三态，堵住 pending 窗口 ──────────────────
 * 原实现是 `let settingsReadFailed = false`，即「读过失败吗」。但门禁真正要回答的
 * 是「**读到过**真值吗」——两者之间有一段 pending 真空，而它恰是 IndexedDB 冷启动
 * 的**常态窗口**（冷读 / 死句柄看门狗 5s），不是边缘情况：
 *   t0 冷启动 → loadSettings 发出，Redux 停在 DEFAULT_SETTINGS
 *   t1 用户点任意设置项 → dispatch(setX) 改了 Redux
 *   t2 dispatchSaveSettings → 门禁判 `settingsReadFailed === false` → **放行**
 *   t3 storage.setSettings(DEFAULT_SETTINGS 全量) → 真实设置被整份覆盖
 * 原实现的门禁只在 catch 里置位，pending 期间它一直是 false，等于没有门禁。
 *
 * 为什么用「pending 时拒绝写」而不是「saveSettings 内部改成读-改-写」：
 * 后者虽然也能保住数据，但它要求把「用户刚点的那一下」与「磁盘真值」合并，
 * 而调用方（HeaderDropdown 的两个 handler）已经**各自实现了回滚 + toast**
 * （见其 saveError 分支）。三态门禁与这套已有机制天然吻合：**零调用方改动**，
 * 且拒绝发生在写入之前 —— 比「先写再补救」少一次危险的落盘。
 */
type SettingsReadState = 'pending' | 'ok' | 'failed';
let settingsReadState: SettingsReadState = 'pending';

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
    settingsReadState = 'ok';
    return settings;
  } catch (error) {
    settingsReadState = 'failed';
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
    if (settingsReadState !== 'ok') {
      throw new Error(
        settingsReadState === 'pending'
          ? '设置还在读取中，已拒绝写入（避免用默认值覆盖真实设置）。稍等片刻重试即可。'
          : '设置读取失败，已拒绝写入（避免用默认值覆盖真实设置）。读路径恢复后重试即可。'
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

/**
 * 重新从存储读取设置并写回 Redux（供「别的执行上下文改过设置」之后调用）。
 *
 * 【为什么必须与 loadSettings 分开】`loadSettings` 走 `storage.getSettings()`，
 * 那条路带 **60s 进程内缓存**；而覆盖下载（syncEngine.mergeCloudSettingsIntoLocal）
 * 是在 **SW** 里把云端设置合并进存储的，popup / options 各自的缓存副本不会因此
 * 失效。直接 dispatch(loadSettings()) 会在缓存窗口内读回旧值 —— 看起来像修了，
 * 其实没修。所以固定顺序：**先失效缓存，再读**（与 getGroupsForWrite 同一思路）。
 *
 * 【为什么这件事值得单独一个 helper】留着一份过期的 settings state 不只是「显示旧」：
 * saveSettings 是**整份 state 盲写**（不是读-改-写），用户接下来随便改一项设置，
 * 就会把这份旧设置整份写回存储，并随自动上传推到云端 —— 刚从云端落下来的那批值
 * 被静默回滚，其它设备下次下载再复制一遍。两个入口（popup 同步按钮 / 设置页
 * 归属决策的「以云端为准」）必须同一口径，否则同一个产品两种行为。
 *
 * @returns null = 重读成功；否则是用户可读的失败原因
 */
export async function dispatchReloadSettings(
  dispatch: (action: ReturnType<typeof loadSettings>) => unknown
): Promise<string | null> {
  // 顺序即语义：先失效，再读（见上方注释）。
  invalidateSettingsCache();
  const action = await dispatch(loadSettings());
  const rejectedAction = action as { type?: string; error?: { message?: string } } | undefined;
  if (rejectedAction?.type?.endsWith('/rejected')) {
    return rejectedAction.error?.message ?? '重读设置失败，请重新打开本页面';
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

    // ── 2026-10-20 审计 A-9：showFavicons / showTabCount 现在**真被读** ──
    // 修复前它们只有 setter、没有任何 UI 入口，也没有任何渲染点读它们 ——
    // 存着、上云着，用户却拨不动。设置页现在有开关（见 OptionsPage），
    // 渲染点（标签行图标 / 标签数量徽章）按它们的值决定显不显示。
    setShowFavicons: (state, action: PayloadAction<boolean>) => {
      state.showFavicons = action.payload;
    },
    setShowTabCount: (state, action: PayloadAction<boolean>) => {
      state.showTabCount = action.payload;
    },
    setShowNotifications: (state, action: PayloadAction<boolean>) => {
      state.showNotifications = action.payload;
    },

    toggleConfirmBeforeDelete: (state) => {
      state.confirmBeforeDelete = !state.confirmBeforeDelete;
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

    /**
     * 会话列表的排序键（2026-10-22 审计 L-10）。
     *
     * 与 `setLayoutMode` 同一纪律：只改 Redux state，落盘走
     * `dispatchSaveSettings`（fail-closed：没读到真值就拒绝写，见文件头），
     * 非法值由 storage 层的 `validateSessionSort` 兜底（读路径 + 写路径各一道）。
     */
    setSessionSort: (state, action: PayloadAction<SessionSortKey>) => {
      state.sessionSort = action.payload;
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
    /**
     * 自动同步总开关（2026-10-11，1.23.0：默认关闭）。
     *
     * 只改 Redux state，落盘走 dispatchSaveSettings（fail-closed：没读到真值
     * 就拒绝写，见文件头）。alarm 的实际启停由调用方在保存成功后发
     * SYNC/resyncAlarm 消息让 SW 重建 —— 本 reducer 不碰 chrome.*，
     * SW 与 popup 是两个执行上下文，这里直接调 alarms 只改了其中一边的世界。
     */
    setSyncEnabled: (state, action: PayloadAction<boolean>) => {
      state.syncEnabled = action.payload;
    },
    /**
     * 自动同步间隔档位（分钟）。只认 validateSyncIntervalMinutes 的四档：
     * UI 只提供四档选项，此处不再二次校验（单点判据在 storage 层，读路径兜底）。
     */
    setSyncIntervalMinutes: (state, action: PayloadAction<number>) => {
      state.syncIntervalMinutes = action.payload;
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

  toggleConfirmBeforeDelete,
  toggleShowNotifications,
   toggleCollectPinnedTabs,
  setLayoutMode,
  toggleLayoutMode,
  setSessionSort,
  setSyncEnabled,
  setSyncIntervalMinutes,
} = settingsSlice.actions;

export default settingsSlice.reducer;
