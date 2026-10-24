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
 *   3. 用户此时改任意设置 → 写路径落的是「Redux 里那份」（那会儿是出厂默认值）
 *      → 一整份默认值覆盖真实设置，且无任何报错；
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
 *   t3 写路径把这份默认值当「用户的设置」落盘 → 真实设置被整份覆盖
 * 原实现的门禁只在 catch 里置位，pending 期间它一直是 false，等于没有门禁。
 *
 * ── 2026-10-24 审计 GAP1-1：门禁仍然保留，但理由变了 ────────────────────
 * 写路径现在**按字段**落盘（只写用户动过的字段，见下方 pendingIntent）⇒
 * 出厂默认值已经**不会**被整份写上去了。但门禁不能撤：
 *   · 读失败时，界面显示的是默认值，用户据此做出的判断（「我明明关掉了它」
 *     —— 其实那只是默认值）本身就是错的 ⇒ 让他在错误的界面上操作没有意义；
 *   · 写路径的「磁盘真值」也来自读：读失败时那条读-改-写根本没有底。
 * ⇒ 门禁从「防止整份默认值覆盖」变成「没有真值就别动手」—— 同一个动作，
 * 更准确的理由。
 */
type SettingsReadState = 'pending' | 'ok' | 'failed';
let settingsReadState: SettingsReadState = 'pending';

/**
 * 本 realm 的**设置意图表**（2026-10-24 审计 GAP1-1）。
 *
 * ── 它是什么 ────────────────────────────────────────────────────────────
 * 「用户在界面上动过哪些字段、想改成什么值」——一张**按字段**的表。
 * 落盘时它决定「哪些字段可以离开磁盘上的真值」。
 *
 * ── 修复前的病根 ────────────────────────────────────────────────────────
 * 落盘是**整份盲写**：`storage.setSettings(本 realm 的整份快照)`。
 * 而每个 realm（管理页标签 / 设置页标签 / MV3 SW）各持一份**挂载时的快照**，
 * 于是任何一个 realm 动一下开关，就把**整份**旧快照写回去，把别的 realm 刚
 * 写的值静默盖掉。实测：磁盘上的 `syncBackend` 被改回 `supabase`，界面却仍
 * 显示 WebDAV 选中 ⇒ **界面显示 WebDAV、实际同步打向 TapStack 云端**。
 *
 * ── 为什么判据不能是「两份设置差在哪」──────────────────────────────────
 * 差在哪会把**别的 realm 刚改的字段**也算成本 realm 的改动
 * （本 realm 的快照还没更新）⇒ 照样把它盖回去。
 *
 * ── 为什么也不能只靠「和本 realm 的挂载快照比一比」──────────────────────
 * 挂载快照同样会过期：别的 realm 改了磁盘而本 realm 还没收到通知时，
 * 快照是旧的 ⇒ 用户在界面上点选的那个值**恰好等于旧快照里的值**
 * ⇒「相对快照没变」⇒ 这个字段**不写** ⇒ 用户明明点了「切到自带存储」，
 * 磁盘却还是云端 ⇒ **静默无效的操作**。
 *
 * ⇒ 意图表记的是**动作**（用户点了什么），不是**快照的差异**：
 * 无论磁盘变成什么样，用户点过的那个值都会被写下去。
 *
 * ── 它是 realm 私有的 ───────────────────────────────────────────────────
 * 放模块级（每个执行上下文各有一份模块实例）—— 与 settingsReadState 同一
 * 纪律：不塞进 Redux state（state 的类型就是 UserSettings，混进元数据会让
 * setSettings(state) 把元数据一起写进存储）。
 */
const pendingIntent = new Map<keyof UserSettings, unknown>();

/**
 * UserSettings 的**运行时**字段名清单。
 *
 * 取 DEFAULT_SETTINGS 的键 —— 那是这份类型在运行时唯一真实存在的形状
 * （TS 的 interface 编译后不存在，不能拿来做成员判断）。
 */
const SETTINGS_FIELD_NAMES: ReadonlySet<string> = new Set(Object.keys(defaultSettings));

/**
 * 从 action 里读出「用户动过的字段 → 用户想要的值」。
 *
 * ── 为什么必须看 action，而不是只看 state 的前后差 ──────────────────────
 *
 * 最容易漏掉的一种用户动作：**再点一次当前已经选中的那一项**。
 * 界面停在旧值上时（别的 realm 刚改过、本 realm 还没收到失效通知），
 * 用户点「TapStack 云端」而界面显示的正是「TapStack 云端」⇒
 * **state 前后一模一样** ⇒ 差值为空 ⇒ 这次明确的「我要切回云端」
 * 就被当成了「用户什么都没改」⇒ 不写盘 ⇒ **用户的操作静默无效**。
 *
 * 而 action 的载荷里写着用户要的值（`setSyncBackend('supabase')` /
 * `updateSettings({ syncBackend: 'supabase' })`）⇒ 那才是意图本身。
 *
 * @returns null = 这个 action 没带「用户要的值」（toggle 类）⇒ 退回差值法
 */
