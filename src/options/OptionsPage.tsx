/**
 * TapStack 设置页（options page，2026-10-14）。
 *
 * ── 为什么这些设置原本挤在 popup 菜单里是错的 ──────────────────────────
 * popup 宽度上限 256px（`w-64`）。设置项里含一个 WebDAV 表单：6 个输入框 +
 * 加密单选组 + 4 个按钮。把表单展开进下拉菜单的实测后果：
 *   · 按钮行要横向滚动才看得全；
 *   · 菜单是**瞬态**的（点别处就消失），而这里要填 URL、账号、应用密码、
 *     加密口令 —— 全是需要回看和斟酌的长文本；
 *   · 菜单里本来已经挤着七八行设置，没有剩余空间。
 * 这个页面是 Chrome 的 `options_ui`，独立窗口、独立生命周期，关闭时状态保留。
 *
 * ── 与 popup 的关系（重要，不要误改成跨窗口实时同步） ───────────────────
 * 两边共用同一份 `chrome.storage.local`（utils/storage.ts）。**不需要**
 * `chrome.storage.onChanged` 做双向同步：popup 每次打开都重新 `loadSettings()`，
 * 且它在关闭期间不显示任何东西，不存在两个窗口互相覆盖的窗口期。
 * 反过来说，如果将来让 options 页开着、popup 也开着（用户可以并排两个窗口），
 * 那么**两边同时改设置会后写覆盖先写** —— 这是共享存储的固有性质，
 * 本页不做乐观锁。真要防，得给每次写入加版本号并在读时比对，超出当前需要。
 *
 * ── 诚实度纪律（与 popup 原有实现一致，不许为了好看而放松） ─────────────
 * 详见 WebDavSettings.tsx 文件头：文案必须等于真实行为。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import {
  dispatchSaveSettings,
  loadSettings,
  setShowFavicons,
  setShowTabCount,
  setSyncEnabled,
  setSyncIntervalMinutes,
  toggleCollectPinnedTabs,
  toggleConfirmBeforeDelete,
  toggleShowNotifications,
  updateSettings,
} from '@/store/slices/settingsSlice';
import { getCurrentUser, signOut } from '@/store/slices/authSlice';
import { SYNC_INTERVAL_CHOICES } from '@/utils/storage';
import { sendSyncCommand } from '@/shared/mutationProtocol';
import { ToastProvider, useToast } from '@/contexts/ToastContext';
import { ThemeProvider, useTheme } from '@/contexts/ThemeContext';
import ErrorBoundary from '@/components/common/ErrorBoundary';
import { ThemeStyleSelector } from '@/components/layout/ThemeStyleSelector';
import { WebDavSettings } from '@/components/sync/WebDavSettings';
import { logError, logWarn } from '@/utils/log';
import {
  getLastBackendResolution,
  // 切换后端是**真实的设置变更**：旧适配器持有的 Vault 与连接已经不对，
  // 必须重建（与 refreshBackendResolutionOnly 的「只读状态」语义相反）。
  invalidateActiveSyncBackend,
  primeSyncBackend,
  refreshBackendResolutionOnly,
} from '@/sync-backend';
// B8 缺陷 3（2026-10-17，从 slim 适配双模式）：自动同步在「配置 + 解锁」前
// 不得被打开。修复前开关可以先亮、再报错，而它会永远不跑 ——
// 等于用一个不可能发生的频率欺骗用户。
import {
  autoSyncBlockedCopy,
  canEnableAutoSync,
  classifyBackendResolution,
  type BackendStatus,
} from '@/components/layout/backendStatus';
import { WEBDAV_CONFIG_CHANGED_EVENT } from '@/sync-backend/webdav/config';
// 2026-10-20 第二轮审计：设置页的信息架构判据（纯函数，可测）。
import {
  collapsiblePanelState,
  managerPageExitAction,
  MANAGER_PAGE_PATH,
  shouldCollapseWebDavSection,
  syncIntervalHint,
} from './optionsPageIa';
// 2026-10-20 第二轮审计：账号区域的判据与文案（纯函数，可测）。
import {
  accountPanelMode,
  loginHintCopy,
  type AccountPanelMode,
} from './optionsAccount';
import { AuthModal, type AuthTab } from '@/components/auth/AuthModal';
import { ChevronIcon } from '@/components/common/ChevronIcon';
import { TapStackIcon } from '@/components/common/TapStackIcon';
import { loadWebDavConfig } from '@/sync-backend/webdav/config';

/** 明暗模式。ThemeContext 的 setThemeMode 收这个联合类型，
 *  但没导出它 —— 这里就地声明，避免为了一个类型去改 context 的公共面。 */
type ThemeMode = 'light' | 'dark' | 'auto';

/**
 * 设置表单容器的属性（2026-10-18 A7）。
 *
 * 【为什么不直接写在 JSX 里】这条属性是**唯一的键盘闸门**，而它的正确形状很挑：
 *   · `pointer-events-none` 只拦**指针**，不拦**键盘** —— 容器里的控件本来就是
 *     原生可聚焦的（`role="switch"` 的按钮、四个 `role="radio"`、select），
 *     所以键盘用户 Tab 到「自动同步」按 Enter 仍会触到 onToggle ⇒ 乐观 dispatch
 *     + fail-closed 拒写 + 弹一条他从未触发的错误 toast。
 *   · 必须用 `inert` 而不是 `disabled`：disabled 会改变灰态语义（控件不再被读屏
 *     当作「存在的项」），而这里是「正在加载」不是「此项禁用」。
 *   · React 18 不认 `inert={true}`（会报 non-boolean attribute 且**真的不落到
 *     DOM**），`inert={'' | undefined}` 又被 @types/react 拒 —— 只能用展开对象。
 * 抽成纯函数后，它的输出可以被真的渲染成 HTML 来断言（见
 * tests/optionsInertGate.test.ts）。
 *
 * 就绪时**不输出该属性**（不是输出 false）：`inert={false}` 在 React 18 下同样
 * 是一个警告源，而且 `inert="false"` 在 HTML 里是**真值**（字符串非空）——
 * 那会把就绪后的表单永久锁死。
 */
export function formContainerGateProps(settingsReady: boolean): {
  'aria-busy': boolean;
  inert?: '';
  className: string;
} {
  return {
    'aria-busy': !settingsReady,
    ...(settingsReady ? {} : { inert: '' as const }),
    // pointer-events-none / opacity-50 保留：视觉与指针语义没变，只是补上键盘那道闸。
    className: `space-y-6 ${settingsReady ? '' : 'pointer-events-none opacity-50'}`,
  };
}

// ── 视觉基础（对齐 popup 的设计变量，不另起一套） ─────────────────────────
const card =
  'rounded-xl border theme-border-default theme-bg-elevated p-5';
