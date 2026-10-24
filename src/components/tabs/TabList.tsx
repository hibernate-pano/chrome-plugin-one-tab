import React, { useCallback, useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { clearError, loadGroups } from '@/store/slices/tabSlice';
import { invalidateGroupsCache, onGroupsChanged } from '@/utils/storage';
import { DraggableTabGroup } from '@/components/dnd/DraggableTabGroup';
import { SearchResultList } from '@/components/search/SearchResultList';
import { SearchFilterSection } from '@/components/search/SearchFilterPanel';
import type { SearchFilterControls } from '@/components/search/searchFilterState';
import { resolveSearchViewMode } from '@/components/search/searchBrowseMode';
import { sortSessions } from '@/core/sessionSort';
import { EmptyState } from '@/components/common/EmptyState';
import { getEmptyStateGreeting } from '@/components/common/emptyStateGreeting';
import { saveAndCloseLabel } from '@/components/layout/saveActionCopy';
import { saveAllSuccessShortMessage } from '@/domain/tabGroup/saveFeedbackCopy';
import { toListErrorCopy, toListErrorView } from './listErrorCopy';
import { bootstrapFirstRead } from './firstReadBootstrap';
import {
  CLOUD_PULL_BUSY_LABEL,
  cloudPullOutcomeMessage,
} from '@/domain/tabGroup/cloudPullCopy';
import { getContextOrigin } from '@/core/contextOrigin';
import { logError, logWarn } from '../../utils/log';
import { AuthTab } from '@/components/auth/AuthModal';
import { sendSyncCommand } from '@/shared/mutationProtocol';
import { requestImport } from '@/components/layout/importRequest';
import { resolveSyncFailureCopy } from '@/components/sync/syncPreviewView';
import {
  EMPTY_STATE_ACTION_HINT,
  EMPTY_STATE_ACTION_LABEL,
  EMPTY_STATE_EXIT_UNAVAILABLE,
  resolveEmptyStateActions,
} from './emptyStateActions';
import { runEmptyStateExit } from '@/core/emptyStateExits';

interface TabListProps {
  searchQuery: string;
  /**
   * 打开登录 / 注册弹窗（2026-10-22 审计 L-11）。
   *
   * 空态要给「登录 TapStack 云端」一个出口：换设备的老用户打开扩展
   * 看到的是一片空白，而他最该做的那一步（登录 → 自动拉回云端会话）
   * 当时无处可点。弹窗实例由 MainApp 持有（Header 与空态共用同一个）。
   */
  onOpenAuth?: (tab: AuthTab) => void;
  /**
   * 筛选控件（2026-10-22 审计 P1-8：状态提升到应用层）。
   *
   * 筛选条件原本由列表层自己持有，而顶栏那个「回到默认视图」的按钮
   * **拿不到**它 ⇒ 那个按钮清不掉筛选条件，承诺比兑现多。
   *
   * 现在由 MainApp 持有并下发，Header 与 TabList 拿到的是**同一份**。
   */
  filterControls: SearchFilterControls;
}

/**
 * 列表**还读不出来**时的骨架屏。
 *
 * 抽成组件是因为它有两处用（首次读取没走完 / 这一轮读取在途），
 * 而两处的语义必须**完全一致** —— 一处说「还在读」、另一处说「读完了」
 * 会让用户以为自己看到的是最终结果。
 */
const ListLoadingSkeleton: React.FC = () => (
  <div
    className="session-list-stack"
    role="status"
    aria-live="polite"
    aria-label="正在加载会话列表"
  >
    <div className="tab-group-card p-4 space-y-3" aria-hidden="true">
      <div className="skeleton-block h-5 w-2/5" />
      <div className="skeleton-block h-4 w-full" />
      <div className="skeleton-block h-4 w-11/12" />
      <div className="skeleton-block h-4 w-4/5" />
    </div>
    <div className="tab-group-card p-4 space-y-3" aria-hidden="true">
      <div className="skeleton-block h-5 w-1/3" />
      <div className="skeleton-block h-4 w-full" />
      <div className="skeleton-block h-4 w-3/5" />
    </div>
    <span className="sr-only">正在加载会话列表…</span>
  </div>
);

export const TabList: React.FC<TabListProps> = ({ searchQuery, onOpenAuth, filterControls }) => {
  const dispatch = useAppDispatch();
  const { groups, isLoading, error, errorSource, errorAction, hasCompletedInitialLoad } =
    useAppSelector(state => state.tabs);
  const { layoutMode, syncBackend } = useAppSelector(state => state.settings);
  // 排序键（2026-10-22 审计 L-10）：筛选区里那个「排序方式」下拉写的就是它。
  const sessionSort = useAppSelector(state => state.settings.sessionSort);
  const { isAuthenticated } = useAppSelector(state => state.auth);
  // ── 2026-10-20 审计 A-14：筛选状态住在**列表层** ────────────────────────
  // 修复前筛选条件是 SearchResultList 的内部 useState，而该组件只在有搜索词时
  // 才挂载 ⇒ 清空搜索词就把用户设好的筛选条件一起清掉，「换个关键词继续筛」
  // 这个搜索主用法被迫每次重设。
  //
  // 状态提到这里之后：结果视图卸载**不影响**筛选条件；筛选面板也在这里渲染，
  // 于是**没有搜索词时筛选器依然可达**（按域名 / 会话名 / 保存时间都能当检索入口用）。
  //
  // ── 2026-10-22 审计 P1-8：又往上提了一层（现在在 MainApp） ─────────────
  // 原因是顶栏的「回到默认视图」要能清筛选，而顶栏在列表层的**上面**，
  // 列表层持有的状态它拿不到 ⇒ 只能再往上提一层。
  // 筛选面板仍然在这里渲染（它属于列表视图），只是状态不再由这里产生。
  const collectPinnedTabs = useAppSelector(state => state.settings.collectPinnedTabs);
  // ── 2026-10-09 P1-4：空态主 CTA 不得 fire-and-forget ──────────────────
  // 这是**新用户第一屏**的主 CTA。原先 query 后直接 sendMessage、不 await、
  // 不看回包、无 loading、无禁点 —— SW 挂了或保存失败时界面零变化，
  // 用户只能猜「没点上」还是「坏了」。同一操作在 Header.tsx 已于 1.22.13 修好
  // （await + 转圈 + inline 成功/失败），唯独空态这条漏了。
  // 复用同一模式：在途禁点、回包决定成败、失败出声。
  // ── 2026-10-24 审计 PERF-03：折叠状态住在**列表层** ────────────────────
  //
  // 卡片远离视口时会被**卸载**（只留等高占位，见 DraggableTabGroup）⇒
  // 折叠状态若留在卡片内部，就随卸载一起没了 ⇒ 用户滚远再滚回来，
  // 刚才收起的会话又弹开了（一次「界面失忆」）。
  //
  // 为什么不用「按会话 id 存到磁盘」：折叠是**浏览时的临时状态**，
  // 以前它就是「组件挂载期间有效」；现在只是把寿命从「组件」延长到
  // 「这一页列表还在时」，语义没变，也不用为此新增一条持久化。
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(
    () => new Set<string>()
  );
  const toggleCollapsed = useCallback((groupId: string) => {
    setCollapsedIds(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  const [isSavingFromEmpty, setIsSavingFromEmpty] = useState(false);
  const [emptySaveFeedback, setEmptySaveFeedback] = useState<
    { kind: 'success' | 'error'; text: string } | null
  >(null);

  // 成功是轻提示：3 秒后自动退场（不打扰）。
  // **失败不自动消失** —— 否则用户可能没看到，就永远不知道刚才那次没成功
  // （「失败要出声」要求它留在原地，直到下次点击或状态变化）。
  useEffect(() => {
    if (emptySaveFeedback?.kind !== 'success') return;
    const timer = setTimeout(() => setEmptySaveFeedback(null), 3000);
    return () => clearTimeout(timer);
  }, [emptySaveFeedback]);

  const handleSaveFromEmpty = async () => {
    if (isSavingFromEmpty) return;
    setIsSavingFromEmpty(true);
    setEmptySaveFeedback(null);
    try {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const windowId = tabs[0]?.windowId;
      const response = (await chrome.runtime.sendMessage({
        type: 'SAVE_ALL_TABS',
        data: { windowId },
      })) as
        | { success?: boolean; error?: string; savedCount?: number; droppedPinnedCount?: number }
        | undefined;
      // sendMessage 对 {success:false} 是 resolve 不是 reject —— 不查回包
      // 就是「保存失败了却什么都不说」，与本仓修掉的谎报成功同一类。
      if (response?.success) {
        // ── 2026-10-20 审计 A-4：与顶栏按钮同一口径 ────────────────────
        // 固定标签页既没保存也没关闭时，必须说出来。空态 CTA 与顶栏按钮
        // 做的是同一件事（同一个 SAVE_ALL_TABS），反馈口径必须一致 ——
        // 否则用户在哪个入口点、看到哪种说法，就是随机行为。
        const summary = {
          savedCount: response.savedCount ?? 0,
          droppedPinnedCount: response.droppedPinnedCount ?? 0,
        };
        setEmptySaveFeedback({
          kind: 'success',
          text: saveAllSuccessShortMessage(summary),
        });
      } else {
        setEmptySaveFeedback({ kind: 'error', text: response?.error || '保存失败，请重试' });
      }
    } catch (saveError) {
      // sendMessage 在 SW 被回收 / 扩展重载时可能整体 reject
      logError('空态保存当前窗口失败:', saveError);
      setEmptySaveFeedback({ kind: 'error', text: '保存失败，请重试' });
    } finally {
      setIsSavingFromEmpty(false);
    }
  };

  // ── 2026-10-22 审计 L-11：空态的次级出口（云端恢复 / 设置 / 导入）─────
  // 见 components/tabs/emptyStateActions.ts 的文件头：空态只给「保存并关闭」
  // 时，换设备的老用户看到的是一片空白，最该做的那一步（登录 / 拉回云端）
  // 当时无处可点 —— 而自动同步默认关闭，不会替他拉。
  const [emptyRestoreBusy, setEmptyRestoreBusy] = useState(false);
  const [emptyRestoreFeedback, setEmptyRestoreFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const handleRestoreFromCloud = async () => {
    if (emptyRestoreBusy) return;
    setEmptyRestoreBusy(true);
    setEmptyRestoreFeedback(null);
    try {
      const res = await sendSyncCommand('download', { forceRemote: false, syncSettings: false });
      if (!res.ok) {
        // 失败原因用机器码 → 中文文案的统一映射（syncPreviewView），
        // 不要把裸枚举弹给用户，也不要自己另写一份映射。
        setEmptyRestoreFeedback({
          kind: 'error',
          text: resolveSyncFailureCopy({ reason: res.error, fallbackMessage: '无法从云端拉取数据' }),
        });
        return;
      }
      // 拉成功**不等于**拉到了东西：云端本来就可能是空的。
      // 刷新后按真实条数说话，不谎报「已拉回 N 个会话」。
      const loaded = await dispatch(loadGroups()).unwrap();
      setEmptyRestoreFeedback({
        kind: 'success',
        text: cloudPullOutcomeMessage(
          loaded.length > 0
            ? { kind: 'pulled', count: loaded.length }
            : { kind: 'empty' }
        ),
      });
    } catch (restoreError) {
      logError('空态从云端拉回失败:', restoreError);
      setEmptyRestoreFeedback({
        kind: 'error',
        text: cloudPullOutcomeMessage({ kind: 'failed' }),
      });
    } finally {
      setEmptyRestoreBusy(false);
    }
  };

  const emptyStateActions = resolveEmptyStateActions({ syncBackend, isAuthenticated });

  const showEmptyActionError = (text: string) => {
    setEmptyRestoreFeedback({ kind: 'error', text });
  };

  const handleEmptyStateAction = (action: (typeof emptyStateActions)[number]) => {
    // ── 2026-10-23 审计 R-12：出口的「对应关系」归判据层管 ────────────────
    // 以前这段是一个 switch，四个分支各自直接调 IO ⇒ 「点了会发生什么」
    // 只能靠人读源码（审计：这条线上一个断言都没有）。
    // 现在对应关系在 `core/emptyStateExits.ts`（纯函数、可测），
    // 这里只负责**注入**真正的 IO，并保证：
    //   每个出口要么真的触发了什么，要么**出声**说明它此刻用不了。
    runEmptyStateExit(action, {
      // 宿主没给登录弹窗的回调 ⇒ 这个出口此刻**点了没反应**
      // ⇒ 不传这个键（=「这个能力此刻不存在」）⇒ 判据层会替它出声。
      // 登录成功会触发 restoreAfterLogin 的整库拉取（显式意图不受自动同步开关约束）。
      ...(onOpenAuth ? { openAuth: () => onOpenAuth('login') } : {}),
      openOptions: () => {
        // 自带存储的口令与地址只能在设置页填 —— 那里才是能解开云盘的地方。
        chrome.runtime.openOptionsPage();
      },
      restoreFromCloud: () => {
        void handleRestoreFromCloud();
      },
      requestImport: () => requestImport(),
      unavailableMessage: (which) => EMPTY_STATE_EXIT_UNAVAILABLE[which],
      notifyUnavailable: showEmptyActionError,
    });
  };

  useEffect(() => {
    // 首次读取**不等**迁移（2026-10-22 审计 SC-1）：理由见 firstReadBootstrap.ts。
    bootstrapFirstRead({
      read: () => {
        dispatch(loadGroups());
      },
      runMigrations: async () => {
        // ── 2026-10-09 专家团体检 P0：迁移必须委托给 SW 单写者队列 ──
        //
        // 修复前这里直接 await runMigrations() —— 它内部三件（favicon 清洗、
        // 无墓碑清理、最近恢复历史）都是「全量读 → 改 → 写 groups」，在 **popup
        // realm** 执行，与 SW 的 mutation / sync:download 零互斥：
        // mutationQueue 的 pending/running 是模块级变量，popup 与 SW 各持一份
        // 队列实例，在 popup 里调 enqueue 也串行不了 SW 的写入。
        //
        // 结果是：t0 本页读快照 → t1 SW 刚保存的会话落盘 → t2 本页用 t0 整表
        // 写回 → 刚保存的会话当场消失（本地与云端一起丢，且 v1.22.0 无回收站）。
        //
        // 改走 RUN_MIGRATIONS 消息后，迁移与其它写在**同一条 SW 队列**内串行，
        // 与 importGroups 走 sendMutation 是同一条先例。
        const res = (await chrome.runtime.sendMessage({ type: 'RUN_MIGRATIONS' })) as
          | { success?: boolean; error?: string }
          | undefined;
        // sendMessage 在 SW 回 {success:false} 时是**resolve 不是 reject** ——
        // 不检查回包就是「失败被静默通过」，与本仓修掉的谎报成功同一类。
        // 迁移失败不阻断列表（上面已经读过了），但必须留下日志：
        // 否则「迁移没跑」与「迁移成功」在日志里完全同形。
        if (res && res.success === false) {
          logError('迁移失败（会话列表不受影响）:', res.error || 'SW 未给原因');
        }
        return res;
      },
      onMigrationsUnconfirmed: (reason) => {
        // 消息通道被关（用户关掉弹窗 / SW 被回收）**≠** 迁移失败：
        // 迁移在 SW 那边可能照样跑完了 ⇒ 只记「结果未知」，不报成失败。
        logWarn('迁移结果未知（消息通道关闭，迁移可能仍在完成）:', reason);
      },
    });

    // 刷新统一走这个 150ms 防抖出口：把「拖拽中连续 hover 触发的多次写盘回声」、
    // SW 的 REFRESH_TAB_LIST 合并成一次读取，避免同一帧内反复重载。
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleReload = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        dispatch(loadGroups());
      }, 150);
    };

    const messageListener = (message: { type?: string }) => {
      if (message.type === 'REFRESH_TAB_LIST') {
        invalidateGroupsCache();
        scheduleReload();
        // 只对**确实要处理**的消息返回 true。返回 true = 告诉 Chrome「我会稍后
        // 调 sendResponse」，于是发送方（SW 的 groupsChangedBus 广播）的 Promise
        // 会一直挂到本页面销毁为止——而本监听器从不调用 sendResponse。对无关消息
        // 也返回 true 会白白吊着对方的响应通道（1.22.11 修正）。
        return true;
      }
      return false;
    };

    chrome.runtime.onMessage.addListener(messageListener);

    const unsubscribe = onGroupsChanged(originId => {
      // 自己写出的回声：Redux 已是乐观更新后的新值，重载只会把列表打回存储态，
      // 拖拽时表现为整页刷新。缓存失效照旧（见 onGroupsChanged），其它上下文
      //（另一个窗口 / SW 后台写入 / 云端合并）的变更照常重载。
      if (originId === getContextOrigin()) return;
      scheduleReload();
    });

    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
      if (debounceTimer) clearTimeout(debounceTimer);
      unsubscribe();
    };
  }, [dispatch]);

  // 原始异常（PostgREST / message-port / chrome.storage 内部文本）只进日志，
  // 界面上给的是可行动文案——见 listErrorCopy。必须排在所有提前 return 之前，
  // 否则就是「条件 Hook」，渲染分支一变 hook 数量就变。
  //
  // state.error 是共享字段：loadGroups.rejected 与列表内写操作（删除/更新会话）的
  // rejected 都写它。不看 errorSource 一律打「加载会话列表失败」时，一次 removeTab
  // 30s 超时会被误报成加载失败（线上日志实锤），排障的人会往读路径上查——按来源分开。
  useEffect(() => {
    if (!error) return;
    if (errorSource === 'load') {
      logError('加载会话列表失败:', error);
    } else if (errorSource === 'action') {
      logError('列表内操作失败（非加载，如删除/更新会话）:', error);
    } else {
      logError('会话列表状态错误（来源未标注）:', error);
    }
  }, [error, errorSource]);

  // 非阻塞提示（列表里**已有数据**时后台刷新失败）用的还是「加载失败」那套文案 ——
  // 那条提示只在 errorSource === 'load' 时出现（见下方渲染分支），
  // 所以这里用 toListErrorCopy 正好；整页错误视图走下面的 errorView（按来源分流）。
  const errorCopy = toListErrorCopy(error);

  // 整页错误视图：文案与按钮**随 errorSource 变化**（2026-10-22 审计 SC-2）。
  //
  // 为什么不能只按 error 分流：`state.error` 是共享字段，一次**失败的撤销**
  // 与一次**读列表失败**写进去的东西长得一样 ⇒ 撤销失败会被整页报成
  // 「会话列表暂时不可用」+ 一个「重新加载」按钮 ⇒ 真正发生的事被盖掉，
  // 而重读列表并不能重试那次撤销。
  const errorView = toListErrorView({ errorSource, error, errorAction });

  // ── 2026-10-22 审计 SC-1：首次读取**没走完**之前，不许说「你没有会话」──
  //
  // 首次读取不是立即发生的：它要等一次存储读取（读路径不经过 SW，但仍是异步的），
  // 而 Redux 的 isLoading 初值是 false（它只表示「**这一轮**读取在途」）、
  // groups 初值是 [] ⇒ 第一帧看起来就是「你有 0 个会话」⇒ 空态卡（谎报）
  // + 一个**可点**的「保存并关闭」。
  //
  // ⇒ 在「读完了」之前，界面只给骨架屏，不给任何「你有 0 个会话」的断言。
  //    （「读完了」这个标志由 slice 在 loadGroups 的 fulfilled / rejected 里置位 ——
  //    读失败也算「读完了」，否则用户永远看不到错误页。）
  const firstReadPending = hasCompletedInitialLoad === false;

  // 只有「冷启动还没有任何数据」才整页 loading。
  // 后台刷新（onGroupsChanged / REFRESH_TAB_LIST）也会把 isLoading 置真，
  // 若照旧整页替换，拖拽/同步每次落盘都会闪一次全屏 spinner——即用户看到的
  // 「整个标签管理器页面都刷新了」。有数据时让刷新静默进行。
  //
  // 两个分支给的是**同一个**骨架屏：语义必须一致 ——
  // 一处说「还在读」、另一处说「读完了」会让用户以为自己看到的是最终结果。
  if (firstReadPending) {
    return <ListLoadingSkeleton />;
  }
  if (isLoading && groups.length === 0) {
    return <ListLoadingSkeleton />;
  }

  // 同理：已有数据时后台刷新失败不该把列表整页换成错误页，日志照旧（见上 error effect）。
  if (error && groups.length === 0) {
    return (
      <EmptyState
        tone="warning"
        title={errorView.title}
        description={errorView.description}
        action={
          // ── 只有**读路径**失败才给「重新加载」 ──────────────────────────
          // 动作失败（删除 / 撤销 / 重命名…）时，重读列表并不能重试那个操作 ——
          // 给那个按钮等于把用户引到一条解决不了问题的路上。
          // 那时给的是「回到会话列表」：只清掉这条错误提示，不动数据。
          errorView.reloadable ? (
            <button
              type="button"
              onClick={() => {
                dispatch(loadGroups());
              }}
              className="rounded-2xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              重新加载
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                dispatch(clearError());
              }}
              className="rounded-2xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              {errorView.dismissLabel}
            </button>
          )
        }
        className="min-h-[16rem] flex flex-col justify-center"
      />
    );
  }

  /**
   * 会话列表的排序（2026-10-22 审计 L-10）。
   *
   * 【为什么这里原来是写死的】旧版这一行是
   * `createdAt` 倒序 —— 只有一个排序口径，用户没得选。排序控件（下拉）
   * 落在筛选区里（见 SearchFilterPanel），判据与默认值在
   * `core/sessionSort.ts`，持久化在设置里（`settings.sessionSort`）。
   *
   * 【为什么默认值是「不改变现状」】默认键 `'saved'` 的判据与上面这行
   * **逐元素等价** ⇒ 存量用户升级后看到的顺序一个都不变（守卫钉住了
   * 这条等价性，见 tests/sessionSort.test.ts）。
   *
   * 【为什么不改搜索结果视图】搜索的主序是**相关度**，那是搜索的承诺；
   * 把排序套到搜索结果上会让「已按相关度排序」变成假话。
   * ⇒ 结果视图里**不摆排序控件**（2026-10-23 审计 R-6）：
   *   摆着一个「选了没反应」的下拉，比不摆更糟（控件说谎）。
   *
   * 【排序必须一路兑现到渲染层】排序算对了 ≠ 列表按它摆了。
   * 2026-10-23 审计 R-11 就栽在这儿：双栏布局把排好的顺序
   * 又按「标签数」重分了两栏 ⇒ 屏幕顺序与键盘 Tab 序都不等于排序序。
   * ⇒ 渲染层现在按**行主序**逐个铺（见下方双栏分支的注释）。
   */
  const sortedGroups = sortSessions(groups, sessionSort);

  const filteredGroups = sortedGroups;

  /**
   * 界面形态（见下方渲染分支的注释）。
   *
   * 「有搜索词」优先于「有筛选条件」：用户正在搜的时候，给他看搜索结果 ——
   * 筛选面板仍在结果区里（既有形态不变），条件也照常生效。
   */
  const viewMode = resolveSearchViewMode(searchQuery, filterControls.activeFilterCount > 0);

  if (filteredGroups.length === 0 && viewMode === 'list') {
    return (
      <div className="session-list-stack">
        {/* ── 2026-10-19 审计 I-1：空态收敛成**一张**卡 ──────────────────────
         *
         * 修复前这里上下叠着两张满宽大卡：
         *   · PersonalizedWelcome（258px）—— 问候 + 一句没有行动价值的话 + 又一次 logo
         *   · EmptyState（282px）—— 唯一有用的「先保存一个工作会话」+ 主 CTA
         * 主审真机复现（400×600）：卡1 占视口 43% 却零操作；卡2 的主 CTA 距
         * 视口底只有 4px（卡片下沿被切掉）。同一屏里「TapStack」出现 3 次。
         *
         * 收成一张卡：问候降为标题上的一行小字，情绪文案（「让稍后找回变得
         * 轻松」）删掉 —— 它没有告诉用户任何可执行的事。品牌 logo 已经在顶栏，
         * 空态再放一次是第三次重复。
         */}
        <EmptyState
          tone="default"
          title={`${getEmptyStateGreeting()}，先保存一个工作会话`}
          // 指代修正：空态自己就有这个按钮，原文案却指「右上角」，
          // 用户会不确定该点哪个。
          // 2026-10-09 P1-1：定位不变（保存 = 剪切），但新用户第一屏的 CTA
          // 必须在动手前把「标签会被关闭」说出来 —— 不能等它关了才发现。
          // 2026-10-19 I-3：措辞与顶栏按钮**逐字同源**（saveAndCloseLabel），
          // 两处各写一遍文案，迟早会漂移成「一个说关闭、一个不说」。
          description={`${saveAndCloseLabel}：把当前窗口收成可稍后找回的工作会话，当前标签随后会被关闭。固定标签默认不保存，可在设置中更改。快捷键 Ctrl+Shift+S（macOS 为 ⌘⇧S）也可快速保存。`}
          action={
            <div className="flex flex-col items-center gap-3">
              <button
                type="button"
                onClick={handleSaveFromEmpty}
                disabled={isSavingFromEmpty}
                className="btn btn-primary flat-interaction px-5 py-2.5 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                aria-busy={isSavingFromEmpty}
                title={`${saveAndCloseLabel}（快捷键 Ctrl+Shift+S，macOS 为 ⌘⇧S）`}
              >
                {isSavingFromEmpty ? '保存中…' : saveAndCloseLabel}
              </button>
              {/* 成功 3 秒后消失（见上方 useEffect）；失败常驻到下次操作 */}
              {emptySaveFeedback && (
                <p
                  role={emptySaveFeedback.kind === 'error' ? 'alert' : 'status'}
                  className={
                    emptySaveFeedback.kind === 'error'
                      ? 'text-sm text-red-600 dark:text-red-400'
                      : 'text-sm text-green-700 dark:text-green-400'
                  }
                >
                  {emptySaveFeedback.text}
                </p>
              )}

              {/* ── 2026-10-22 审计 L-11：别的用户是怎么走到这个空态的 ──────
                  新用户：保存一个工作会话 ⇒ 上面的主 CTA 就是对的。
                  换设备的老用户：他的会话在云端，**自动同步默认关闭**，
                  不会替他拉 —— 空态是他唯一能发现这件事的地方。
                  OneTab / JSON 老用户：他的会话在文件里。

                  这三条出口指向的都是**已经存在**的能力（登录 / 手动下载 /
                  设置页 / 导入），空态缺的只是出口，不是功能。 */}
              {emptyStateActions.length > 0 && (
                <div className="mt-1 flex w-full max-w-md flex-col items-center gap-2 border-t theme-border-default pt-3">
                  <p className="text-xs theme-text-muted">或者，你的会话已经在别处了：</p>
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    {emptyStateActions.map(action => (
                      <button
                        key={action}
                        type="button"
                        /* ── 2026-10-23 审计 R-12：出口的**身份**要可机读 ────────
                         * 守卫要能回答「这一格渲染的是哪个出口」，
                         * 而答案不能依赖文案（文案会改）。
                         * ⇒ 带上动作本身的标识（不是文案）。 */
                        data-testid={`empty-state-action-${action}`}
                        onClick={() => handleEmptyStateAction(action)}
                        disabled={emptyRestoreBusy && action === 'download'}
                        className="theme-radius-control theme-btn-hover border theme-border-default px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors disabled:cursor-not-allowed disabled:opacity-60 dark:text-gray-300"
                        title={EMPTY_STATE_ACTION_HINT[action]}
                        aria-label={`${EMPTY_STATE_ACTION_LABEL[action]}：${EMPTY_STATE_ACTION_HINT[action]}`}
                      >
                        {action === 'download' && emptyRestoreBusy
                          ? CLOUD_PULL_BUSY_LABEL
                          : EMPTY_STATE_ACTION_LABEL[action]}
                      </button>
                    ))}
                  </div>
                  {emptyRestoreFeedback && (
                    <p
                      role={emptyRestoreFeedback.kind === 'error' ? 'alert' : 'status'}
                      className={
                        emptyRestoreFeedback.kind === 'error'
                          ? 'text-sm text-red-600 dark:text-red-400'
                          : 'text-sm text-green-700 dark:text-green-400'
                      }
                    >
                      {emptyRestoreFeedback.text}
                    </p>
                  )}
                </div>
              )}
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div className="session-list-stack micro-interaction-container">
      {/* ── 2026-10-09 P1-9：已有数据时的后台刷新失败必须出声 ─────────────
       * 下面的错误页只覆盖 `error && groups.length === 0`（冷启动无数据）。
       * 而**列表里已经有数据**时再发生一次 loadGroups 失败，原先完全没有任何
       * 可见出口 —— 界面继续显示旧列表，只有 console 里一行日志。用户不知道
       * 「自己正在看的是上次的数据」，更不知道刚才刷新失败了。
       *
       * 为什么不改成整页错误页：那正是上面注释论证过、必须避免的行为
       * （后台刷新会闪掉整个页面，拖拽/同步每次落盘都全屏跳一次）。
       * 所以保留列表 + 补一条**非阻塞**提示 —— 减法减的是常驻界面，
       * 不是减掉失败反馈。
       *
       * 为什么必须判 errorSource === 'load'：error 是共享字段，列表内写操作
       *（删除/更新会话）的 rejected 也写它。不分开判的话，一次 removeTab
       * 30s 超时会被误报成「加载失败」，排障的人会往读路径上查（线上日志实锤）。
       */}
      {error && errorSource === 'load' && groups.length > 0 && (
        <div
          role="alert"
          className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm dark:border-amber-700 dark:bg-amber-950/40"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-amber-900 dark:text-amber-200">
              <strong className="font-medium">{errorCopy.title}</strong>
              <span className="ml-1.5 text-amber-800 dark:text-amber-300">
                当前显示的是上次读到的会话。
              </span>
            </span>
            <button
              type="button"
              onClick={() => dispatch(loadGroups())}
              className="rounded-lg border border-amber-400 px-3 py-1 text-xs font-medium text-amber-900 transition hover:bg-amber-100 dark:border-amber-700 dark:text-amber-100 dark:hover:bg-amber-900/60"
            >
              重新加载
            </button>
          </div>
          <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
            {errorCopy.description}
          </p>
        </div>
      )}

      {/* ── 2026-10-20 审计 A-14：筛选器是**独立入口**，不依赖搜索词 ────────
          三种形态由 resolveSearchViewMode 决定：
            · list   —— 没有搜索词、也没有生效的筛选条件 ⇒ 主列表（首页形态不变）
            · browse —— 没有搜索词、但有筛选条件 ⇒ 筛选浏览视图
            · search —— 有搜索词 ⇒ 搜索结果（既有形态不变）

          筛选面板在 list / browse 两种形态下都渲染在列表上方 ⇒
          「按域名 / 会话名 / 保存时间找」不需要先输入一个搜索词。 */}
      {viewMode === 'list' && (
        <SearchFilterSection
          controls={filterControls}
          title="筛选会话"
          collectPinnedTabs={collectPinnedTabs}
          variant="flush"
        />
      )}

      {viewMode !== 'list' ? (
        /* ── 2026-10-23 审计 SC-4：结果视图的零结果页也要有「登录」出口 ────
         * 搜索**只搜本机**的会话 ⇒ 用户的会话在云端时这里必然零结果，
         * 而「把云端的会话拉回来」这条路只有空态有 ⇒ 零结果页必须给出
         * **同样的出口**（判据与执行都在判据层，与本组件的空态同一份）。
         *
         * 「登录」那一格需要一个能真的打开登录弹窗的能力 —— 弹窗实例由
         * MainApp 持有，这里把同一个回调转交给结果视图（两个界面共用
         * **同一个**弹窗，不会出现两个 portal）。 */
        <SearchResultList
          searchQuery={searchQuery}
          filterControls={filterControls}
          {...(onOpenAuth ? { onOpenAuth } : {})}
        />
      ) : layoutMode === 'double' ? (
        /* ── 2026-10-23 审计 R-11：双栏必须是**行主序** ──────────────────────
         *
         * 修复前这里是「两列各一个 div」，按**标签数**贪心均衡分栏：
         *
         *   const columns = [[], []];  // 按标签数塞进更空的那一栏
         *
         * ⇒ 屏幕上的阅读顺序、**键盘 Tab 序**（= DOM 序 = 先走完左栏再走右栏）
         *   都**不等于**用户选的排序。审计穷举：6 个会话 × 标签数 {1,2,3,4}
         *   共 4096 种组合，DOM 序与排序序 **100% 不一致**，逐行视觉序约 2/3 不一致。
         *   键盘用户与读屏用户拿到的顺序，和眼睛看到的**不一样** ——
         *   比「视觉顺序错」更糟。
         *
         * 【这一版的取舍（明说，不假装没有代价）】
         * 现在 `filteredGroups`（已按 `sortSessions` 排好）**逐个**成为网格的
         * 直接子项 ⇒ CSS grid 两列 ⇒ 视觉上是 1,2 / 3,4 / 5,6
         * ⇒ **DOM 序 == 视觉序 == 排序序**，三者一致。
         *
         * 代价：**放弃按卡片高度均衡**（会出现「高低脚」——
         * 同一行里两张卡片高度不同时，短的那张下面留白）。
         * 这是**有意接受**的取舍：用户的显式选择（排序）优先级高于
         * 视觉上的齐整。审计原文的取舍也是这一条
         * （「可以让**高度**去均衡，而不是让**顺序**去均衡」—— 那是以后的事）。
         * 另一档更差的修法是「保留现状 + 文案提示用户」= 把缺陷写进文案，
         * 等于承认功能半残 —— 本仓明令不做。
         */
        <div className="session-grid">
          {filteredGroups.map(group => (
            <DraggableTabGroup
              key={group.id}
              group={group}
              collapsed={collapsedIds.has(group.id)}
              onToggleCollapsed={() => toggleCollapsed(group.id)}
            />
          ))}
        </div>
      ) : (
        <div className="session-list-stack transition-all duration-300 ease-out">
          {filteredGroups.map(group => (
            <DraggableTabGroup
              key={group.id}
              group={group}
              collapsed={collapsedIds.has(group.id)}
              onToggleCollapsed={() => toggleCollapsed(group.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default TabList;
