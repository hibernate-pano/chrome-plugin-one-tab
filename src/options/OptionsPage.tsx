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
} from '@/store/slices/settingsSlice';
import { SYNC_INTERVAL_CHOICES } from '@/utils/storage';
import { sendSyncCommand } from '@/shared/mutationProtocol';
import { ToastProvider, useToast } from '@/contexts/ToastContext';
import { ThemeProvider, useTheme } from '@/contexts/ThemeContext';
import ErrorBoundary from '@/components/common/ErrorBoundary';
import { ThemeStyleSelector } from '@/components/layout/ThemeStyleSelector';
import { WebDavSettings } from '@/components/sync/WebDavSettings';
import {
  getLastBackendResolution,
  invalidateActiveSyncBackend,
  primeSyncBackend,
} from '@/sync-backend';
import {
  canEnableAutoSync,
  classifyBackendResolution,
  UNKNOWN_BACKEND_STATUS,
  type BackendStatus,
} from '@/components/layout/backendStatus';
import { logWarn } from '@/utils/log';

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
 * 「不能开启自动同步」时按真实状态给出的原因（2026-10-16，Wave 2B 缺陷 3）。
 *
 * 每一条都必须指向正确的下一步动作：用户开的这个开关在未配置 / 未解锁时
 * 永远不会跑，拒绝开启的同时要告诉他到底缺哪一步，而不是笼统的「操作失败」。
 */
const AUTO_SYNC_BLOCKED_TOAST: Record<BackendStatus['kind'], string> = {
  // ready 不会走到拒绝分支（canEnableAutoSync 为真时不取这条）；
  // 保留键是为了让索引类型是完整的 kind 联合，编译器能抓到错位的 kind。
  ready: '',
  unconfigured: '还没有配置云盘：先在下方「自带存储配置」填写地址并点「保存并启用」，再开启自动同步',
  locked: '云盘本次会话还没有解锁：先重新输入应用密码与加密口令，再开启自动同步',
  error: '读不到云盘配置或解锁状态，暂时无法开启自动同步；请到下方重新保存配置',
  unknown: '还没有确认云盘状态，暂时无法开启自动同步；请先完成下方云盘配置',
};