function intentFromAction(action: {
  type?: unknown;
  payload?: unknown;
}): Map<keyof UserSettings, unknown> | null {
  const type = typeof action.type === 'string' ? action.type : '';
  const slash = type.indexOf('/');
  if (slash < 0) return null;
  const name = type.slice(slash + 1);
  const payload = action.payload;

  // updateSettings：载荷是「要改的字段们」⇒ 逐个记。
  if (name === 'updateSettings') {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const out = new Map<keyof UserSettings, unknown>();
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      // 只认真正的设置字段：载荷里混进别的键（拼错的列名）时，
      // 那不是设置，不许被写进存储。
      if (SETTINGS_FIELD_NAMES.has(key)) out.set(key as keyof UserSettings, value);
    }
    return out.size > 0 ? out : null;
  }

  // setXxx(值)：reducer 名就是字段名（createSlice 的命名约定）。
  if (!SETTINGS_FIELD_NAMES.has(name)) return null;
  if (payload === undefined || payload === null) return null;
  if (typeof payload === 'object') return null; // 对象型字段不按标量记
  return new Map<keyof UserSettings, unknown>([[name as keyof UserSettings, payload]]);
}

/**
 * 把「这次动作改了哪些字段」记进意图表。
 *
 * 判据的顺序（先 action，后差值）：
 *   ① action 自带「用户要的值」⇒ 以它为准（哪怕 state 没变）；
 *   ② action 不带值（toggle 类）⇒ 用 state 的前后差值。
 *
 * 为什么不逐个 reducer 手写：手写要改十四个 reducer，漏一个就等于那个设置
 * **永远写不进去**（静默失效）；而这里的两条规则是**自动**的 ——
 * 以后新增 reducer 不用改这里，意图照样被捕获。
 *
 * ⚠️ 差值法只对**标量**字段成立（UserSettings 全是标量 ✔）。若将来加入
 * 对象型设置，要改成「按内容比」而不是按引用比，否则每次都会算成「改过」。
 */
function captureIntent(
  before: UserSettings,
  after: UserSettings,
  action: { type?: unknown; payload?: unknown }
): void {
  const fromAction = intentFromAction(action);
  if (fromAction) {
    for (const [key, value] of fromAction) pendingIntent.set(key, value);
    return;
  }
  for (const key of Object.keys(after) as Array<keyof UserSettings>) {
    if (before[key] !== after[key]) pendingIntent.set(key, after[key]);
  }
}

/** 意图表的一份快照（写盘时用它决定写哪些字段）。 */
function snapshotIntent(): Map<keyof UserSettings, unknown> {
  return new Map(pendingIntent);
}

/**
 * 写盘成功后清掉「已经写下去」的意图。
 *
 * 只清**值还等于刚写下去那个值**的条目：用户在写盘期间又改了同一个字段时，
 * 那条新意图必须留下（否则这次改动会被静默丢掉）。
 */
function clearWrittenIntent(written: Map<keyof UserSettings, unknown>): void {
  for (const [key, value] of written) {
    if (pendingIntent.get(key) === value) pendingIntent.delete(key);
  }
}

/**
 * 把意图表盖到一份设置上（读路径用）。
 *
 * 磁盘真值 + 本 realm「还没落盘的用户改动」—— 别人的改动立刻可见，
 * 而用户刚点的那一下不会被重读冲掉（否则界面会「回弹」）。
 */
function applyIntent(settings: UserSettings): UserSettings {
  if (pendingIntent.size === 0) return settings;
  const next = { ...settings };
  for (const [key, value] of pendingIntent) {
    (next as unknown as Record<string, unknown>)[key as string] = value;
  }
  return next;
}

/** 仅供测试：清空意图表（两个 realm 的测试要在同一进程里各演一遍）。 */
export function __resetSettingsIntentForTests(): void {
  pendingIntent.clear();
}

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
    // 读回来的磁盘真值要盖上本 realm「还没落盘的用户改动」——
    // 否则别的 realm 的一次重读会把用户刚点的那一下冲掉（界面回弹）。
    return applyIntent(settings);
  } catch (error) {
    settingsReadState = 'failed';
    throw error; // 原样抛给 rejected：调用方要能看到真实失败原因
  }
});

/**
 * 一次保存的结果。
 *
 * `written` 是「本次真正写下去的字段」—— 界面上用它做**合并**而不是整份替换
 * （见 extraReducers 里 saveSettings.fulfilled 的注释）。
 */
export interface SaveSettingsOutcome {
  /** 落盘后的完整设置（磁盘真值 + 本次改动的字段）。 */
  settings: UserSettings;
  /** 本次真正写下去的字段（其余字段保持磁盘上的原值）。 */
  written: Array<keyof UserSettings>;
}

export const saveSettings = createAsyncThunk<
  SaveSettingsOutcome,
  void,
  { state: { settings: UserSettings } }
