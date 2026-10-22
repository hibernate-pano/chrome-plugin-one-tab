import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { useAppSelector, useAppDispatch } from '@/store/hooks';
import { signOut } from '@/store/slices/authSlice';
import { MENU_LOGIN_LABEL } from '@/components/common/menuLabels';
import { deleteAllGroups, deleteBroadcastWarn, loadGroups } from '@/store/slices/tabSlice';
import { dispatchReloadSettings } from '@/store/slices/settingsSlice';
import { sendSyncCommand } from '@/shared/mutationProtocol';
import { storage } from '@/utils/storage';
import type { AuthTab } from '../auth/AuthModal';
import { useToast } from '@/contexts/ToastContext';
import { trackProductEvent } from '@/utils/productEvents';
import {
  collectDiagnostics,
  diagnosticsFileName,
  diagnosticsSummaryText,
  serializeDiagnosticsReport,
} from '@/utils/diagnostics';
import { logError, logInfo, logWarn } from '../../utils/log';
// B8（2026-10-17，从 slim 适配双模式）：同步状态行的两个真值来源。
import {
  getLastBackendResolution,
  refreshBackendResolutionOnly,
} from '@/sync-backend';
import {
  BACKEND_STATUS_DOT_CLASS,
  BACKEND_STATUS_TITLE,
  classifyBackendResolution,
  formatLastSyncTime,
  UNKNOWN_BACKEND_STATUS,
  type BackendStatus,
} from './backendStatus';
import { remainingViewportHeight } from './dropdownLayout';
import { autoPullStatusView } from './autoPullStatusCopy';
import {
  collectFocusableMenuItemIndices,
  resolveMenuNavigation,
} from '@/utils/menuKeyboard';
import { registerFocusReturn } from '@/utils/focusReturn';
import { deleteAllConfirmMessage, deleteAllMenuWarning, deleteAllShouldPushOverwrite } from './deleteAllMessages';
import { importPartialMessage, importSuccessMessage } from './importResultCopy';
import { countOneTabGroups } from '@/core/oneTabFormatParser';
import { resolveMenuSyncStatus, resolveSyncFailureCopy } from '@/components/sync/syncPreviewView';
import { skippedOverwriteNotice } from '@/components/sync/skippedOverwriteNotice';

/** 问题反馈落点：GitHub issues 新建页。用户自己决定粘不粘诊断摘要。 */
const FEEDBACK_ISSUE_URL = 'https://github.com/hibernate-pano/chrome-plugin-one-tab/issues/new';

/**
 * 复制文本到剪贴板，两级降级，返回是否真的写进去了。
 *
 * 为什么不静默：用户点了「问题反馈」却在 issue 里发现没有摘要，只能自己去翻
 * 扩展目录找文件——那等于这个功能没做。所以失败必须让用户看见，且要给他一条
 * 还能拿到内容的路（把摘要原文摆在弹窗里，手动复制）。
 * 第一级用 Clipboard API；它在非安全上下文或权限被拒时抛错，此时退回
 * execCommand（老但可用），再失败就交给调用方弹窗。
 */
const copyTextToClipboard = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    logWarn('Clipboard API 写入失败，降级到 execCommand:', error);
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch (error) {
    logError('剪贴板降级路径也失败:', error);
    return false;
  }
};

interface HeaderDropdownProps {
  onClose: () => void;
  /** 打开应用级登录/注册弹窗（由 Header 托管，portal 到 body）。 */
  onOpenAuth: (tab: AuthTab) => void;
  /** 窄屏顶栏把布局切换收进了菜单，这里复用 Header 同一份逻辑，避免两份实现分叉。 */
  onToggleLayout?: () => void;
  /** 窄屏顶栏把「清理重复」收进了菜单，同上：复用 Header 的确认弹窗与执行路径。 */
  onRequestCleanDuplicates?: () => void;
  /**
   * 清理重复标签**正在进行中**（2026-10-22 审计 U-20 之后的接线）。
   *
   * 这个动作原先住在顶栏的一颗按钮上，`disabled={isCleaningDuplicates}` 直接
   * 钉在按钮上。U-20 之后入口搬进了本菜单 ⇒ 「清理中禁点」这件事必须跟着搬，
   * 否则用户可以在清理进行中再点一次（同一个动作跑两遍）。
   *
   * 同时它也是「进行中」的可见信号：菜单项转圈 + aria-busy。
   */
  isCleaningDuplicates?: boolean;
  /**
   * 重放用户引导（2026-10-20 审计 B-2）。
   *
   * 为什么菜单里要有这一项：引导是**一次性**的，跳过就再也回不去了。
   * 用户跳过的常见理由是「现在没空」，不是「我不需要」——
   * 两天后他想知道「云端同步怎么开」，必须有个入口能回去看。
   * 没有这一项时，他只能去翻文档或重装扩展。
   */
  onReplayOnboarding?: () => void;
  /**
   * 挂载时**直接展开**哪个子菜单（2026-10-22 审计 L-11）。
   *
   * 背景：空态给「导入数据」一个出口，而导入的实现（文件选择、解析、
   * 成功报数量、失败报原因）长在这个组件里 —— 200 多行，
   * 复制一份到空态就是两套实现漂移的起点。
   * 所以空态只发一个「打开导入」的意图，由 Header 打开菜单并把导入子菜单
   * 展开到这里：用户看到的仍是**同一个**导入流程（连格式选择都是同一组按钮）。
   *
   * 只在**挂载时**读一次（见 openSubmenu 的初始值），
   * 所以必须由调用方在消费后清掉待办，否则下次打开菜单还会自动展开它。
   */
  initialSubmenu?: 'export' | 'import' | null;
  /** 子菜单初始值被读走后的回调（调用方据此清待办）。 */
  onInitialSubmenuConsumed?: () => void;
}

/** 菜单行的统一 hover 反馈。菜单行不做位移（flat-interaction 的 -translate-y 会轻微跳动），只做背景色。 */
const MENU_ROW = "w-full text-left px-4 py-2 text-sm theme-text-primary flex items-center transition-colors duration-150 theme-menu-hover";

/**
 * 读一次**真实**的后端状态（2026-10-17 B8，从 slim 适配双模式）。
 *
 * 为什么每次打开菜单都强制重解析（`invalidateActiveSyncBackend` + `primeSyncBackend`）：
 * `activeBackend` 是**本执行上下文**的进程内缓存，用户在另一个窗口的设置页
 * 改完配置后，popup 这边不会收到任何通知。状态行要回答的是「现在到底能不能
 * 同步」，不是「这个页面半分钟前解析出了什么」，所以必须重新读设置与解锁状态。
 * 解析本身不碰网络（构造适配器不发请求），代价只有一次本地存储读。
 *
 * 双模式说明：分类结果里「未配置/未解锁」指的是**自带存储（WebDAV）**；
 * 用户选了 TapStack 云端时解析出的是 supabase 适配器、没有 lockedReason，
 * 分类为 ready。状态行的前缀（下方 JSX）按 settings.syncBackend 区分两者。
 */
async function readBackendStatus(): Promise<BackendStatus> {
  try {
    // 2026-10-18 P2-6：只重算解析状态，**不** invalidate + prime。
    // 原先每次打开菜单都重建适配器 ⇒ WebDAV 的 Vault 被丢弃 ⇒ 下一次同步
    // 要重跑 250k 轮 PBKDF2。「打开菜单看看状态」不该付这个代价。
    // 真正要同步时仍走 ensureBackendPrimed / primeSyncBackend（那里才重建）。
    await refreshBackendResolutionOnly();
    return classifyBackendResolution(getLastBackendResolution());
  } catch (error) {
    logWarn('[HeaderDropdown] 同步状态解析失败，按「状态未知」展示:', error);
    return classifyBackendResolution(null);
  }
}


