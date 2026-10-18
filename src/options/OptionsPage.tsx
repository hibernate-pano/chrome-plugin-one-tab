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
  setSyncEnabled,
  setSyncIntervalMinutes,
  toggleCollectPinnedTabs,
  toggleConfirmBeforeDelete,
  toggleShowNotifications,
  updateSettings,
} from '@/store/slices/settingsSlice';
import { getCurrentUser } from '@/store/slices/authSlice';
import { SYNC_INTERVAL_CHOICES } from '@/utils/storage';
import { sendSyncCommand } from '@/shared/mutationProtocol';
import { ToastProvider, useToast } from '@/contexts/ToastContext';
import { ThemeProvider, useTheme } from '@/contexts/ThemeContext';
import ErrorBoundary from '@/components/common/ErrorBoundary';
import { ThemeStyleSelector } from '@/components/layout/ThemeStyleSelector';
import { WebDavSettings } from '@/components/sync/WebDavSettings';
import { logWarn } from '@/utils/log';
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

/** 明暗模式。ThemeContext 的 setThemeMode 收这个联合类型，
 *  但没导出它 —— 这里就地声明，避免为了一个类型去改 context 的公共面。 */
type ThemeMode = 'light' | 'dark' | 'auto';

// ── 视觉基础（对齐 popup 的设计变量，不另起一套） ─────────────────────────
const card =
  'rounded-xl border theme-border-default theme-bg-elevated p-5';
const labelCls = 'mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300';
const hintCls = 'text-xs leading-relaxed text-gray-500 dark:text-gray-400';

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
        showToast(autoSyncBlockedCopy(fresh, isAuthenticated), 'error');
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
        return '尚未登录 TapStack 云端：自动同步即使打开也不会运行（后台每轮都会因未登录跳过）。请先在右上角菜单登录。';
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
          <h1 className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-gray-50">
            TapStack 设置
          </h1>
          <p className={`mt-2 ${hintCls}`}>
            设置保存在本机浏览器中，改动即时生效。这里改的每一项都能在
            <span className="mx-1 font-medium text-gray-700 dark:text-gray-300">扩展图标菜单</span>
            里找到对应入口。
          </p>
        </header>

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
            saveSettings 的三态门禁（pending/ok/failed）——「读到过真值吗」。 */}
        <div
          aria-busy={!settingsReady}
          className={`space-y-6 ${settingsReady ? '' : 'pointer-events-none opacity-50'}`}
        >
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
                        ? 'theme-toggle-on text-white border-transparent'
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
                hint="删除整个会话、批量删除时先弹确认；删掉会话里最后一条标签（等于删掉整个会话）也会先确认。其余单个标签页的 ✕ 直接删。"
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
                      ? 'theme-toggle-on text-white border-transparent'
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
                      ? 'theme-toggle-on text-white border-transparent'
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
                        ? 'theme-toggle-on text-white border-transparent'
                        : 'bg-gray-100 text-gray-600 border-transparent hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
                    }`}
                  >
                    每 {minutes} 分钟
                  </button>
                  ))}
              </div>
              <p className={`mt-2 ${hintCls}`}>
                间隔越短，跨设备看到新内容越快，但出站流量也越多。
              </p>
            </div>
          </section>

          {/* ── WebDAV 配置 ───────────────────────────────────────────── */}
          <section className={card} aria-labelledby="sec-webdav">
            <h3 className="sr-only" id="sec-webdav">
              自带存储配置
            </h3>
            <SectionTitle
              title="自带存储配置"
              hint="填好后点「保存并启用」并先测试连接 —— 切换同步方式不会替你验证地址是否可用。"
            />

            {/* 这里**无条件**渲染：WebDAV 表单在设置页里不再受
                「syncBackend 是不是 webdav」约束（那正是上一轮修掉的死锁 ——
                面板要切过去才出现，切换入口又在面板里）。
                独立页面天然没有这个循环依赖：用户想配就能配。 */}
            <WebDavSettings />
          </section>
        </div>
      </div>
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