>(
  'settings/saveSettings',
  async () => {
    // ── 2026-10-09 P1-3 fail-closed：没读到过真值就不许写 ────────────────
    // 此时 state 里是 DEFAULT_SETTINGS（不是用户的设置）⇒ 界面显示的是一份
    // 假象，用户据此做的判断与真实设置无关；而写路径的「磁盘真值」也来自读，
    // 读不出来时那条读-改-写根本没有底 ⇒ 一律不许动手。
    // 抛错而不是静默 return：写失败与写成功必须可区分，否则又是一个谎报成功。
    if (settingsReadState !== 'ok') {
      throw new Error(
        settingsReadState === 'pending'
          ? '设置还在读取中，已拒绝写入（避免用默认值覆盖真实设置）。稍等片刻重试即可。'
          : '设置读取失败，已拒绝写入（避免用默认值覆盖真实设置）。读路径恢复后重试即可。'
      );
    }

    // ── 2026-10-24 审计 GAP1-1：**字段级**读-改-写 ───────────────────────
    //
    // 修复前：`storage.setSettings(settings)` —— 把**本 realm 的整份快照**写回
    // 存储。而别的 realm 刚写进去的值，被这份旧快照**静默盖掉**（实测：磁盘上
    // 的 syncBackend 被改回 supabase，界面却仍显示 WebDAV 选中 ⇒ WebDAV 用户的
    // 同步静默失效；themeMode 同形）。
    //
    // 现在：只把「**本 realm 的用户动过的字段**」套到**磁盘真值**上写回。
    // 别人的改动不在改动集合里 ⇒ 保得住；用户点过的值一定写得下去 ⇒
    // 不会出现「点了没反应」（判据见 pendingIntent 的注释）。
    const disk = await storage.getSettingsForWrite();
    const intent = snapshotIntent();
    const next: UserSettings = { ...disk };
    for (const [key, value] of intent) {
      // 逐字段赋值而不是 spread：只让**用户动过的**字段离开磁盘真值。
      (next as unknown as Record<string, unknown>)[key as string] = value;
    }

    await storage.setSettings(next);
    clearWrittenIntent(intent);
    return { settings: next, written: [...intent.keys()] };
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
 * 上传路径读的是 `storage.getSettings()`，而 uploadSettings 是**无条件 upsert**
 * ⇒ 界面手上这份旧值迟早会被推到云端 —— 刚从云端落下来的那批值被静默回滚，
 * 其它设备下次下载再复制一遍。两个入口（popup 同步按钮 / 设置页归属决策的
 * 「以云端为准」）必须同一口径，否则同一个产品两种行为。
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
      .addCase(saveSettings.fulfilled, (state, action) => {
        // 只把「本次真正写下去的字段」**合并**进 state。
        //
        // 为什么不是整份替换（action.payload.settings）：写盘有 500ms 防抖窗口，
        // 用户在这期间又改了一项 ⇒ 整份替换会把那项改动**回滚掉**（界面回弹，
        // 而且因为意图表还在，那项改动会在下一次保存时才落盘 ⇒ 用户以为没生效）。
        // 合并 = 只认「这次真的写下去的那几个字段」，其余交给设置失效通道刷新。
        const { settings, written } = action.payload;
        const next = { ...state };
        for (const key of written) {
          (next as unknown as Record<string, unknown>)[key as string] = (
            settings as unknown as Record<string, unknown>
          )[key as string];
        }
        return next;
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

/**
 * 「把设置写进盘上」的**唯一**信号之外的那些 fulfilled，不算用户意图。
 *
 * loadSettings.fulfilled = 「把磁盘真值搬进 state」；
 * saveSettings.fulfilled = 「把刚写下去的字段搬进 state」。
 * 把它们算进意图表就等于「整份盲写」又回来了 —— 那正是 GAP1-1 要消灭的行为。
 */
const NON_USER_INTENT_ACTIONS: ReadonlySet<string> = new Set([
  loadSettings.fulfilled.type,
  saveSettings.fulfilled.type,
]);

const baseSettingsReducer = settingsSlice.reducer;

/**
 * 包一层 reducer：**在动作发生的那一刻**记下「用户动了哪些字段」。
 *
 * 【为什么必须在 reducer 里记】只有 reducer 同时看得见「动作前后的 state」，
 * 而「用户动了哪个字段」这件事正是这个差值 —— 记在别处（UI 事件回调、
 * 中间件、thunk 内部）都会漏掉一部分入口。
 *
 * 【为什么排除 fulfilled】见 NON_USER_INTENT_ACTIONS。
 */
function settingsReducer(
  state: UserSettings | undefined,
  action: Parameters<typeof baseSettingsReducer>[1]
): UserSettings {
  // state 为 undefined 时是初始化（@@redux/INIT）：那时没有「改了什么」可言。
  const before = state ? { ...state } : undefined;
  const result = baseSettingsReducer(state, action);
  if (before && result && !NON_USER_INTENT_ACTIONS.has(action.type)) {
    captureIntent(before, result, action);
  }
  return result;
}

export default settingsReducer;