export const HeaderDropdown: React.FC<HeaderDropdownProps> = ({
  onClose,
  onOpenAuth,
  onToggleLayout,
  onRequestCleanDuplicates,
  isCleaningDuplicates,
  onReplayOnboarding,
  initialSubmenu,
  onInitialSubmenuConsumed,
}) => {
  const dispatch = useAppDispatch();
  const { isAuthenticated, user } = useAppSelector(state => state.auth);
  // 2026-10-17 B8：不再从 tabs 取 lastSyncTime。
  // 该字段全仓没有任何 reducer / thunk 写入（零写方），读它等于
  // 「上次同步」这一行永远不渲染。真值在 storage.getLastSyncTime()。
  const { groups } = useAppSelector(state => state.tabs);
  // 2026-10-20 审计 A-3：「删除所有会话」对锁定会话走**方案 B** ——
  // 全部删除，但确认框与菜单行必须**点名**「其中包含 N 个已锁定的会话」。
  // 理由写在 deleteAllMessages.ts 的文件头（跳过锁定的残渣无处可去，
  // 而全量物理移除本来就是 v1.22.0 起的明确产品决定）。
  const lockedGroupCount = useMemo(
    () => groups.reduce((acc, g) => (g.isLocked ? acc + 1 : acc), 0),
    [groups]
  );
  const settings = useAppSelector(state => state.settings);
  // ── 2026-10-22 审计 L-11：初始展开的子菜单 ────────────────────────────
  // `initialSubmenu` 只在**挂载时**读一次（这个组件随菜单开关挂载/卸载，
  // 每次打开都是新实例 ⇒ 正好是「这次要不要自动展开导入」的语义）。
  const [openSubmenu, setOpenSubmenu] = useState<'export' | 'import' | null>(initialSubmenu ?? null);

  // 挂载即消费：调用方要在这个子菜单展开状态下被读走一次，
  // 否则「下次打开菜单还会自动展开导入」。
  const consumedRef = useRef(false);
  useEffect(() => {
    if (consumedRef.current) return;
    consumedRef.current = true;
    onInitialSubmenuConsumed?.();
  }, [onInitialSubmenuConsumed]);
  // 就地展开的那块面板。菜单本身可能是个滚动容器（高度上限 = 视口剩余空间），展开出来的两三行
  // 若落在可视区之外，用户看到的仍然是「点了没反应」—— 展开即把它带进视野
  // （block:'nearest' 只在需要时才滚动，不会把整份菜单跳走）。
  const submenuRef = useRef<HTMLDivElement | null>(null);
  // ── 2026-10-20 键盘可达性：导入子菜单的隐藏 file input ────────────────
  // 「导入数据」子菜单的两项原先是 `<label role="menuitem">` + 内嵌
  // `<input type="file" className="hidden">`：label 没有 tabindex（tabIndex=-1）
  // ⇒ **不可聚焦**；内层 input 是 display:none ⇒ 也不可聚焦。
  // 后果：Tab 16 次、方向键 14 次都**从未**落到「JSON 格式」「OneTab 格式」，
  // 而导入是全仓**唯一**的导入入口 ⇒ 键盘用户根本用不了导入。
  //
  // 现在改成真正的 `<button role="menuitem">`，onClick 里点隐藏 input ——
  // 按钮可聚焦、读屏有名字、方向键能选中，input 仍然藏在视觉之外。
  const jsonImportInputRef = useRef<HTMLInputElement | null>(null);
  const oneTabImportInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (openSubmenu) submenuRef.current?.scrollIntoView({ block: 'nearest' });
  }, [openSubmenu]);
  // ── 2026-10-09 P1-5：从云端刷新必须有「进行中 / 成功 / 失败」三态 ──
  // 原先无 isRefreshing、成功也不给任何反馈：点一下如果云端没有新数据，
  // 页面**毫无变化**，用户完全无法区分「已经是最新」「没点上」「坏了」。
  // 同步按钮本体有进度条和 toast，这个刷新快捷入口一条都没有。
  const [isRefreshing, setIsRefreshing] = useState(false);
  // 同步状态行的两个真值（2026-10-17 B8，从 slim 适配）：
  //   · backendStatus ← getLastBackendResolution()，不再是一颗写死的绿点；
  //   · lastSyncAt    ← storage.getLastSyncTime()。Redux 的 tabs.lastSyncTime
  //     没有任何 reducer / thunk 写过，读它等于这一行永远不渲染。
  const [backendStatus, setBackendStatus] = useState<BackendStatus>(UNKNOWN_BACKEND_STATUS);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { showConfirm, showAlert, showToast } = useToast();

  /**
   * ── 2026-10-20 几何修复：菜单高度上限要按「视口剩余空间」算 ────────────
   *
   * 原先是 `max-h-[70vh]`：400×600 的视口下 70vh = 420px，菜单顶边在 y=54
   * ⇒ 底边 474，而最后一项「删除所有会话（N）」底边在 487 ——
   * **比菜单底边还低 13px**，被 overflow 裁在可视区外：用户不滚动就看不到
   * 「删除所有会话」这颗核按钮。
   *
   * 参照系错了：上限该由「菜单顶边到视口底边还剩多少」决定，而不是视口比例。
   * 菜单是绝对定位在菜单按钮的相对容器里，顶边位置随顶栏布局而变，
   * 量出来最准（判据见 dropdownLayout.ts）。
   *
   * 用 useLayoutEffect：高度上限必须在**绘制前**算好，否则会闪一帧超高。
   */
  const [menuMaxHeight, setMenuMaxHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = dropdownRef.current;
    if (!el) return;
    const update = () => {
      const top = el.getBoundingClientRect().top;
      setMenuMaxHeight(
        remainingViewportHeight({ viewportHeight: window.innerHeight, menuTop: top })
      );
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  /**
   * 打开独立设置页（2026-10-14）。
   *
   * 为什么不是把设置留在菜单里，也不是用弹窗：菜单只有 256px 宽且是瞬态的，
   * 托不住 WebDAV 表单（详见渲染处注释）。Chrome 的 `options_ui` 才是正解 ——
   * 独立窗口、关闭时状态保留、用户在扩展详情页也有入口。
   *
   * 失败必须出声：`openOptionsPage` 在 manifest 缺 `options_ui` 时可能静默失败，
   * 表现为「点了没反应」—— 与本轮修掉的那个死锁是同一类病，不能重蹈。
   */
  const handleOpenOptions = useCallback(() => {
    try {
      chrome.runtime.openOptionsPage();
    } catch (error) {
      logError('[HeaderDropdown] 打开设置页失败:', error);
      showToast('打开设置页失败，请在扩展管理页点「扩展选项」进入', 'error');
    }
    onClose();
  }, [onClose, showToast]);

  // 处理快速刷新（从云端下载并合并）
  const handleQuickRefresh = async () => {
    if (isRefreshing) return;
    // ⚠️ 2026-10-18 P2-1：门禁必须按后端分流，不能一刀切「未登录」。
    // 自带存储（WebDAV）用户**没有 TapStack 账号**，而下方状态卡恰恰对
    // 他们显示（`已登录 或 选了自带存储`）。原先这里只看 isAuthenticated，
    // 于是 WebDAV 用户点刷新得到「请先登录以使用同步功能」—— 一句指向
    // 一个他不需要、也永远不存在的账号的话。
    // 判据与 syncEngine 的 authGuard、backgroundSync 的门禁同口径。
    const needsAccount = settings.syncBackend !== 'webdav';
    if (needsAccount && !isAuthenticated) {
      showAlert({
        title: '未登录',
        message: '请先登录以使用同步功能',
        type: 'warning',
        onClose: () => {}
      });
      return;
    }

    setIsRefreshing(true);
    try {
      const res = await sendSyncCommand('download', {
        forceRemote: false,
        syncSettings: false,
      });

      if (res.ok) {
        try {
          await dispatch(loadGroups()).unwrap();
          // 成功也要说话：云端无变化时页面不会有任何视觉差异，
          // 不给一句「已是最新」就等于「点了没反应」。
          showToast('云端已是最新', 'success');
        } catch (err) {
          // 本地列表没刷出来 —— 这是「云端成功了但你没看见」的中间态，
          // 必须说清楚，否则用户以为同步失败（或反过来以为成功了）。
          logWarn('同步后刷新本地会话失败:', err);
          showToast('已同步，但本地列表刷新失败，请稍后重试', 'error');
        }
      } else {
        // 这里的弹窗是**明确的失败**（已登录但拉取失败）
        showAlert({
          title: '手动同步失败',
          // 2026-10-18：原先只特判 not_authenticated，其余原样透出 ——
          // backend_unknown / precheck_unknown 这类机器码会以裸枚举弹给用户。
          // resolveSyncFailureCopy 已就绪（含全部已登记条目的中文文案与
          // 「纯蛇形枚举不得直接展示」的兜底），这里接上即可，不再自维护第二条映射。
          message: resolveSyncFailureCopy({
            reason: res.error,
            fallbackMessage: '无法从云端拉取数据',
          }),
          type: 'error',
          onClose: () => {}
        });
      }
    } catch (error) {
      logError('手动同步失败:', error);
      showAlert({
        title: '手动同步失败',
        message: '网络连接失败，请稍后重试',
        type: 'error',
        onClose: () => {}
      });
    } finally {
      setIsRefreshing(false);
      // 这次尝试可能改变了解锁 / 配置状态（例如口令缺失导致后端解析成锁定），
      // 重查一次，让状态行与刚刚发生的事一致。
      setBackendStatus(await readBackendStatus());
      try {
        setLastSyncAt(await storage.getLastSyncTime());
      } catch (error) {
        logWarn('[HeaderDropdown] 刷新后读取最后同步时间失败:', error);
      }
    }
  };

  // 菜单每次打开都会挂载本组件（Header 里是条件渲染），所以这条 effect 就是
  // 「每次打开菜单做一次真实检查」——不是组件生命周期里只跑一次的装饰。
  // 2026-10-17 B8：修复前这里是写死的绿点 + 读 Redux 里零写方的字段。
  useEffect(() => {
    let alive = true;
    const run = async () => {
      const status = await readBackendStatus();
      if (!alive) return;
      setBackendStatus(status);
      try {
        const time = await storage.getLastSyncTime();
        if (alive) setLastSyncAt(time);
      } catch (error) {
        // 读不到时间就不渲染那一行 —— 不拿编出来的值冒充「上次同步」。
        logWarn('[HeaderDropdown] 读取最后同步时间失败:', error);
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, []);

  // 2026-10-18 round 38：监听用 `click` 而不是 `mousedown`。
  // mousedown 会先于同一次点击的 React onClick 关掉菜单，随后 Header 汉堡按钮的
  // `setShowDropdown(!showDropdown)` 又把（已经变 false 的）状态翻回 true ——
  // 用户看到「再点一次没反应」。
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Element | null;
      // 2026-10-18 round 38：触发按钮自己发起的那次 click 必须跳过。
      // React 的 discrete 事件在 root 上同步 flush ⇒ onClick 先跑、菜单刚挂载，
      // 同一个 click 继续冒泡到 document ⇒ 这里若不跳过，target 是触发按钮、
      // 不在 dropdownRef 内，菜单会被**同一次点击**立刻关掉（真机表现为「打不开」）。
      // 跳过之后开/关都由按钮自己的 onClick 负责，本处理器只处理真正的外部点击。
      // 判据只认触发按钮自己（data-menu-trigger，全仓唯一），不是排除任意 aria-label；
      // 也不用 aria-haspopup 选择器 —— 本面板是就地展开的 disclosure，字符串里出现
      // `aria-haspopup` 会被「面板不得宣称 popup menu」的既有守卫判成违规。
      if (target?.closest?.('[data-menu-trigger]')) return;
      if (target && dropdownRef.current && !dropdownRef.current.contains(target)) {
        onClose();
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  }, [onClose]);

  // 2026-10-18 round 38：键盘用户没有外点可点，缺这条就只剩鼠标能关菜单。
  //
  // ── 2026-10-19 审计 C-7：补上菜单的**方向键**模型 ──────────────────────
  // 容器声明了 role="menu"，但子项既没有 menuitem 角色、方向键也不工作：
  // 读屏播报「应用菜单」，用户按上下键却毫无反应，只能用 Tab 逐个走 ——
  // 与「菜单」这个名字承诺的交互模型相反。
  //
  // 现在补齐 APG 的菜单键盘约定：
  //   ↑/↓ 在菜单项之间移动（roving tabindex：只有当前项在 Tab 序列里）
  //   Home/End 跳到首/末项
  //   Esc 关闭并把焦点还给触发按钮
  // 方向键只在**焦点已经在菜单里**时才接管 —— 菜单刚打开时焦点在触发按钮上，
  // 按 ↓ 应当「进入菜单并落到第一项」。
  //
  // ── 2026-10-20 键盘可达性修复：候选集必须过滤掉不可聚焦的项 ──────────
  // 旧实现的候选集是 `[role="menuitem"]:not([disabled])` —— 但 **role 不等于可聚焦**。
  // 「导入数据」子菜单里的两项是 `<label role="menuitem">`：label 没有 tabindex，
  // `tabIndex === -1` ⇒ **不可聚焦**。于是：
  //   · 方向键选中它 → `focus()` 无效 → 焦点纹丝不动；
  //   · 候选集里它占着一个位置 ⇒ 方向键每次都算回同一项 ⇒ **死循环**；
  //   · 循环里的「问题反馈」「删除所有会话」**全部不可达**（实测 8 次 ArrowDown 焦点不动）。
  // 现在候选集只收**真正可聚焦**的项（tabIndex >= 0 且未 disabled 且可见），
  // 决策逻辑抽到 @/utils/menuKeyboard 的纯函数里（可单测）。
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // 菜单里有文件输入与子菜单；Escape 在它们身上没有别的语义，直接关不冲突。
        onClose();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;

      const root = dropdownRef.current;
      if (!root) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>('[role="menuitem"]'));
      if (items.length === 0) return;

      // 只让**可聚焦**的项参与导航（role="menuitem" 但 tabIndex=-1 的项必须被排除）。
      const focusableIndices = collectFocusableMenuItemIndices(root);
      if (focusableIndices.length === 0) return;

      const active = document.activeElement as HTMLElement | null;
      const currentIndex = active ? items.indexOf(active) : -1;
      const decision = resolveMenuNavigation(
        focusableIndices,
        currentIndex,
        event.key as 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'
      );
      if (decision.kind === 'none') return;

      event.preventDefault();
      items[decision.index].focus();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleSignOut = () => {
    // 先关闭下拉菜单，提高用户体验
    onClose();

    // ── 2026-10-22 审计 DS-8：退出登录时要说清「本机的数据还在」 ──────────
    // 修复前只有一句「已退出登录」。用户合理地以为「退出 = 这个账号的数据
    // 不在本机了」—— 而实际上**一个会话都没删**（`tab_groups` 是单键存储，
    // 登出只清 `auth_cache`）。
    //
    // 这个误解有真实后果：接着登录**另一个**账号时，本机旧账号的会话会
    // 混进新账号的列表（见数据安全审计 DS-1）。所以必须说清：
    // 数据仍在本机、且不会上传到新账号。
    //
    // 数字在**登出前**取：登出动作本身可能改变 storage 的可读性
    // （账号分键之后，未登录状态读不到那一键），那时候再数就数不准了。
    void (async () => {
      let localCount = groups.length;
      try {
        localCount = (await storage.getGroups()).length;
      } catch (error) {
        // 读不到就退回界面上的现值 —— 宁可给一个可能偏旧的数字，
        // 也不能在这条披露里给出「0」。
        logWarn('[HeaderDropdown] 读取本机会话数失败，用界面现值:', error);
      }

      // 异步登出，不阻塞用户界面
      try {
        await dispatch(signOut()).unwrap();
        logInfo('登出成功');
        showToast(
          localCount > 0
            ? `已退出登录。本机 ${localCount} 个会话仍保留，不会上传到其它账号。`
            : '已退出登录',
          'success',
          localCount > 0 ? 5000 : undefined,
        );
      } catch (error) {
        // ── 2026-10-09 P2-4：失败必须出声 ──────────────────────────────
        // 菜单已经关了、界面无任何变化，只有一行 console —— 用户无法区分
        // 「没点上」与「坏了」，会以为自己已登出，而实际上仍是登录态。
        logError('登出失败:', error);
        showToast('退出登录失败，请重试', 'error');
      }
    })();
  };

  // 移除同步功能，简化逻辑

  // 处理删除所有标签组。核弹级操作：不受「删除会话前确认」开关控制，永远弹确认
  // （该开关只应管单组删除；关闭后一键删光全部曾造成误操作事故 2026-09-26）。
  // 无墓碑模型（2026-09-29）：删除即物理移除，跨设备广播由云端 is_deleted 行承担。
  const handleDeleteAllGroups = () => {
    if (groups.length === 0) return;

    const runDeleteAll = () => {
      onClose();

      dispatch(deleteAllGroups())
        .unwrap()
        .then(payload => {
          // 广播登记失败时本地已删干净，但云端行不会被标 is_deleted ⇒
          // 其它设备下次合并会把它当 remote-only 全部复活。必须如实告知。
          const warn = deleteBroadcastWarn(payload);
          if (warn) {
            showAlert({
              title: '删除未完全同步',
              message: warn,
              type: 'warning',
              onClose: () => {}
            });
          }
          // 判据与确认框那句话**必须同源**（deleteAllMessages.deleteAllShouldPushOverwrite）：
          // 原先这里读 isAuthenticated，于是自带存储（WebDAV）用户被告知
          // 「其他设备将同步删除」，实际却因恒 false 走了下面的「跳过」分支 ——
          // 云端旧会话留在原地，换台设备连回来就被原样拉回。承诺与行为分裂。
          if (deleteAllShouldPushOverwrite({ isAuthenticated, syncBackend: settings.syncBackend })) {
            sendSyncCommand('upload', {
              overwriteCloud: true,
              syncSettings: true,
            })
              .then(raw => {
                const res = raw as { ok: boolean; error?: string; payload?: { skippedOverwrite?: string } };
                // 「删光本机全部会话」之后本地没有活跃组 → uploadTabGroups 的
                // 空本地保护必然跳过 overwriteCloud（宁可不清空云端）。也就是说
                // 这条命令的覆盖上传几乎总是被跳过，此前无条件打印
                // 「删除操作已同步到云端」是在对没发生的事报成功。
                // 只有 res.ok 且 payload 里没有 skippedOverwrite，才算真的覆盖了云端。
                if (!res.ok) {
                  logError('删除操作同步到云端失败:', res.error);
                  showAlert({
                    title: '同步失败',
                    // 2026-10-19 审计 F-8：同步 reason 走同一张中文映射表，
                    // 不把机器码（如 backend_unknown）原样弹给用户。
                    message: `本机会话已删除，但云端同步失败：${resolveSyncFailureCopy({
                      reason: res.error,
                      fallbackMessage: '请稍后重试',
                    })}`,
                    type: 'error',
                    onClose: () => {}
                  });
                  return;
                }
                if (res.payload?.skippedOverwrite) {
                  // 删光后本地无活跃组 → 覆盖被跳过是预期路径；删除意图已由
                  // upload 内的 markCloudGroupsAsDeleted（pendingDeleteIds 队列）
                  // 广播到云端，无需报警。
                  //
                  // ⚠️ 但**不能**在这里报「已同步到云端」（那是在对没发生的事
                  // 报成功）。文案与顶栏同步按钮同源（skippedOverwriteNotice），
                  // 两条跳过理由（空本地 / 换账号后闸门放行 0 个）说的都是
                  // 「云端数据保持不变」。
                  const notice = skippedOverwriteNotice(res.payload.skippedOverwrite);
                  logInfo(
                    '[HeaderDropdown] 覆盖上传被跳过，云端未被改动:',
                    res.payload.skippedOverwrite,
                    notice?.text ?? ''
                  );
                  return;
                }
                logInfo('删除操作已同步到云端');
              })
              .catch(error => {
                logError('同步到云端失败:', error);
              });
          } else {
            // 措辞必须与判据一致：走到这里说明**没有可用的同步后端**
            // （纯本地用户），不是「你本来有账号却没登录」。
            logInfo('[HeaderDropdown] 没有可用的同步后端，删除只在本机生效（云端无副本需要清理）');
          }
        })
        .catch(error => {
          logError('删除所有标签组失败:', error);
          showAlert({
            title: '删除失败',
            message: '删除所有会话失败',
            type: 'error',
            onClose: () => { }
          });
        });
    };

    // ── 2026-10-20 焦点管理：登记「确认框关闭后焦点去哪」 ──────────────
    // 确认框由 ToastContext 全局渲染，打开时 activeElement 是这个菜单项
    // 按钮；菜单随即被卸载 ⇒ 关闭确认框时那个按钮已不在文档里 ⇒
    // 旧实现拒绝还焦 ⇒ **焦点掉到 body**（实测：点「取消」后焦点 = body，
    // 而 Esc 路径因为菜单还开着反而能还焦 —— 同一个弹层两种行为）。
    //
    // 登记**顶栏的菜单触发按钮**（`[data-menu-trigger]`）作为稳定落点：
    // 它不会随菜单卸载而消失，于是 Esc 与「取消」两条路径都回到同一个地方。
    registerFocusReturn(
      document.querySelector<HTMLElement>('[data-menu-trigger]')
    );

    showConfirm({
      title: `删除全部 ${groups.length} 个会话`,
      // 跨设备删除的披露判据是「有没有可用的同步后端」，不是「有没有账号」——
      // 自带存储（WebDAV）用户的删除意图同样以墓碑广播（见 deleteAllMessages 文件头）。
      // lockedCount：锁定会话同样会被删掉，必须在按下去之前就说清楚有几个
      // （方案 B 的理由见 deleteAllMessages.ts 文件头）。
      message: deleteAllConfirmMessage({
        groupCount: groups.length,
        lockedCount: lockedGroupCount,
        isAuthenticated,
        syncBackend: settings.syncBackend,
      }),
      type: 'danger',
      confirmText: '全部删除',
      cancelText: '取消',
      onConfirm: runDeleteAll,
      onCancel: () => { }
    });
  };

  // 导出数据为 JSON 格式
  const handleExportData = async () => {
    try {
      setOpenSubmenu(null);
      const exportData = await storage.exportData();
      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: 'application/json'
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // 安全地处理日期格式化
      const date = new Date();
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      a.download = `onetab-backup-${year}-${month}-${day}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      onClose();
    } catch (error) {
      logError('导出数据失败:', error);
      showAlert({
        title: '导出失败',
        message: '导出数据失败，请重试',
        type: 'error',
        onClose: () => { }
      });
    }
  };

  // 导出数据为 OneTab 格式
  const handleExportOneTabFormat = async () => {
    try {
      setOpenSubmenu(null);
      const oneTabText = await storage.exportToOneTabFormat();
      const blob = new Blob([oneTabText], {
        type: 'text/plain'
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // 安全地处理日期格式化
      const date = new Date();
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      a.download = `onetab-export-${year}-${month}-${day}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      onClose();
    } catch (error) {
      logError('导出 OneTab 格式数据失败:', error);
      showAlert({
        title: '导出失败',
        message: '导出 OneTab 格式数据失败，请重试',
        type: 'error',
        onClose: () => { }
      });
    }
  };

  // 导出脱敏诊断信息（B1）。只传登录态布尔值：user 对象里有邮箱与 id，
  // 诊断文件里不允许出现任何一个（见 src/utils/diagnostics.ts 的白名单说明）。
  const handleExportDiagnostics = async () => {
    try {
      setOpenSubmenu(null);
      // 载荷与文件名共用同一个 Date：跨零点时两者才对得上（见 exportStamp.ts）。
      const now = new Date();
      const report = await collectDiagnostics({ isAuthenticated, now });
      const blob = new Blob([serializeDiagnosticsReport(report)], {
        type: 'application/json'
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = diagnosticsFileName(report.environment.extensionVersion, now);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      onClose();
    } catch (error) {
      logError('导出诊断信息失败:', error);
      showAlert({
        title: '导出失败',
        message: '收集诊断信息失败，请重试；若反复失败请到「问题反馈」里说明',
        type: 'error',
        onClose: () => { }
      });
    }
  };

  // 问题反馈（B2）：打开 GitHub issues 新建页，并把脱敏摘要放进剪贴板。
  // 先开页面再收集：window.open 必须落在用户手势的同步路径里，等 await 之后再开
  // 可能被弹窗拦截；而收集失败也不该把用户已经打开的反馈页关掉。
  const handleReportIssue = async () => {
    onClose();
    window.open(FEEDBACK_ISSUE_URL, '_blank', 'noopener,noreferrer');
    try {
      const report = await collectDiagnostics({ isAuthenticated });
      const summary = diagnosticsSummaryText(report);
      if (await copyTextToClipboard(summary)) {
        showToast('诊断摘要已复制，请在 issue 正文里粘贴', 'success');
      } else {
        // 复制不了就把原文摆出来让用户手动拿，不静默吞掉
        showAlert({
          title: '诊断摘要未复制',
          message: `浏览器拒绝了剪贴板写入，请手动复制以下内容：\n\n${summary}`,
          type: 'warning',
          onClose: () => { }
        });
      }
    } catch (error) {
      logError('生成诊断摘要失败:', error);
      showAlert({
        title: '诊断摘要生成失败',
        message: '已为你打开反馈页，但收集诊断信息失败，请在 issue 里补充复现步骤',
        type: 'error',
        onClose: () => { }
      });
    }
  };

  // 坏时间戳 → null → 整行不渲染（formatLastSyncTime 里对 NaN 的处理）。
  const lastSyncLabel = lastSyncAt ? formatLastSyncTime(lastSyncAt) : null;
  const lastSyncTitle =
    lastSyncAt && lastSyncLabel ? `上次成功同步：${new Date(lastSyncAt).toLocaleString()}` : null;

  // 2026-10-18 C 组：状态卡不再按登录态隐藏，且状态文案由统一函数决定 ——
  // 云端未登录时 parse 出来的是 supabase 适配器的 `ready / 已配置并解锁`，
  // 直接渲染就是新的谎话（Supabase 分支不检查登录态）。
  const syncStatusView = resolveMenuSyncStatus({
    syncBackend: settings.syncBackend,
    isAuthenticated,
    userEmail: user?.email,
    backend: backendStatus,
  });

  // ── 2026-10-22 审计 P1-5：菜单里必须看得见「定时拉取」的状态 ────────────
  // 「同步」是两件事：上传（一直发生）与定时拉取（**默认关闭**）。
  // 菜单里原先只说「已配置并解锁 / 未登录」这类**后端**状态，
  // 「定时拉取开没开」在管理页上零处可见 ⇒ 新用户以为「登录 = 开了同步」，
  // 两台设备都在线时第一台的更新不会自动出现在第二台，
  // 于是得出「这产品同步不可靠」的结论（真相：只需在设置里打开开关）。
  const autoPullView = autoPullStatusView({
    syncEnabled: settings.syncEnabled,
    intervalMinutes: settings.syncIntervalMinutes,
  });

  return (
    <div
      ref={dropdownRef}
      role="menu"
      aria-label="应用菜单"
      className="ts-panel absolute right-0 mt-2 w-64 max-w-[calc(100vw-2rem)] theme-bg-elevated theme-radius-card theme-shadow-panel border theme-border-default z-20 overflow-y-auto"
      style={menuMaxHeight !== null ? { maxHeight: `${menuMaxHeight}px` } : undefined}
    >
      <div className="py-2">
        {/* 2026-10-17 B8（浏览器实测抓到）：这个条件原先只有 `isAuthenticated && user`。
            ⚠️ 双模式下那是个真缺陷：自带存储（WebDAV）用户**没有 TapStack 账号**，
            isAuthenticated 恒为 false ⇒ 他们只看到「登录 / 注册」，永远看不到
            自己的同步状态（已配置/未解锁/去设置）—— 而登录对他们毫无意义。
            2026-10-18 C 组：**云端未登录**同样被藏了 —— 新装扩展默认后端是
            supabase，菜单里连同步存在都看不到。现改为无条件渲染（两种后端的
            未就绪态各自有话说），状态文案由 resolveMenuSyncStatus 统一决定，
            云端未登录时显示「未登录 · 去登录」而不是转述后端的 ready。 */}
        <div className="px-4 py-3 border-b theme-border-default">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium theme-text-primary">
              {syncStatusView.headline}
            </p>
            <button
              role="menuitem"
              onClick={handleQuickRefresh}
              disabled={isRefreshing}
              aria-label={isRefreshing ? '正在从云端刷新' : '从云端刷新数据'}
              className="p-1.5 rounded-full flat-interaction transition-colors disabled:cursor-not-allowed disabled:opacity-60"
              title={isRefreshing ? '正在从云端刷新…' : '从云端刷新数据'}
            >
              {/* 进行中的可视信号：转圈。只 disabled 不转，用户仍看不出「在动」 */}
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className={`h-4 w-4 theme-accent-text${isRefreshing ? ' animate-spin' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>
          <div className="flex items-center justify-between">
            {/* 2026-10-17 B8（从 slim 适配双模式）：
                原先这里是**写死的绿点 + 「已登录」**，没有任何判据 ——
                未配置 / 未解锁 / 后端解析失败的用户也看到「已登录」。
                现在状态来自 getLastBackendResolution()：
                已配置并解锁 / 未解锁 / 未配置 / 状态不可读 四态可辨，
                未就绪时提供「去设置」入口。

                ⚠️ 双模式：前缀按 settings.syncBackend 区分 —— 末尾存储
                用「自带存储」，TapStack 云端用「TapStack 云端」。
                slim 上是写死的「自带存储 · 」，照抄会在云端模式下撒谎。
                2026-10-18 C 组：前缀、短语、圆点色、行动入口全部来自
                resolveMenuSyncStatus（云端未登录恒为「未登录 + 去登录」）。 */}
            <p
              className="min-w-0 text-xs theme-text-muted flex items-center"
              title={backendStatus.lockedReason ?? BACKEND_STATUS_TITLE[backendStatus.kind]}
            >
              <span
                className={`inline-block w-2 h-2 rounded-full mr-1 shrink-0 ${BACKEND_STATUS_DOT_CLASS[syncStatusView.tone]}`}
              ></span>
              <span className="truncate">
                {syncStatusView.prefix} · {syncStatusView.label}
              </span>
            </p>
            {syncStatusView.needsLogin && (
              // ── 2026-10-20 键盘可达性：补 role="menuitem" ────────────────
              // 容器声明了 role="menu"，而这个按钮是菜单里**唯一**没有
              // menuitem 角色的交互项（实测 interactiveCount=10 / menuitemCount=9）。
              // 读屏在「菜单」上下文里遇到一个普通 button，菜单的键盘模型就不完整。
              //
              // ── 2026-10-23 审计 H-1：命中区必须够大 ────────────────────────
              // 真机实测（400px 视口）：这个入口的命中区只有 **36.4×16px**，
              // 而菜单里其它 7 行都是 **254×36px** —— 命中区只有别人的 1/7，
              // 16px 高低于 WCAG 2.2 SC 2.5.8 (AA) 的 24px 下限 ⇒ 触屏点不准；
              // 字号 12px vs 其它行 13px；它是菜单里唯一没有图标、也不在菜单行
              // 垂直序列里的一行 ⇒ 键盘用户方向键能走到它，却**没有任何视觉反馈**
              // 说「你到了一个菜单项」。
              //
              // 本条治的是**命中区与视觉规格**，**不是位置** —— 把它挪成独立菜单行
              // 会推翻上面 L-6 记录的有意设计（它紧挨着「TapStack 云端 · 未登录」
              // 那一行状态，因果关系一目了然），也会让 WebDAV 的「去设置」变成
              // 唯一的例外。⇒ 保位置、保 role="menuitem"、保 MENU_LOGIN_LABEL，
              // 只调 className。
              //
              // 命中区口径：本仓自己的判定在 `layout/hitTarget.ts`（MIN_HIT_TARGET_PX
              // = 36）。但那条口径管的是**图标按钮**（顶栏 .btn-icon，min-w/min-h
              // 2.25rem）—— 内联文字入口靠 padding + 行高撑开盒子，不是 min-*，
              // 所以这里不套 min-w/min-h（那会把状态卡的抬头行撑成两行高）。
              // 实际取值：`text-sm`（14px，与菜单行同字号）行高 20px + `py-1.5`
              // (6px×2) = **32px 高** ≥ AA 的 24px；`px-2` 把文字两侧各撑 8px，
              // 命中区从 36.4px 宽涨到 ~52px。`-mr-2` 抵掉右侧 padding，
              // 让按钮右边缘仍与状态卡内容右边缘对齐（视觉不跑偏）。
              //
              // 下划线**保留** —— 它是「这是可以点的文字」的线索，
              // 也是它与状态行里那些纯说明文字的区分。
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  onClose();
                  onOpenAuth('login');
                }}
                className="shrink-0 -mr-2 rounded px-2 py-1.5 text-sm font-medium theme-accent-text underline hover:theme-accent-wash"
              >
                {MENU_LOGIN_LABEL}
              </button>
            )}
            {!syncStatusView.needsLogin && syncStatusView.actionable && (
              // 同「去登录」：菜单里的交互项必须带 menuitem 角色，
              // 否则读屏的菜单键盘模型不完整。命中区口径也完全相同（它们是一对）。
              <button
                role="menuitem"
                type="button"
                onClick={handleOpenOptions}
                className="shrink-0 -mr-2 rounded px-2 py-1.5 text-sm font-medium theme-accent-text underline hover:theme-accent-wash"
              >
                去设置
              </button>
            )}
          </div>
          {/* 上次同步时间：真值来自 storage.getLastSyncTime()（由 syncEngine
              的成功路径写入），而不是 Redux 的 tabs.lastSyncTime ——
              后者全仓零写方，读它等于这一行永远不渲染（缺陷 2）。
              坏时间戳 → formatLastSyncTime 返回 null → 整行不渲染。 */}
          {lastSyncLabel && lastSyncTitle && (
            <p className="mt-1 text-xs theme-text-muted" title={lastSyncTitle}>
              上次成功同步 · {lastSyncLabel}
            </p>
          )}
          {/* 定时拉取状态（审计 P1-5）：默认关闭这件事必须在管理页看得见，
              否则「登录 = 开了同步」的误解会一路带到「同步不可靠」的结论。
              完整说明（关掉它少了什么、没少什么）放在 title 里。 */}
          <p className="mt-1 text-xs theme-text-muted" title={autoPullView.title}>
            {autoPullView.label}
          </p>
        </div>

        {/* ── 2026-10-22 审计 L-6：删掉重复的「登录 / 注册」菜单行 ──────────
           原来这里有一行独立的 MENU_ROW「登录 / 注册」，**和上面状态卡里的
           内联「去登录」是同一个按钮**（两个条件逐字相同：
           `needsLogin` ⟺ 云端后端 && 未登录；`!isAuthenticated && !== 'webdav'`
           ⟺ 云端后端 && 未登录）。

           一个菜单里两个同义入口 ⇒ 用户会以为它们不一样，也让菜单看起来
           像没设计完。保留**内联**那个：它紧挨着「TapStack 云端 · 未登录」
           这一行状态，因果关系一目了然；而且它与 WebDAV 的「去设置」内联
           入口是同一套语言（状态卡 → 就地给下一步），对称。

           ⚠️ 被删掉的是**唯一**带图标的登录入口。删除后必须确认：
             · 云端未登录 → 状态卡内联「去登录」在（needsLogin 为真）；
             · WebDAV 用户 → 这行本来就不渲染（条件含 !== 'webdav'），
               且 WebDAV 不需要 TapStack 账号；
             · 已登录 → 这行本来也不渲染。
           三种情形都由 needsLogin 覆盖 —— 行为面（自带存储看不到登录入口）
           由 tests/syncStatusHonesty.test.ts 的四组合用例保证：
           `webdavAnon.needsLogin === false` / `cloudAnon.needsLogin === true`。

           ⚠️ 2026-10-23：此处原先指向一个**并不存在**的守卫文件（它从未
           被创建过，全仓只有那一处提到它）。照着注释去找守卫的人会扑空
           ⇒ 改成指向真正守着这个不变量的文件（上面那一个）。
           守卫还会盯住「src/ 下不再出现指向不存在测试文件的注释」。 */}

        <div className="border-t theme-border-default my-1.5"></div>

        {/* ── 布局切换 / 清理重复标签（2026-10-14 起是「窄屏补偿入口」，
            2026-10-22 审计 U-20 后成为**全宽度**入口）────────────────────
            背景：390px 实测顶栏塞不下「布局切换 + 清理重复 + 主题 + 同步 + 保存 + 菜单」，
            搜索框被压到 0 宽而整框消失（见 global.css 的 F-1 注释）。
            当时 Header 把这两个低频操作在**窄屏**收进本菜单、sm 以上用顶栏按钮。

            但那个实现的逻辑是反的：顶栏按钮写的是 `hidden sm:block`
            ⇒ 它们**只在 ≥640px 出现**，而那正是宽度最紧的时候
            （1280 实测操作区 434px 已比搜索框 428px 还宽）。
            注释说「顶栏宽度优先给搜索」，实现却是「顶栏宽度优先给两个低频按钮」。

            现在：顶栏不再有这两颗按钮，菜单里的入口**所有宽度都可见** ——
            顶栏释放 72px 给搜索框，功能一条不少，且破坏性动作不再随手可点。 */}
        <div>
          <button role="menuitem"
            onClick={() => {
              onToggleLayout?.();
              onClose();
            }}
            className={MENU_ROW}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 theme-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <rect x="3.75" y="5.25" width="16.5" height="13.5" rx="1.5" strokeLinecap="round" strokeLinejoin="round" />
              {settings.layoutMode === 'single' && (
                <path d="M12 5.25v13.5" strokeLinecap="round" strokeLinejoin="round" />
              )}
            </svg>
            {settings.layoutMode === 'single' ? '切换为双栏布局' : '切换为单栏布局'}
          </button>

          <button role="menuitem"
            onClick={() => {
              onRequestCleanDuplicates?.();
              onClose();
            }}
            // 清理进行中禁点：同一个破坏性动作不能跑两遍。
            // 入口从顶栏搬进菜单后，这道防线也得跟着搬（审计 U-20 之后的接线）。
            disabled={isCleaningDuplicates}
            aria-busy={isCleaningDuplicates}
            className={MENU_ROW + ' disabled:opacity-60 disabled:cursor-not-allowed'}
          >
            {isCleaningDuplicates ? (
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 theme-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
              </svg>
            )}
            {isCleaningDuplicates ? '正在清理重复标签…' : '清理重复标签'}
          </button>
        </div>

        {/* ── 2026-10-14：设置全部搬进独立选项页，菜单只留入口 ──────────────
            搬走的原因不是「菜单太挤」，而是菜单**放不下也托不住**这类设置：
            宽度只有 256px（w-64），而 WebDAV 面板有 6 个输入框 + 加密单选组 +
            4 个按钮；且菜单是瞬态的（点别处即消失），而填地址/账号/应用密码/
            加密口令全是要回看斟酌的长文本。在 256px 的瞬态下拉里滚表单，
            按钮行要横向滚动才看得全 —— 这不是能靠调样式救回来的问题。
            现在：菜单一行「设置…」→ chrome.runtime.openOptionsPage()。
            保留在菜单里的只有非设置项：登录、导出/导入、清理重复、
            问题反馈、删除全部、退出登录。 */}
        <button role="menuitem"
          onClick={handleOpenOptions}
          className={MENU_ROW}
          type="button"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 theme-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <circle cx="12" cy="12" r="3" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
          设置…
        </button>

        <div>
          <button role="menuitem"
            onClick={() => setOpenSubmenu(current => current === 'export' ? null : 'export')}
            className={MENU_ROW + ' justify-between'}
            aria-expanded={openSubmenu === 'export'}
            type="button"
          >
            <div className="flex items-center">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 theme-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              导出数据
            </div>
            {/* 方向指示要与实际展开方向一致：面板现在开在下方，箭头随之转 90°。 */}
            <svg xmlns="http://www.w3.org/2000/svg" className={`h-4 w-4 theme-text-muted transition-transform duration-150 ${openSubmenu === 'export' ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
          {/* 同上：就地展开，避免被菜单的滚动容器横向裁掉（唯一入口，不可达即功能缺失）。 */}
          {openSubmenu === 'export' && (
            <div ref={submenuRef} className="ts-panel mb-1 ml-3 rounded-lg border theme-border-default theme-bg-elevated shadow-lg">
            <button role="menuitem"
              onClick={handleExportData}
              className={MENU_ROW}
              type="button"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 theme-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              JSON 格式
            </button>
            <button role="menuitem"
              onClick={handleExportOneTabFormat}
              className={MENU_ROW}
              type="button"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 theme-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              OneTab 格式
            </button>
            {/* 诊断信息：同样是一次导出，但内容是脱敏后的规模与环境快照
                （不含任何标签 URL、标题、会话名），用于反馈问题时贴 issue。 */}
            <button role="menuitem"
              onClick={handleExportDiagnostics}
              className={MENU_ROW}
              type="button"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 theme-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.75 12h16.5m-16.5 0a3 3 0 013-3m13.5 0a3 3 0 013 3m-16.5 0a3 3 0 003 3m13.5 0a3 3 0 003-3m-16.5 0a9 9 0 0118 0m-18 0a9 9 0 018 9m-8-9a9 9 0 00-8 9m0-9v9m18-9v9" />
              </svg>
              诊断信息
            </button>
            </div>
          )}
        </div>

        <div>
          <button role="menuitem"
            onClick={() => setOpenSubmenu(current => current === 'import' ? null : 'import')}
            className={MENU_ROW + ' justify-between'}
            aria-expanded={openSubmenu === 'import'}
            type="button"
          >
            <div className="flex items-center">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 theme-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              导入数据
            </div>
            {/* 同「导出数据」：箭头方向跟随实际展开方向。 */}
            <svg xmlns="http://www.w3.org/2000/svg" className={`h-4 w-4 theme-text-muted transition-transform duration-150 ${openSubmenu === 'import' ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
          {/* 子项**就地展开**，不做向右的浮层。
              2026-10-18 修：原先是 `absolute left-full top-0 ml-1 w-48`，而菜单容器是
              `overflow-y-auto`（单轴）+ 限高 —— 按 CSS 规范，单轴设为 auto 会让另一轴的
              `visible` 也计算成 auto（实测 overflow 计算值 auto/auto），容器因此成了横向
              裁剪盒：子菜单整个落在菜单右边界之外（实测菜单盒 [152,408]、子菜单 [411,603]），
              在子菜单中心做命中测试 elementFromPoint 返回 null。用户点「导出数据」屏幕毫无
              变化，而全仓 grep 确认这里是导出/导入的**唯一**入口 ⇒ 备份与恢复双双不可达。
              展开放在父行下方的流内，就不会被任何祖先裁剪，也不需要横向滚动。 */}
          {openSubmenu === 'import' && (
            <div ref={submenuRef} className="ts-panel mb-1 ml-3 rounded-lg border theme-border-default theme-bg-elevated shadow-lg">
            {/* ── 2026-10-20 键盘可达性：`<label role="menuitem">` → 真按钮 ──
                原先是 `<label role="menuitem">` 包着隐藏的 `<input type="file">`：
                label 没有 tabindex ⇒ tabIndex=-1 ⇒ **不可聚焦**；内层 input 是
                display:none ⇒ 也不可聚焦。于是「JSON 格式」这一项在 AX 树里是
                一个菜单项，键盘却永远到不了（实测 Tab 16 次、方向键 14 次都
                没落到它）。更要命的是它还堵死了方向键的后续项（见上方
                方向键 effect 的注释）⇒ 「问题反馈」「删除所有会话」全部不可达。
                现在换成真 button：可聚焦、有名字、方向键能选中。
                hidden input 挪到按钮**外面**（button 里嵌 input 是非法的交互嵌套）。 */}
            <button
              role="menuitem"
              type="button"
              onClick={() => jsonImportInputRef.current?.click()}
              className={MENU_ROW}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 theme-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              JSON 格式
            </button>
            <input
              ref={jsonImportInputRef}
              type="file"
              accept=".json"
              className="hidden"
              onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    const reader = new FileReader();
                    reader.onload = async (event) => {
                      try {
                        const data = JSON.parse(event.target?.result as string);
                        const result = await storage.importDetailed(data);
                        e.target.value = '';
                        if (result.ok) {
                          // ── 2026-10-09 P1-6：导入结果必须报数量 ──────────
                          // 原先「成功不弹提示（Unix 哲学）」直接 reload ——
                          // 用户无从知道导入了几个、跳过几个。跳过的组会静默
                          // 消失，他还以为全都在，要等自己回文件里核对才发现。
                          //
                          // 为什么不再 reload：reload 会把 toast/alert 一起刷掉，
                          // 报了数量等于没报。loadGroups thunk 内部已有
                          // invalidateGroupsCache()，够拿到导入后的新列表。
                          if (result.pending) {
                            showAlert({
                              title: '正在导入',
                              message: `文件较大，导入仍在后台继续，稍后列表会自行更新（文件内共 ${result.source} 个会话）`,
                              type: 'warning',
                              onClose: () => {},
                            });
                          } else if (result.imported < result.source) {
                            showAlert({
                              title: '部分导入完成',
                              // 2026-10-19 审计 F-5：「已存在而跳过」与
                              // 「内容有问题而跳过」必须分开说 —— 原先共用一句
                              // 「为空会话或只含无法保存的网址」，用户重复导入
                              // 自己的备份时看到的是「你的备份文件坏了」。
                              message: importPartialMessage({
                                source: result.source,
                                imported: result.imported,
                                skippedExisting: result.skippedExisting,
                              }),
                              type: 'warning',
                              onClose: () => {},
                            });
                          } else {
                            showToast(importSuccessMessage({
                              source: result.source,
                              imported: result.imported,
                            }), 'success');
                          }
                          // 只刷新列表，不 reload 整页：提示能完整显示完
                          dispatch(loadGroups());
                          // 2026-10-18 round 31：备份里带 settings 时 importDetailed 已经把它
                          // 合并进存储，但**本上下文手里的 Redux 还是旧值**（60s 设置缓存 + 各自
                          // 一份 state）。用户接着改任何一项设置都会把旧值整份盲写回去
                          // （saveSettings 不是读-改-写）—— 刚导入的设置被静默回滚，界面也
                          // 一直显示旧主题/旧布局，看起来像「设置没导进来」。
                          // 与同步按钮 / 设置页「以云端为准」同一口径：先失效缓存，再读。
                          const reloadError = await dispatchReloadSettings(dispatch);
                          if (reloadError) {
                            logWarn('导入后重读设置失败，界面可能显示旧值:', reloadError);
                            showToast(
                              '数据已导入，但界面没能重新读取设置；请重新打开本窗口，期间先别改设置',
                              'warning'
                            );
                          }
                        } else {
                          // 2026-10-10 P2-3：与 OneTab 分支（下方）对齐 —— 那边用
                          // importResult.reason，这里原先是静态的「数据导入失败」，
                          // 把三种完全不同的原因（格式不对 / 组全不可存储 / 写盘失败）
                          // 压成同一句，用户无从判断该重选文件还是该等一等。
                          // reason 由 storage.importDetailed 提供（可选字段）。
                          showAlert({
                            title: '导入失败',
                            message:
                              result.reason ??
                              `数据导入失败${result.source > 0 ? `（文件内共 ${result.source} 个会话，本次一个都没落盘）` : ''}`,
                            type: 'error',
                            onClose: () => { }
                          });
                        }
                      } catch (error) {
                        logError('解析导入文件失败:', error);
                        e.target.value = '';
                        showAlert({
                          title: '导入失败',
                          message: '解析导入文件失败，请确保文件格式正确',
                          type: 'error',
                          onClose: () => { }
                        });
                      }
                      onClose();
                    };
                    reader.readAsText(file);
                  }
                }}
              />
            <button
              role="menuitem"
              type="button"
              onClick={() => oneTabImportInputRef.current?.click()}
              className={MENU_ROW}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 theme-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              OneTab 格式
            </button>
            <input
              ref={oneTabImportInputRef}
              type="file"
              accept=".txt"
              className="hidden"
              onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    const reader = new FileReader();
                    reader.onload = async (event) => {
                      try {
                        const text = event.target?.result as string;
                        const importResult = await storage.importFromOneTabFormat(text);
                        e.target.value = '';
                        if (importResult.ok) {
                          // ── 2026-10-20 A-20：会话数必须**来自解析器**，不能在这里重数 ──
                          //
                          // 此前用 `text.split('\n\n').filter(Boolean).length` 数组数，
                          // 而解析器用的是 `split(/\n\s*\n/)` —— 两者规则不同 ⇒
                          // 数字对不上：
                          //   · Windows 换行（`\r\n\r\n`，OneTab 在 Windows 上的默认导出）
                          //     → 解析器 2 组，界面报 1 个 ⇒ 「共 1 个会话，成功导入 2 个」
                          //   · 中间是「换行 + 空格 + 换行」的空行 → 同上
                          //
                          // 而 F-5 审计刚建立的契约是「source = imported + skippedExisting
                          // + 内容有问题」恒成立 ⇒ source 必须是**真实的组数**。
                          //
                          // 解析结果 `importResult.source` 就是真实组数（解析器已经算过），
                          // 直接用它；只有在它缺失时才兜底，而兜底也必须与解析器同规则。
                          const total = importResult.source ?? countOneTabGroups(text);
                          void trackProductEvent('onetab_import_completed', {
                            importSource: 'onetab',
                            importedSessions: total,
                          });
                          // ── 2026-10-09 P1-6：与 JSON 导入同口径报数量 ──
                          // 原先「成功不弹提示」直接 reload，用户不知道导入了几个、
                          // 跳过几个；reload 还会把提示一起刷掉。改 dispatch(loadGroups)。
                          const done = importResult.imported ?? 0;
                          if (importResult.pending) {
                            showAlert({
                              title: '正在导入',
                              message: `文件较大，导入仍在后台继续，稍后列表会自行更新（文件内共 ${total} 个会话）`,
                              type: 'warning',
                              onClose: () => {},
                            });
                          } else if (done < total) {
                            showAlert({
                              title: '部分导入完成',
                              // 2026-10-19 审计 F-5：与 JSON 导入路径同一口径 ——
                              // 「已存在而跳过」与「内容有问题而跳过」分开说。
                              message: importPartialMessage({
                                source: total,
                                imported: done,
                                skippedExisting: importResult.skippedExisting,
                              }),
                              type: 'warning',
                              onClose: () => {},
                            });
                          } else {
                            showToast(importSuccessMessage({
                              source: total,
                              imported: done,
                            }), 'success');
                          }
                          dispatch(loadGroups());
                        } else {
                          showAlert({
                            title: '导入失败',
                            message: importResult.reason ?? 'OneTab 数据导入失败',
                            type: 'error',
                            onClose: () => { }
                          });
                        }
                      } catch (error) {
                        logError('解析 OneTab 导入文件失败:', error);
                        e.target.value = '';
                        showAlert({
                          title: '导入失败',
                          message: '解析 OneTab 导入文件失败，请确保文件格式正确',
                          type: 'error',
                          onClose: () => { }
                        });
                      }
                      onClose();
                    };
                    reader.readAsText(file);
                  }
                }}
              />
            </div>
          )}
        </div>

        {/* 问题反馈：与导出/导入同一层的普通菜单行（真 button + 可见文字，
            读屏有名字；不是图标按钮，所以不需要 aria-label）。 */}
        <button role="menuitem"
          onClick={handleReportIssue}
          className={MENU_ROW}
          type="button"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 theme-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
          </svg>
          问题反馈
        </button>

        {/* 使用引导（2026-10-20 审计 B-2）。
            引导是一次性的：跳过就回不去，而「现在没空」是最常见的跳过理由。
            给用户一个随时能重看同一套引导的入口。
            位置在「问题反馈」之后、危险区之前 —— 属普通操作行，
            与「删除所有会话」的色块危险区明确分开。 */}
        {onReplayOnboarding && (
          <button role="menuitem"
            onClick={() => {
              onClose();
              onReplayOnboarding();
            }}
            className={MENU_ROW}
            type="button"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 theme-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
            </svg>
            使用引导
          </button>
        )}

        {/* 危险区：与菜单平面语言一致（rounded-lg + 留边），用色块与普通项区分防误触。
            核弹级操作：强制确认不受「删除会话前确认」开关控制；无组时隐藏；描述带数量。 */}
        {groups.length > 0 && (
          <div className="px-2 pt-1.5 pb-0.5">
            <button
              role="menuitem"
              onClick={handleDeleteAllGroups}
              className="flex w-full items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-left text-sm font-medium text-rose-700 transition-colors hover:bg-rose-100 dark:border-rose-900/40 dark:bg-rose-950/30 dark:text-rose-300 dark:hover:bg-rose-950/50"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 shrink-0 text-rose-500 dark:text-rose-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              <span className="flex-1">
                <span className="block">删除所有会话（{groups.length}）</span>
                <span className="mt-0.5 block text-xs font-normal text-rose-600/80 dark:text-rose-300/80">
                  {deleteAllMenuWarning({
                    lockedCount: lockedGroupCount,
                    isAuthenticated,
                    syncBackend: settings.syncBackend,
                  })}
                </span>
              </span>
            </button>
          </div>
        )}

        {isAuthenticated && (
          <>
            <div className="border-t theme-border-default my-1.5"></div>
            <button role="menuitem"
              onClick={handleSignOut}
              className={MENU_ROW}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 theme-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              退出登录
            </button>
          </>
        )}
      </div>

    </div>
  );
};