const labelCls = 'mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300';
// 2026-10-20 审计 D-2：说明文字原先写死 Tailwind 灰阶（text-gray-500 / dark:text-gray-400），
// 不跟主题走 —— claude/apple/prism 浅色下只有 4.16–4.47:1，creamy 深色 4.42:1，
// 都低于 WCAG AA 的 4.5:1。改用主题令牌 theme-text-muted（各主题实测 ≥4.5:1）。
// 硬编码的 dark: 变体特异性 (0,3,0) 会盖过 .theme-text-muted (0,1,0)，
// 所以必须整段删掉，不能"再补一个主题类"。
const hintCls = 'text-xs leading-relaxed theme-text-muted';

/** 分组标题 + 一行说明。说明必须写清「这个设置的作用范围」，不能只写标签。 */
const SectionTitle: React.FC<{ title: string; hint?: string }> = ({ title, hint }) => (
  <div className="mb-4">
    <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
    {hint ? <p className={`mt-1 ${hintCls}`}>{hint}</p> : null}
  </div>
);

/**
 * 开关行。整行可点，右侧 toggle 只做状态显示（不单独可聚焦 ——
 * 那会造出两个可点区域且其中一个点不中）。
 */
const ToggleRow: React.FC<{
  label: string;
  hint: string;
  checked: boolean;
  onToggle: () => void;
}> = ({ label, hint, checked, onToggle }) => (
  <div className="flex items-start justify-between gap-4 py-3">
    <div className="min-w-0 flex-1">
      <div className="text-sm font-medium text-gray-800 dark:text-gray-200">{label}</div>
      <div className={`mt-0.5 ${hintCls}`}>{hint}</div>
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onToggle}
      className="shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors mt-0.5
        focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
    >
      <span
        className={`absolute inset-0 rounded-full transition-colors ${
          checked ? 'theme-toggle-on' : 'theme-toggle-off'
        }`}
      />
      <span
        className={`relative inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  </div>
);

/**
 * 「自动同步开启被拒绝」的提示文案已移入 backendStatus.autoSyncBlockedCopy
 * （2026-10-18 P1#1）。
 *
 * 移出去的理由：原先这张表挂在 OptionsPage 里、只按 `kind` 取值，于是它
 * **无法表达云端未登录** —— 那是 kind='ready' 落在表外的一条路径，也是
 * 「云端假绿灯」的根因。文案与判据必须同处一个模块、共享同一份后端信息，
 * 否则改判据的人看不到文案、改正文的人碰不到判据。
 */

const OptionsContent: React.FC = () => {
  const dispatch = useAppDispatch();
  const settings = useAppSelector(state => state.settings);
  // 2026-10-18 P1#1：云端的就绪判据必须看登录态 —— Supabase 解析永远没有
  // lockedReason，不看它就分不出「已登录」与「从未登录」。
  const isAuthenticated = useAppSelector(state => state.auth.isAuthenticated);
  const { themeMode, setThemeMode } = useTheme();
  const { showToast } = useToast();

  // ── 设置是否已从存储读到真值 ──────────────────────────────────────────
  // 这个标记**直接决定保存能不能放行**，不是装饰。settingsSlice 的
  // saveSettings 是 fail-closed 的：没读到过真值就拒写（否则会用出厂
  // 默认值覆盖用户真实设置）。所以在读到之前必须把表单整体禁用 ——
  // 否则用户点一下开关，界面立刻变，然后被静默拒绝，表现为
  // 「开关翻不动 / 刷新后又变回去」。
  const [settingsReady, setSettingsReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 同步后端状态（2026-10-17 B8 缺陷 3）：自动同步开关的放行判据，
  // 以及「未就绪」提示文案的真值来源。默认 unknown = 保守（不放行、不说就绪）。
  const [backendStatus, setBackendStatus] = useState<BackendStatus>(() =>
    classifyBackendResolution(null)
  );

  // ── 2026-10-20 第二轮审计：设置页自己的三个缺口 ───────────────────────
  //
  // ① **账号入口**：设置页此前**没有任何登录入口**，而它的提示文案却让用户
  //    「去右上角菜单登录」—— 而本页没有右上角菜单。于是云端用户
  //    （默认后端）永远开不了自动同步，也不知道为什么。
  //    现在本页提供登录 / 退出入口。
  //
  // ② **「自带存储配置」默认展开**：那块表单是设置页里最长的一块，
  //    而 90% 的用户用默认的 Supabase 后端，永远不碰它。
  //    默认折叠，首屏留给真正常用的项。
  //
  // ③ **出口**：设置页是独立标签页，改完设置想回列表只能靠浏览器「后退」，
  //    而从扩展详情页进来时历史是空的 ⇒ 用户卡在这个页面里。
  const [authModal, setAuthModal] = useState<AuthTab | null>(null);
  const [webDavExpanded, setWebDavExpanded] = useState<boolean | null>(null);
  const [isWebDavConfigured, setIsWebDavConfigured] = useState(false);

  // 账号区形态：已登录 / 未登录（要提示）/ 不需要账号（自带存储）。
  const accountMode: AccountPanelMode = accountPanelMode(
    settings.syncBackend,
    isAuthenticated
  );
  const authUserEmail = useAppSelector(state => state.auth.user?.email ?? null);

  /**
   * 「自带存储配置」区块当前是不是展开的。
   *
   * `webDavExpanded === null` = **用户还没表态** ⇒ 用判据算初始值
   * （`shouldCollapseWebDavSection`）。用户一旦手动点过，就以他的选择为准，
   * 不再被自动改回去 —— 自动改回去会让「我刚展开就被折叠了」变成一个
   * 说不清的 bug。
   */
  const isWebDavPanelExpanded =
    webDavExpanded ??
    !shouldCollapseWebDavSection(settings.syncBackend, isWebDavConfigured);

  useEffect(() => {
    let alive = true;
    const action = dispatch(loadSettings()) as unknown as Promise<{ error?: { message?: string } }>;
    Promise.resolve(action)
      .then(res => {
        if (!alive) return;
        // dispatch(thunk) 永远 resolve（reject 也只是 resolve 一个 action），
        // 判据必须看 type/error，不能看 then 有没有走 catch。
        if (res && typeof res === 'object' && 'error' in res && res.error) {
          setLoadError(res.error.message ?? '读取设置失败');
          return;
        }
        setSettingsReady(true);
      })
      .catch(err => {
        if (!alive) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [dispatch]);

  /**
   * 补一次登录态注入（2026-10-18 round 28）。
   *
   * 【为什么本页必须自己来】`state.auth.isAuthenticated` 只由 `getCurrentUser` / `signIn`
   * 建立，而 Redux store 是**每个执行上下文各一份**。popup 由 AuthProvider 负责这一步，
   * 本页刻意不挂 AuthProvider —— 它登录成功后会顺手发一次整库自动下载，那是 popup 专属行为。
   * 于是这里的登录态**恒为 false**，而它现在是一门开关的唯一判据：
   * 自动同步的闸门 `canEnableAutoSync` 对云端后端要求 isAuthenticated
   * （见 components/layout/backendStatus.ts）⇒ 云端用户（默认后端）永远开不了自动同步，
   * 还被告知「尚未登录 TapStack 云端」，而他们本来就是登录状态。
   *
   * 【为什么直接 dispatch getCurrentUser 而不是先 getSession】那个 thunk 内部已经先查会话、
   * 无会话时直接返回 null（不会抛错），所以这一次调用对未登录用户是零网络开销的。
   *
   * 结果只写 Redux，不改任何设置 —— 与「登录后自动下载」是两件事，不要合并。
   */
  useEffect(() => {
    void dispatch(getCurrentUser());
  }, [dispatch]);

  /**
   * 通知 SW 重建自动同步 alarm。
   *
   * popup 与 options 页是两个执行上下文，这里改了 settings 只改了**本页**的
   * 世界；SW 那边要靠消息才知道周期变了。发完不管回执（失败只记日志）——
   * SW 重启本来就会读最新设置重建，丢了消息能自愈，不值得为此打扰用户。
   */
  const notifySwResyncAlarm = useCallback(() => {
    sendSyncCommand('resyncAlarm')
      .then(res => {
        if (!res.ok) logWarn('[OptionsPage] 通知 SW 重建同步 alarm 未成功，下次启动自愈:', res.error);
      })
      .catch(err => logWarn('[OptionsPage] 通知 SW 重建同步 alarm 异常，下次启动自愈:', err));
  }, []);

  /**
   * 读一次**真实**的后端状态（2026-10-17 B8 缺陷 3）。
   *
   * 为什么必须按需重解析而不是复用 mount 时的答案：用户可能刚在下方点过
   * 「保存并启用」保存了配置，也可能在另一个窗口改过 —— 缓存里的旧答案
   * 会让这里继续显示「未配置」。不碰网络：只读本地配置与本次会话的解锁状态。
   */
  const refreshBackendStatus = useCallback(async (): Promise<BackendStatus> => {
    let status: BackendStatus;
    try {
      // 2026-10-18 P2-6：同 HeaderDropdown —— 只重算状态，不重建适配器。
      // 每次窗口聚焦都重建 ⇒ 每次都丢弃已派生的 Vault（PBKDF2 250k 轮）。
      await refreshBackendResolutionOnly();
      status = classifyBackendResolution(getLastBackendResolution());
    } catch (err) {
      logWarn('[OptionsPage] 同步后端状态解析失败，按「状态未知」展示:', err);
      status = classifyBackendResolution(null);
    }
    setBackendStatus(status);
    return status;
  }, []);

  // 页面打开与每次回到本页（另一个窗口配置完切回来）都重查一次。
  //
  // 2026-10-18 P2-4：同页面内的子组件（WebDavSettings）保存 / 锁定 / 清除配置后
  // 也要刷新。此前只靠「开关点击前的那一次」补，而子组件的三条路径
  // （handleSave / handleLock / handleForget）都不经过开关 ⇒ 用户点完「锁定」
  // 仍看到「已配置并解锁」，直到窗口重新聚焦。
  //
  // 为什么用 window 事件而不是 props 回调：WebDavSettings 自己也订阅了
  // 同一个事件（用它刷新本组件的 resolvedBackend），父子各自订阅一份。
  // 代价是多一次 DOM 事件，收益是没有单向数据流与渲染顺序的耦合。
  useEffect(() => {
    void refreshBackendStatus();
    const onFocus = () => {
      void refreshBackendStatus();
    };
    const onBackendChanged = () => {
      void refreshBackendStatus();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener(WEBDAV_CONFIG_CHANGED_EVENT, onBackendChanged);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener(WEBDAV_CONFIG_CHANGED_EVENT, onBackendChanged);
    };
  }, [refreshBackendStatus]);

  /**
   * 读一次「有没有配过 WebDAV」（2026-10-20 第二轮审计）。
   *
   * 为什么要单独读：`loadWebDavConfig()` 返回 `null` 表示「**从未配过**」，
   * 而「配过」这件事决定「自带存储配置」区块要不要默认展开：
   * 已经配过的人每次进来都想一眼看到「我的云盘配好了」，
   * 从没配过的人（且用的是云端）不需要为一块用不到的表单让出首屏。
   *
   * ⚠️ 只读、不写：这里绝不能顺手把配置写进任何地方。
   */
  useEffect(() => {
    let alive = true;
    loadWebDavConfig()
      .then(cfg => {
        if (!alive) return;
        setIsWebDavConfigured(!!cfg);
      })
      .catch(err => {
        // 读不到配置 ⇒ 保守地当成「没配过」（默认折叠）。
        // 读失败不该把整页变成一个错误 —— 用户要改的是主题，不是云盘。
        logWarn('[OptionsPage] 读取 WebDAV 配置失败，自带存储区块按未配置处理:', err);
      });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * 「回到 TapStack」（2026-10-20 第二轮审计）。
   *
   * 【为什么要显式出口】设置页是 `open_in_tab: true` 打开的**独立标签页**。
   * 用户改完设置想回会话列表，按浏览器的「后退」常常根本没用 ——
   * 他可能是从扩展详情页的「扩展选项」进来的，那条历史里没有管理页。
   * ⇒ 用户卡在这个页面里，只能手动去开一个新标签。
   *
   * 【为什么不关掉这个标签页】用户可能是在**另一个窗口**里开着管理页
   * （设置页的用途就是「改设置时不打断工作」）。直接关掉设置页会让他
   * 回到一个他不认识的空窗口。所以是「切过去」，不是「关掉」。
   *
   * 两条路径（已有就切、没有就开）与 `TabManager.openTabManager` 完全一致 ——
   * 同一个语义，不该有两个实现。
   */
  const handleBackToManager = useCallback(async () => {
    try {
      const managerUrl = chrome.runtime.getURL(MANAGER_PAGE_PATH);
      const existing = await chrome.tabs.query({ url: managerUrl + '*' });
      const action = managerPageExitAction(existing.length > 0);
      if (action === 'focus-existing' && existing[0].id !== undefined) {
        await chrome.tabs.update(existing[0].id, { active: true });
        // 切到那个标签还不够 —— 它可能在**另一个窗口**里，
        // 而那个窗口可能没有焦点。连带把窗口也点亮，否则用户点了没反应。
        await chrome.windows.update(existing[0].windowId, { focused: true });
      } else {
        await chrome.tabs.create({ url: managerUrl });
      }
    } catch (err) {
      logError('[OptionsPage] 打开管理页失败:', err);
      showToast('打开管理页失败，请在扩展图标上点一下回到 TapStack', 'error');
    }
  }, [showToast]);

  /**
   * 退出登录（2026-10-20 第二轮审计）。
   *
   * 【为什么要本页也能退出】本页现在有登录入口，那它就必须也能退出 ——
   * 否则用户在这页登录了账号，却只能跑到管理页去退。
   *
   * 失败必须出声：静默失败会让用户以为已退出，而实际上仍是登录态
   * （与管理页的那条路径同一纪律）。
   */
  const handleSignOut = useCallback(async () => {
    try {
      await dispatch(signOut()).unwrap();
      showToast('已退出登录', 'success');
    } catch (err) {
      logError('[OptionsPage] 退出登录失败:', err);
      showToast('退出登录失败，请重试', 'error');
    }
  }, [dispatch, showToast]);

  const handleToggleNotifications = useCallback(async () => {
    dispatch(toggleShowNotifications());
    const saveError = await dispatchSaveSettings(dispatch);
    if (saveError) showToast(saveError, 'error');
  }, [dispatch, showToast]);

  const handleToggleConfirmDelete = useCallback(async () => {
    dispatch(toggleConfirmBeforeDelete());
    const saveError = await dispatchSaveSettings(dispatch);
    if (saveError) showToast(saveError, 'error');
  }, [dispatch, showToast]);

  const handleToggleCollectPinnedTabs = useCallback(async () => {
    dispatch(toggleCollectPinnedTabs());
    const saveError = await dispatchSaveSettings(dispatch);
    if (saveError) showToast(saveError, 'error');
  }, [dispatch, showToast]);

  // ── 2026-10-20 审计 A-9：showFavicons / showTabCount 的**真入口** ────────
  // 修复前这两个设置存着、上云着，却没有任何入口也没有任何读取方 ——
  // favicon 永远显示、标签数量永远显示，用户拨不动。
  //
  // 【为什么要回滚】dispatch 已经把 Redux 改了，但 dispatchSaveSettings 可能
  // 失败（磁盘写不进去）⇒ 界面显示「已关」而存储里还是「开」。
  // 与 handleToggleAutoSync 同一纪律：保存失败就把 UI 收回磁盘真值，
  // 并用一条 toast 说清「失败原因 + 现在实际是什么状态」。
  const handleToggleShowFavicons = useCallback(async () => {
    const next = !settings.showFavicons;
    dispatch(setShowFavicons(next));
    const saveError = await dispatchSaveSettings(dispatch);
    if (saveError) {
      dispatch(setShowFavicons(settings.showFavicons));
      showToast(`${saveError}（网站图标开关已恢复为${settings.showFavicons ? '显示' : '隐藏'}）`, 'error');
    }
  }, [dispatch, settings.showFavicons, showToast]);

  const handleToggleShowTabCount = useCallback(async () => {
    const next = !settings.showTabCount;
    dispatch(setShowTabCount(next));
    const saveError = await dispatchSaveSettings(dispatch);
    if (saveError) {
      dispatch(setShowTabCount(settings.showTabCount));
      showToast(`${saveError}（标签数量开关已恢复为${settings.showTabCount ? '显示' : '隐藏'}）`, 'error');
    }
  }, [dispatch, settings.showTabCount, showToast]);

  const handleToggleAutoSync = useCallback(async () => {
    const nextEnabled = !settings.syncEnabled;

    if (nextEnabled) {
      // 开启前必须重新做一次真实解析（2026-10-17 B8 缺陷 3）：mount 时的答案
      // 可能已经过期（用户刚在下方保存了配置，或在另一个窗口改过）。
      // 未就绪时**拒绝开启** —— 让它开着却永远不会跑，就等于用一个不可能
      // 发生的频率欺骗用户。判据必须排在 dispatch(setSyncEnabled) **之前**：
      // 先开后拒 = 开关闪一下又弹错。
      //
      // ── 2026-10-18 P1#1：门禁纳入登录态 ────────────────────────────────
      // 云端解析出的状态恒为 ready（supabase 分支不检查登录态），所以只判
      // kind 会给「从未登录的云端用户」放行 —— 那正是 B8 之前的假绿灯换个
      // 方向又出现了一次：开关亮着、toast 承诺会跑、后台每轮 not_logged_in。
      // WebDAV 不需要登录（账号自带），由 canEnableAutoSync 按后端分流。
      //
      // ⚠️ `isAuthenticated` 必须进本回调的依赖数组（round 28）：它是**异步注入**的
      // （见上面的 getCurrentUser effect），漏进 deps 会让这个回调永远闭包在首帧的
      // `false` 上 —— 页面提示行已经改口说「已登录」，点开关却仍被按「未登录」拒绝。
      const fresh = await refreshBackendStatus();
      if (!canEnableAutoSync(fresh, isAuthenticated)) {
        // '本页'：设置页没有「⋯」菜单 —— 登录入口在**本页**顶部的
        // 「登录 / 注册」按钮上。说「菜单」会让用户去找一个不存在的菜单。
        showToast(autoSyncBlockedCopy(fresh, isAuthenticated, '本页'), 'error');
        return;
      }
    }

    dispatch(setSyncEnabled(nextEnabled));
    const saveError = await dispatchSaveSettings(dispatch);
    if (saveError) {
      // 保存失败必须把 UI 收回磁盘真值：reducer 已经改了 Redux，但
      // storage.setSettings 抛错 ⇒ 磁盘仍是旧值。不回滚的话界面显示
      // 「已开启」而后台 alarm 仍按「关闭」跑（或反之），用户完全不知情。
      // 一条 toast 说清全部（失败原因 + 现在实际是什么状态）。
      dispatch(setSyncEnabled(settings.syncEnabled));
      showToast(`${saveError}（自动同步开关已恢复为${settings.syncEnabled ? '开启' : '关闭'}）`, 'error');
      return;
    }
    notifySwResyncAlarm();
    if (nextEnabled) {
      showToast(
        `已开启自动同步，每 ${settings.syncIntervalMinutes} 分钟同步一次。` +
          // config.ts 明确要求 UI 把「重启后要重新输密码」说出来：
          // MV3 的会话密钥不落盘，浏览器一关就没了，自动同步会停在锁定态。
          '关闭浏览器后需重新输入应用密码才会继续。',
        'success'
      );
    }
  }, [dispatch, isAuthenticated, settings.syncEnabled, settings.syncIntervalMinutes, notifySwResyncAlarm, showToast]);

  /**
   * 自动同步开关的说明文案（2026-10-17 B8 缺陷 3）。
   *
   * 为什么要按后端状态分支：修复前这里只按 settings.syncEnabled 二选一，
   * 于是「没配云盘」的用户也看到「每 10 分钟同步一次」—— 而它永远不会跑。
   * 未就绪时必须说清「开了也不会运行」以及**怎么才能运行**。
   *
   * ⚠️ 双模式：上面的未就绪分支描述的是自带存储（WebDAV）。选了 TapStack
   * 云端时 backendStatus 是 ready，会落到下面的正常分支 —— 云端不涉及
   * 「应用密码 / 云盘」这些概念，所以正常分支的措辞用中性的「同步」。
   */
  const autoSyncHint = (() => {
    if (backendStatus.kind === 'unconfigured') {
      return '云盘尚未配置：自动同步即使打开也不会运行。请先在下方「自带存储配置」填写并点「保存并启用」。';
    }
    if (backendStatus.kind === 'locked') {
      return '云盘本次会话尚未解锁：重新输入应用密码与加密口令之前，自动同步不会运行。';
    }
    if (backendStatus.kind === 'error' || backendStatus.kind === 'unknown') {
      return '云盘状态读取失败：暂时无法确认自动同步能否运行，请在下方重新保存配置。';
    }
    // ── 2026-10-18 P1#1：走到这里说明后端就绪，但「就绪」对两个后端含义不同 ──
    // 云端适配器不检查登录态 ⇒ ready 只说明「对象造出来了」。未登录时若照旧
    // 说「打开后会每 N 分钟同步」，就是 B8 修掉的那种假绿灯。
    // 措辞也必须按后端分开：云端要的是**登录**，不是「重新输入应用密码」。
    if (backendStatus.backendId === 'supabase') {
      if (!isAuthenticated) {
        // ── 2026-10-20 第二轮审计：这是一句**指向不存在的东西**的话 ──────
        // 原文案让用户「去右上角菜单登录」—— 而**设置页没有右上角菜单**
        // （那是管理页顶栏的东西）。用户照做得到的是「找一个不存在的菜单」。
        // 现在指向本页真实存在的「登录 / 注册」按钮。
        return loginHintCopy('supabase');
      }
      return settings.syncEnabled
        ? `已开启：每 ${settings.syncIntervalMinutes} 分钟在后台自动同步一次。`
        : `打开后，TapStack 会按下面的间隔在后台自动同步（需保持登录状态）。`;
    }
    return settings.syncEnabled
      ? `已开启：每 ${settings.syncIntervalMinutes} 分钟在后台自动同步一次。关闭浏览器后需要重新输入应用密码，自动同步才会继续。`
      : '打开后，TapStack 会按下面的间隔在后台自动同步；关闭浏览器后需要重新输入应用密码才会继续。';
  })();

  const handleSetSyncInterval = useCallback(async (minutes: number) => {
    if (minutes === settings.syncIntervalMinutes) return;
    dispatch(setSyncIntervalMinutes(minutes));
    const saveError = await dispatchSaveSettings(dispatch);
    if (saveError) {
      dispatch(setSyncIntervalMinutes(settings.syncIntervalMinutes));
      showToast(`${saveError}（同步间隔已恢复为 ${settings.syncIntervalMinutes} 分钟）`, 'error');
      return;
    }
    notifySwResyncAlarm();
  }, [dispatch, settings.syncIntervalMinutes, notifySwResyncAlarm, showToast]);

  const handleSelectBackend = useCallback(async (next: 'supabase' | 'webdav') => {
    if (next === settings.syncBackend) return;
    const prevBackend = settings.syncBackend;
    // 2026-10-18 round 33：这次 dispatch 同时改了两个字段，回滚就必须**成对**。
    // 只还原 syncBackend 会留下「界面显示自动同步已关、磁盘上还开着」的分叉：
    // 用户接下来改任何一项设置都会把 syncEnabled:false 整份盲写回去，
    // 静默关掉他的自动同步（对照 handleToggleAutoSync 的完整回滚写法）。
    const prevSyncEnabled = settings.syncEnabled;
    dispatch(updateSettings({ syncBackend: next, syncEnabled: false }));
    const saveError = await dispatchSaveSettings(dispatch);
    if (saveError) {
      dispatch(updateSettings({ syncBackend: prevBackend, syncEnabled: prevSyncEnabled }));
      showToast(
        `${saveError}（同步方式已恢复为「${prevBackend === 'webdav' ? '自带存储' : 'TapStack 云端'}」，` +
          `自动同步开关已恢复为${prevSyncEnabled ? '开启' : '关闭'}）`,
        'error'
      );
      return;
    }
    notifySwResyncAlarm();
    if (next === 'supabase') {
      showToast('已切回 TapStack 云端，自动同步已关闭。云盘上的文件不会被删除。', 'success');
    } else {
      // 切到自带存储但**可能还没配好**：这时若不提醒，用户会以为已经生效。
      showToast('已切到自带存储。若还没填地址，请在下方填好后点「保存并启用」并测试连接。', 'info');
    }
    // 本页的后端缓存也要失效 + 重解析：notifySwResyncAlarm 只管 SW 那边，
    // 不管本页。下次在本页点同步/预览时透传层会复用本页缓存，旧后端就阴魂不散。
    // 切到 webdav 但还没解锁时，解析结果是锁定占位（明确报错，不静默走 Supabase）。
    invalidateActiveSyncBackend();
    try {
      await primeSyncBackend();
    } catch (err) {
      logWarn('[OptionsPage] 切换后端后重解析失败（下次调用自愈）:', err);
    }
    // 2026-10-17 B8（浏览器实测抓到）：切换后端后必须刷新**本页显示的**
    // 后端状态。原先这里只做了 invalidate + prime（为了缓存与 SW 一致性），
    // 没有 setBackendStatus —— 于是 backendsStatus 仍是改动前的值，
    // 「自动同步」的 hint 继续显示旧后端的结论。
    //
    // 实测症状：默认（TapStack 云端）时 hint 是「打开后…会按间隔同步」，
    // 用户切到未配置的「自带存储」后 hint **不变**，仍在承诺会自动同步 ——
    // 而实际上点开关会被拒绝（闸门是好的）。承诺与行为不一致，正是本组
    // 缺陷要消灭的那类「假绿灯」。
    //
    // 注：refreshBackendStatus 自带 invalidate + prime，所以上面那次
    // prime 只是为了让本页缓存预热（切完立刻点同步也不用再解析一次）；
    // 这里再调一次拿分类结果，代价是一次本地存储读。
    await refreshBackendStatus();
  }, [dispatch, settings.syncBackend, settings.syncEnabled, notifySwResyncAlarm, showToast, refreshBackendStatus]);

  return (
    <div className="app-shell theme-shell min-h-screen dark:text-gray-100">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-10 space-y-6">
        <header>
          {/* ── 出口：回到会话列表（2026-10-20 第二轮审计）────────────────
              设置页是独立标签页，从扩展详情页进来时浏览器历史里**没有**
              管理页 ⇒ 「后退」不是可靠的出路。必须有一条永远存在的显式出口。
              这条链接在页首第一屏，不需要用户先滚。 */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            {/* ── 2026-10-22 审计 L-4：设置页补上品牌标识 ──────────────────
                管理页顶栏有橙色品牌标 + 「TapStack」，设置页首行却只有一行
                纯文字「TapStack 设置」。而设置页是**独立标签页**，
                很多人是从 chrome://extensions 的「扩展选项」进来的 ——
                他看到的第一个东西不像这个产品的一部分。
                复用同一个品牌图标组件（TapStackIcon），不新画一个。 */}
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-gray-900 dark:text-gray-50">
              <TapStackIcon size={26} className="flex-shrink-0" />
              TapStack 设置
            </h1>
            <button
              type="button"
              onClick={() => {
                void handleBackToManager();
              }}
              // ── 颜色用 theme-text-primary 而不是 theme-accent-text ──────────
              // 真机实测（scripts/prod-a11y.mjs）：accent 作 13px 小字时，
              // apple 浅色 4.34:1、claude 浅色 4.22:1，**都低于 AA 的 4.5:1**。
              // 根因是 accent 是**当背景色**调的（配 --color-accent-fg 用），
              // 拿来当墨色就不够深。theme-text-primary 是主题的最强文字色，
              // 各主题实测均远高于 4.5:1。
              //
              // 这个按钮是**次级导航**（回列表），不是主 CTA ——
              // 主 CTA 是下面账号区的「登录 / 注册」（走 theme-cta：
              // accent 当底、accent-fg 当字，那才是 accent 的正确用法）。
              className="inline-flex items-center gap-1.5 rounded-lg border theme-border-default px-3 py-1.5 text-sm font-medium theme-text-primary transition-colors hover:theme-btn-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
                focusable="false"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
              回到 TapStack
            </button>
          </div>
          <p className={`mt-2 ${hintCls}`}>
            设置保存在本机浏览器中，改动即时生效。「⋯」菜单里的「设置…」可再次进入本页。
          </p>
        </header>

        {/* ── 账号区（2026-10-20 第二轮审计）──────────────────────────────
            设置页此前**没有任何登录入口**，而它的提示文案却让用户
            「去右上角菜单登录」—— 而本页没有右上角菜单。
            用户照做得到的是「找一个不存在的菜单」，于是云端用户
            （默认后端）永远开不了自动同步，也不知道为什么。

            现在本页自带登录 / 退出入口。

            ⚠️ 用自带存储（WebDAV）的人**不显示这一块**：TapStack 账号
            对他毫无意义（账号由他自己的云盘提供）。给一个 WebDAV 用户
            显示「去登录」是纯噪音，还会让他以为不用 WebDAV 就不能用这个扩展。
            判据见 optionsAccount.accountPanelMode。 */}
        {accountMode === 'not-needed' ? null : (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border theme-border-default theme-bg-elevated px-4 py-3">
            {accountMode === 'signed-in' ? (
              <>
                <div className="min-w-0">
                  <div className="text-sm font-medium theme-text-primary">
                    已登录 TapStack 云端
                  </div>
                  <div className={`mt-0.5 truncate ${hintCls}`}>{authUserEmail ?? '账号已登录'}</div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    void handleSignOut();
                  }}
                  className="shrink-0 rounded-lg border theme-border-default px-3 py-1.5 text-sm font-medium theme-text-secondary transition-colors hover:theme-btn-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
                >
                  退出登录
                </button>
              </>
            ) : (
              <>
                <div className="min-w-0">
                  <div className="text-sm font-medium theme-text-primary">
                    尚未登录 TapStack 云端
                  </div>
                  <div className={`mt-0.5 ${hintCls}`}>
                    登录后自动同步才能运行。本页下方「数据同步」里的自动同步开关
                    在未登录时会被拒绝 —— 登录后才能打开。
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setAuthModal('login')}
                  className="shrink-0 rounded-lg theme-cta px-3 py-1.5 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
                >
                  登录 / 注册
                </button>
              </>
            )}
          </div>
        )}

        {/* ── 读取失败必须挡在表单之外 ──────────────────────────────────
            读失败时 Red 那一份 Redux 里是**出厂默认值**，而 saveSettings 是
            fail-closed 的（没读到真值就拒写）。若此时表单可点，用户改任何一项
            都会得到「界面变了但存不下去」，而且没有任何解释。 */}
        {loadError ? (
          <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
            <div className="font-medium">设置读取失败，下面的改动暂时无法保存</div>
            <div className="mt-1 leading-relaxed">{loadError}</div>
            <div className="mt-1.5 text-xs">
              请关闭这个窗口重新打开。若仍然失败，说明是本机存储的问题，
              而不是设置内容有问题。
            </div>
          </div>
        ) : null}

        {/* 读取完成前禁用整个表单。disabled 的理由写在这里而不是散落各处：
            saveSettings 的三态门禁（pending/ok/failed）——「读到过真值吗」。

            2026-10-18 A7：光靠 `pointer-events-none` 不够 —— 它只拦**指针**，
            不拦**键盘**。里边的控件本身就是原生可聚焦的（role="switch" 的按钮、
            四个 role="radio"、select），于是 settingsReady===false 的那个窗口
            （挂载 → loadSettings resolve；存储坏了则是永久）里，键盘用户 Tab 到
            「自动同步」按 Enter 仍然会触到 onToggle ⇒ 乐观 dispatch + fail-closed
            拒写 + 弹一条他从未触发的错误 toast。

            用 `inert` 而不是 `disabled`：disabled 会改变灰态语义（disabled 控件
            不被读屏朗读为「不可用但存在」，也不会被辅助技术当作占位）—— 而这里是
            「正在加载」，不是「此项对本用户禁用」。inert 同时接管聚焦、点击、
            辅助技术可见性三件事，与现有的 pointer-events-none / opacity-50 叠用不冲突。
            manifest.json 已声明 minimum_chrome_version=120（inert 需 Chrome 102+）。

            ⚠️ React 18 不认由 `inert` 绑定的布尔值（会报 non-boolean attribute 且
            真的不落到 DOM），而 `inert={'' | undefined}` 又被 @types/react 拒绝 ——
            因此属性形状抽到了 formContainerGateProps（见那里的注释与行为断言）。 */}
        <div {...formContainerGateProps(settingsReady)}>
          {/* ── 数据同步 ─────────────────────────────────────────────── */}
          <section className={card} aria-labelledby="sec-sync">
            <h3 className="sr-only" id="sec-sync">
              数据同步
            </h3>
            <SectionTitle
              title="数据同步"
              hint="会话内容同步到哪里。先决定跟谁同步，再决定要不要自动。"
            />

            <div className="mb-4" role="radiogroup" aria-label="同步方式">
              <label className={labelCls}>同步方式</label>
              <div className="mt-1.5 flex gap-2">
                <button
                  type="button"
                  role="radio"
                  aria-checked={settings.syncBackend === 'supabase'}
                  onClick={() => handleSelectBackend('supabase')}
                  className={`flex-1 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors border ${
                    settings.syncBackend === 'supabase'
                      ? 'theme-toggle-on border-transparent'
                      : 'bg-gray-100 text-gray-600 border-transparent hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
                  }`}
                >
                  TapStack 云端
                  <div className="mt-0.5 text-xs font-normal opacity-90">
                    需要登录，跨设备自动同步
                  </div>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={settings.syncBackend === 'webdav'}
                  onClick={() => handleSelectBackend('webdav')}
                  className={`flex-1 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors border ${
                    settings.syncBackend === 'webdav'
                      ? 'theme-toggle-on border-transparent'
                      : 'bg-gray-100 text-gray-600 border-transparent hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
                  }`}
                >
                  自带存储（WebDAV）
                  <div className="mt-0.5 text-xs font-normal opacity-90">
                    数据只存你自己的云盘，不经过 TapStack
                  </div>
                </button>
              </div>
            </div>

            {/* 档位行：**始终渲染** ——
                注释原先写「只在自动同步开着时显示」，但下方 radiogroup 是
                无条件渲染的（2026-10-17 B8 缺陷 4 对齐注释与代码）。

                为什么保留常显：把「多久跑一次」藏起来，用户想设的时候找不到；
                而它本身没有副作用 —— 真正决定跑不跑的是上面的开关与后端的
                就绪状态。档位行下方有 hint 说清「未就绪时开了也不会运行」，
                所以常显不会让人误以为改了档位就生效。 */}
            <ToggleRow
              label="自动同步"
              hint={autoSyncHint}
              checked={settings.syncEnabled}
              onToggle={handleToggleAutoSync}
            />

            <div className="mt-2">
              <label className={labelCls} htmlFor="opt-sync-interval">
                同步间隔
              </label>
              <div className="mt-1.5 flex flex-wrap gap-2" role="radiogroup" aria-label="同步间隔">
                {SYNC_INTERVAL_CHOICES.map(minutes => (
                  <button
                    key={minutes}
                    type="button"
                    role="radio"
                    aria-checked={settings.syncIntervalMinutes === minutes}
                    onClick={() => handleSetSyncInterval(minutes)}
                    className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors border ${
                      settings.syncIntervalMinutes === minutes
                        ? 'theme-toggle-on border-transparent'
                        : 'bg-gray-100 text-gray-600 border-transparent hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
                    }`}
                  >
                    每 {minutes} 分钟
                  </button>
                  ))}
              </div>
              <p className={`mt-2 ${hintCls}`}>
                {/* 2026-10-20 第二轮审计：这一档**始终渲染**（仓库里已定的
                    2026-10-17 B8 决定，配套守卫 tests/syncStatusHonesty.test.ts
                    钉着「档位行：**始终渲染**」）。但「始终渲染」不等于
                    「不生效也要说」—— 自动同步关着时，用户改这一档什么都不会发生。
                    把这件事写清楚，比把控件藏起来诚实（藏起来会让人以为
                    这个功能不存在）。判据与文案都在 optionsPageIa。 */}
                {syncIntervalHint(settings.syncEnabled)}
              </p>
            </div>
          </section>

          {/* ── WebDAV 配置 ───────────────────────────────────────────── */}
          {/* ── 自带存储配置 ───────────────────────────────────────── */}
          <section className={card} aria-labelledby="sec-webdav">
            <h3 className="sr-only" id="sec-webdav">
              自带存储配置
            </h3>

            {/* ── 2026-10-20 第二轮审计：默认折叠 ─────────────────────────
                这块表单是设置页里**最长**的一块（地址、账号、应用密码、
                加密口令、测试连接、保存、清除配置）。而 90% 的用户用默认的
                Supabase 后端，**永远不碰它** —— 默认展开等于让一块用不到的
                表单占掉首屏，把真正要设的「同步方式」「自动同步」挤到下面。

                判据见 optionsPageIa.shouldCollapseWebDavSection：
                  · 从没配过 + 用的是云端 ⇒ 折叠；
                  · 已经配过 ⇒ 展开（他每次进来都想一眼看到「配好了」）；
                  · 用的是自带存储 ⇒ 展开（这块表单是他要用的）。

                ⚠️ 折叠**不是**「按 syncBackend 条件渲染」——
                那样就回到上一轮修掉的死锁了（面板要切过去才出现，
                切换入口又在面板里）。这里面板**永远在**，只是默认收起来。
                用户随时能展开。 */}
            <button
              type="button"
              onClick={() => setWebDavExpanded(!isWebDavPanelExpanded)}
              aria-expanded={isWebDavPanelExpanded}
              aria-controls="webdav-settings-panel"
              className="w-full flex items-center justify-between gap-3 text-left rounded-lg px-1 py-1 -mx-1 hover:theme-btn-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
            >
              <span className="min-w-0">
                <span className="block text-base font-semibold theme-text-primary">
                  自带存储配置
                </span>
                <span className={`mt-0.5 block ${hintCls}`}>
                  {isWebDavConfigured
                    ? '已配置。填好后点「保存并启用」并先测试连接 —— 切换同步方式不会替你验证地址是否可用。'
                    : '填好后点「保存并启用」并先测试连接 —— 切换同步方式不会替你验证地址是否可用。'}
                </span>
              </span>
              <ChevronIcon isExpanded={isWebDavPanelExpanded} className="shrink-0 theme-text-muted" />
            </button>

            {/* 收起时用**两个**通道把内容移出可交互树：
                · hidden —— 让浏览器真的把它移出 Tab 序列（否则键盘用户会
                  Tab 进一片看不见的输入框，盲按 Enter 就可能提交一份表单）；
                · aria-hidden —— 告诉读屏软件它不存在。
                先例：ThemeStyleSelector 的主题列表同一套做法
                （tests/a11yLists.test.ts 钉着它）。 */}
            <div
              id="webdav-settings-panel"
              {...collapsiblePanelState(isWebDavPanelExpanded)}
              className="mt-4"
            >
              {/* 这里**无条件**渲染：WebDAV 表单在设置页里不再受
                  「syncBackend 是不是 webdav」约束（那正是上一轮修掉的死锁 ——
                  面板要切过去才出现，切换入口又在面板里）。
                  独立页面天然没有这个循环依赖：用户想配就能配。 */}
              <WebDavSettings />
            </div>
          </section>
          {/* ── 标签页 ────────────────────────────────────────────────── */}
          <section className={card} aria-labelledby="sec-tabs">
            <h3 className="sr-only" id="sec-tabs">
              标签页
            </h3>
            <SectionTitle title="标签页" />

            <div className="divide-y divide-gray-200 dark:divide-gray-700">
              <ToggleRow
                label="显示通知提醒"
                hint="保存会话成功时发浏览器通知。失败提示不受此开关影响，始终会通知。需要扩展的「通知」权限。"
                checked={settings.showNotifications}
                onToggle={handleToggleNotifications}
              />
              <ToggleRow
                label="删除前确认"
                // ── 2026-10-19 审计 R-2：承诺必须覆盖真实的手势 ────────────
                // 原文只说「删掉会话里最后一条标签（等于删掉整个会话）也会先确认」，
                // 而用户最常用的手势是**拖**（把最后一条标签拖到别的会话）——
                // 那条路直接让整个会话消失，无确认（2026-10-19 产品决定：
                // 拖拽是连续手势，弹框与拖后回滚都是新交互且更差）。
                // 设置页写「会先确认」而实际不确认，用户按「我开了保护」的
                // 预期行事 ⇒ 真的丢了一组会话。
                //
                // ── 2026-10-20 审计 A-3：锁定会话的删除**始终**确认 ────────
                // 这个开关管的是「日常删除要不要问一句」；删除锁定会话是
                // 越权动作（用户显式保护过它），开关关掉就悄悄删，等于把
                // 「锁定」变回一句谎话。所以这里必须写明例外，否则用户会
                // 以为关掉开关后锁定会话一点就掉。
                hint="删除整个会话、批量删除时先弹确认；用 ✕ 删掉会话里最后一条标签（等于删掉整个会话）也会先确认。单个标签页的 ✕ 直接删；把最后一条标签拖到别的会话会直接让整个会话消失，不受本开关保护。锁定的会话无论开关如何，删除前都会先提示「该会话已锁定」。"
                checked={settings.confirmBeforeDelete}
                onToggle={handleToggleConfirmDelete}
              />
              <ToggleRow
                label="保存时收集固定标签页"
                hint="把浏览器里钉住的标签页也一并存进会话，方便回来时恢复现场。"
                checked={settings.collectPinnedTabs}
                onToggle={handleToggleCollectPinnedTabs}
              />
            </div>
          </section>

          {/* ── 同步 ──────────────────────────────────────────────────── */}
          {/* ── 外观 ─────────────────────────────────────────────────── */}
          <section className={card} aria-labelledby="sec-appearance">
            <SectionTitle
              title="外观"
              hint="主题风格影响全局配色；明暗模式跟随系统或由你指定。"
            />
            <h3 className="sr-only" id="sec-appearance">
              外观
            </h3>

            <div className="mb-4">
              <label className={labelCls} htmlFor="opt-theme-mode">
                明暗模式
              </label>
              <div className="flex gap-2" role="radiogroup" aria-label="明暗模式">
                {([
                  ['auto', '跟随系统'],
                  ['light', '始终浅色'],
                  ['dark', '始终深色'],
                ] as const).map(([value, text]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={themeMode === value}
                    onClick={() => setThemeMode(value as ThemeMode)}
                    className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors border ${
                      themeMode === value
                        ? 'theme-toggle-on border-transparent'
                        : 'bg-gray-100 text-gray-600 border-transparent hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
                    }`}
                  >
                    {text}
                  </button>
                ))}
              </div>
            </div>

            <div className="mb-2">
              <span className={labelCls}>主题风格</span>
              <p className={`mb-2 ${hintCls}`}>
                点下面任意一个预览即时切换，全局配色（含这个页面）立刻跟随。
              </p>
              {/* alwaysExpanded：设置页整页都是空白，收起主题列表等于让用户
                  先点一下才知道能换主题。Playwright 实测过折叠态下卡片带
                  `hidden`，是自动化与键盘用户的死区。 */}
              <ThemeStyleSelector alwaysExpanded />
            </div>

            {/* ── 2026-10-20 审计 A-9：两个「真被读」的显示开关 ──────────────
                这两个开关挂在「外观」小节（不是「标签页」）：它们决定的是
                **界面上显示什么**，不是「保存时做什么」。放错小节会让用户
                在「保存时收集固定标签页」旁边找到「显示网站图标」——
                那是两件完全不同的事。
                逐条对应关系（改 UI 时别只改一处）：
                  显示网站图标 → 会话内的标签行 + 搜索结果里的标签行
                  显示标签数量 → 会话卡片徽章 + 搜索结果徽章 + 顶栏「N 标签」 */}
            <div className="divide-y divide-gray-200 dark:divide-gray-700">
              <ToggleRow
                label="显示网站图标"
                hint="在会话的标签行和搜索结果里显示每个网站的图标。关掉后这些位置不再显示图标。"
                checked={settings.showFavicons}
                onToggle={handleToggleShowFavicons}
              />
              <ToggleRow
                label="显示标签数量"
                hint="在会话卡片、搜索结果和顶栏显示标签数量。关掉后这些位置的数字不再显示。"
                checked={settings.showTabCount}
                onToggle={handleToggleShowTabCount}
              />
            </div>
          </section>

        </div>
      </div>

      {/* ── 登录 / 注册弹窗（2026-10-20 第二轮审计）──────────────────────
          设置页此前**没有登录入口**，而提示文案却让用户「去右上角菜单登录」
          —— 本页没有右上角菜单。现在本页自带入口。

          ⚠️ 为什么挂在这里而不是页首那一行：AuthModal 走 createPortal
          渲染到 document.body，所以它在 JSX 里的**位置不影响**视觉位置
          （它固定居中于视口）。挂在组件树末尾是为了不打断页首的阅读顺序。

          ⚠️ 登录成功会触发一次整库下载（restoreAfterLogin）——
          那是**显式意图**（用户刚敲了账号密码，就是想看到另一台设备的会话），
          不是后台轮询。所以在这里挂 AuthModal 是安全的：
          设置页不挂 AuthProvider（那才是「打开设置就变成一次后台同步」的原因），
          而登录这件事本身就是用户主动做的。 */}
      <AuthModal
        visible={authModal !== null}
        initialTab={authModal ?? 'login'}
        onClose={() => setAuthModal(null)}
      />
    </div>
  );
};

/**
 * 设置页根组件：包齐 popup 侧那三层 Provider。
 *
 * 为什么这里必须自己包一遍，而不是复用 AppContainer：
 * AppContainer 内部挂了 AuthProvider，而 AuthProvider 在挂载后**立刻**
 * 向 Supabase 查会话，命中就自动触发一次整库下载（跨设备找回）。
 * 设置页没有任何理由触发这种流量 —— 用户只是想改个主题。
 * 直接复用 AppContainer 会让「打开设置」变成一次后台同步。
 */
export const OptionsPage: React.FC = () => (
  <ErrorBoundary>
    <ToastProvider>
      <ThemeProvider>
        <OptionsContent />
      </ThemeProvider>
    </ToastProvider>
  </ErrorBoundary>
);

export default OptionsPage;