const OptionsContent: React.FC = () => {
  const dispatch = useAppDispatch();
  const settings = useAppSelector(state => state.settings);
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

  // 同步后端的真实状态（2026-10-16，Wave 2B 缺陷 3）。
  // 「自动同步」开关不能只读 settings.syncEnabled —— 开着不等于会跑：
  // 未配置 / 未解锁时后台每轮都会在锁定占位后端上失败。这里存最近一次
  // 真实解析结果，用来在开关旁如实说明它现在到底会不会运行。
  const [backendStatus, setBackendStatus] = useState<BackendStatus>(UNKNOWN_BACKEND_STATUS);

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
   * 重新解析后端并更新本页状态（2026-10-16，Wave 2B 缺陷 3）。
   *
   * 强制重解析（invalidate + prime）而不是复用进程内缓存：用户可能刚在下方
   * 「保存并启用」保存了配置，也可能在另一个窗口改过 —— 缓存里的旧答案
   * 会让这里继续显示「未配置」。不碰网络：只读本地配置与本次会话的解锁状态。
   */
  const refreshBackendStatus = useCallback(async (): Promise<BackendStatus> => {
    let status: BackendStatus;
    try {
      invalidateActiveSyncBackend();
      await primeSyncBackend();
      status = classifyBackendResolution(getLastBackendResolution());
    } catch (err) {
      logWarn('[OptionsPage] 同步后端状态解析失败，按「状态未知」展示:', err);
      status = classifyBackendResolution(null);
    }
    setBackendStatus(status);
    return status;
  }, []);

  // 页面打开与每次回到本页（另一个窗口配置完切回来）都重查一次。
  // 同一页面内保存配置由开关点击前的那次 refreshBackendStatus() 补上。
  useEffect(() => {
    void refreshBackendStatus();
    const onFocus = () => {
      void refreshBackendStatus();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
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
      // 开启前必须重新做一次真实解析：mount 时的答案可能已经过期
      //（用户刚在下方保存了配置，或在另一个窗口改过）。未就绪时**拒绝开启**——
      // 让它开着却永远不会跑，就等于用一个不可能发生的频率欺骗用户。
      const fresh = await refreshBackendStatus();
      if (!canEnableAutoSync(fresh)) {
        showToast(AUTO_SYNC_BLOCKED_TOAST[fresh.kind], 'error');
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
      // 重启后的后果必须写在这句话里：服务端口令只存在于本次浏览器会话的
      // 内存中，重启浏览器后自动同步会停在「未解锁」，直到重新输入应用密码。
      showToast(
        `已开启自动同步，每 ${settings.syncIntervalMinutes} 分钟同步一次；关闭浏览器后需重新输入应用密码才会继续`,
        'success'
      );
    }
  }, [dispatch, settings.syncEnabled, settings.syncIntervalMinutes, notifySwResyncAlarm, showToast, refreshBackendStatus]);

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

  // 2026-10-16：原先这里是 handleSelectBackend —— 双后端选择器（TapStack 云端 /
  // 自带存储），连带它的两个分支函数。
  // 云端后端下线后没有第二个可选项，所以整个 handler 删除。
  // 「用户改了后端要重解析」这件事仍然要做，它已经归 WebDavSettings 的
  // 「保存并启用」负责（那里 invalidates + primes），不在本页重复。

  // 自动同步的说明必须等于真实行为（2026-10-16，Wave 2B 缺陷 3）：
  //   · 未配置 / 未解锁 / 状态不可读时，先说清「现在开了也不会跑」；
  //   · 就绪时说明频率，并点明重启浏览器后需要重新输入应用密码
  //     （webdav/config.ts:31-34 要求这个后果必须出现在 UI 上）。
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
    return settings.syncEnabled
      ? `已开启：每 ${settings.syncIntervalMinutes} 分钟在后台自动同步一次。关闭浏览器后需要重新输入应用密码，自动同步才会继续。`
      : '打开后，TapStack 会按下面的间隔在后台自动同步；关闭浏览器后需要重新输入应用密码才会继续。';
  })();

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
                hint="保存会话成功、同步完成时发浏览器通知。需要扩展的「通知」权限。"
                checked={settings.showNotifications}
                onToggle={handleToggleNotifications}
              />
              <ToggleRow
                label="删除前确认"
                hint="删除整个会话、批量删除时先弹确认。单个标签页的 ✕ 永远直接删。"
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
              hint="会话内容存放在你自己的云盘（WebDAV）。先把下方云盘信息填好，再决定要不要自动同步。"
            />

            {/* 2026-10-16：原先这里是一组双选单选钮（TapStack 云端 / 自带存储）
                + handleSelectBackend。云端后端下线后没有第二个选项，
                一个「只能选它」的开关是噪声而不是控制，所以整块删除。
                真正的主表面是下方的 WebDavSettings 面板（首次进入即展开）。 */}
            <div className="mb-4 rounded-lg border theme-border-default px-3 py-2.5">
              <div className="text-sm font-medium text-gray-800 dark:text-gray-200">
                同步方式：自带存储（WebDAV）
              </div>
              <p className={`mt-0.5 ${hintCls}`}>
                会话内容加密后存到你自己的云盘，不经过 TapStack 的服务器。
                请在下方「自带存储配置」里填写地址并点「保存并启用」。
              </p>
            </div>

            {/* 档位行：**始终渲染**（2026-10-16 与代码对齐）。
                旧注释声称「只在自动同步开着时显示」，但下面是无条件渲染。
                保留常显是有意的：关闭时上一行提示已写明「打开后按下面的
                间隔同步」，先选好档位再开启是常见顺序；藏起来反而让用户在
                开启前看不到可选档位。 */}
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
              hint="填好后点「保存并启用」并先测试连接 —— 保存并启用不会替你验证地址可用性。"
            />

            {/* 这里**无条件**渲染：WebDAV 表单在设置页里不再受
                「syncBackend 是不是 webdav」约束（那正是上一轮修掉的死锁 ——
                面板要切过去才出现，切换入口又在面板里）。
                独立页面天然没有这个循环依赖：用户想配就能配。
                2026-10-16：云端下线后它同时也是**唯一**的主表面，
                不再是一个「可选面板」。 */}
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
 * AppContainer 额外做了 localStorage → IndexedDB 迁移预热（initStorage），
 * 而设置页不需要那一步；且它多了一层 context（Toast/Theme/ErrorBoundary），
 * 本页有自己的一套包装。2026-10-16 删除了原先那一条理由 ——
 * 「AppContainer 挂着 AuthProvider，打开设置就会触发一次整库下载」——
 * AuthProvider 已随账号体系删除，那句话描述的是一个不存在的入口。
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
