import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { Tab, TabGroup } from '@/types/tab';
import { deleteGroup, deleteTabAndSync, deleteBroadcastWarn } from '@/store/slices/tabSlice';
import { isOpenableTabUrl } from '@/utils/inputValidation';
import { shouldAutoDeleteAfterTabRemoval } from '@/core/tabGroupUtils';
import { OpenGuard, OpenAllGuard } from '@/utils/openGuard';
import { useToast } from '@/contexts/ToastContext';
import { useEnhancedToast } from '@/utils/toastHelper';
import { trackProductEvent } from '@/utils/productEvents';
import {
  AdvancedSearch,
  SessionSearchResult,
  applySearchFilters,
  buildSessionSearchResults,
} from '@/utils/search';
import {
  SEARCH_EVENT_THROTTLE_MS,
  SearchEventSnapshot,
  buildSearchEventSignature,
  hasActiveSearchFilters,
  remainingMsUntilAllowed,
  searchEventNames,
  shouldEmitSearchEvents,
} from './searchAnalytics';
import HighlightText from './HighlightText';
import { SafeFavicon } from '@/components/common/SafeFavicon';
import { EmptyState } from '@/components/common/EmptyState';
import { getSessionResultSummary, getDisplayUrl } from '@/utils/sessionPresentation';
import { logError } from '../../utils/log';
import { toServiceWorkerErrorCopy } from '@/utils/serviceWorkerErrorCopy';
import { mutationErrorMessage } from '@/components/tabs/mutationErrorCopy';
import {
  openSingleTabSuccessMessage,
  restoreAllSearchSuccessMessage,
  restoreGroupSuccessMessage,
} from '@/components/tabs/restoreFeedbackCopy';
import { useConsumeUndo } from '@/components/tabs/useConsumeUndo';
import type { ConsumedTabRef, ConsumeUndoSpec } from '@/core/consumeUndo';
import { searchEmptyHint } from '@/components/search/searchEmptyHint';
import {
  buildResultWindow,
  resultTruncationMessage,
} from '@/components/search/searchWindowing';
import { SearchFilterSection } from '@/components/search/SearchFilterPanel';
import {
  browseEmptyDescription,
  browseEmptyTitle,
  browseSummaryCopy,
  browseTruncationMessage,
  noCriteriaEmptyDescription,
  noCriteriaEmptyTitle,
  buildBrowseResults,
  bulkActionTitle,
  resultCardTitle,
  resultRegionLabel,
  resultViewTitle,
  searchSummaryCopy,
  showFilterSectionTitle,
} from '@/components/search/searchBrowseMode';
import type { SearchFilterControls } from '@/components/search/searchFilterState';

const PinIcon = () => (
  <svg className="w-3 h-3 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
  </svg>
);

interface SearchResultListProps {
  searchQuery: string;
  /**
   * 筛选状态与动作（**由列表层持有**）。
   *
   * 为什么不是本组件的内部 state：本组件只在有搜索词（或有筛选条件）时挂载，
   * 一旦卸载，内部 state 就没了 —— 清空搜索词会连带把用户设好的筛选条件
   * 一起清掉（2026-10-20 审计 A-14）。
   *
   * 状态住在列表层 ⇒ 结果视图卸载**不影响**筛选条件：
   * 用户搜「react」→ 设了「7 天内」→ 清空搜索词 → 再搜「redux」，
   * 筛选条件仍在并自动生效。
   */
  filterControls: SearchFilterControls;
}

export const SearchResultList: React.FC<SearchResultListProps> = ({
  searchQuery,
  filterControls,
}) => {
  const dispatch = useAppDispatch();
  const { groups } = useAppSelector(state => state.tabs);
  const confirmBeforeDelete = useAppSelector(state => state.settings.confirmBeforeDelete);
  // ── 2026-10-20 审计 A-5：「固定标签页」筛选器在默认配置下永远筛不出东西 ──
  // `collectPinnedTabs` 默认 false ⇒ 存进会话的标签 `pinned` 恒为 false
  // ⇒ 「仅固定」永远 0 结果、「排除固定」等价于「全部」。
  //
  // 把一个**在默认配置下无效的过滤器**摆在用户面前，还鼓励他去用，
  // 是「选项在骗用户」的一类问题。与其给它加一句「需在设置中开启」的说明，
  // 不如**默认不显示** —— 用户在设置里开启了之后它自己就会出现。
  const collectPinnedTabs = useAppSelector(state => state.settings.collectPinnedTabs);
  // ── 2026-10-20 审计 A-9：showFavicons / showTabCount 现在**真被读** ──
  // 修复前这两个设置只有默认值与上云映射，UI 从不读它们 —— favicon 永远显示、
  // 标签数量永远显示，用户拨不动。设置页现在有开关（OptionsPage「外观」小节），
  // 渲染点按它们的值决定显不显示。三个渲染点（会话卡片徽章 / 搜索结果徽章 /
  // 顶栏「N 标签」）共用同一个字段、同一个含义。
  const showFavicons = useAppSelector(state => state.settings.showFavicons);
  const showTabCount = useAppSelector(state => state.settings.showTabCount);
  const { showConfirm } = useToast();
  const { showDeleteError, showRestoreError, showRestoreSuccessMessage } = useEnhancedToast();
  // ── 2026-10-22 审计 P0-4：恢复即消费 ⇒ 给一条「撤销」的路 ─────────────
  // 撤销的语义与实现见 @/core/consumeUndo.ts 与 useConsumeUndo.ts。
  const { showConsumeToast } = useConsumeUndo();
  const {
    effectiveFilters,
    activeFilterCount,
    clearFilters,
  } = filterControls;
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const normalizedSearchQuery = deferredSearchQuery.trim();
  /**
   * 当前视图形态。
   *
   * · `search` —— 有搜索词：既有形态，不变。
   * · `browse` —— 没有搜索词、但有生效的筛选条件：筛选浏览视图。
   *
   * 两种形态共用同一套结果渲染管线，只是**结果集来源**与**文案**不同 ——
   * 详见 ./searchBrowseMode 的文件头（为什么空搜索词下的结果集必须是全部标签）。
   */
  const isBrowseMode = !normalizedSearchQuery && activeFilterCount > 0;
  /**
   * 什么都没给（既无搜索词，也无生效的筛选条件）。
   *
   * 正常路径下这一格不该出现（列表层只在有搜索词或有条件时才渲染结果视图），
   * 但组件自己不能说假话 —— 否则界面上会出现「没有找到与“”相关的会话或标签」
   * （空引号 + 「请尝试其他关键词」），那是在声称用户搜过、没搜到。
   */
  const hasNoCriteria = !normalizedSearchQuery && activeFilterCount === 0;

  // 搜索管线（全文检索 → 筛选 → 按会话归组）是本组件最重的计算。
  // 此前每次渲染都全量重跑，包括用户每敲一个字符的中间态；
  // 用 useMemo 把重算收敛到「groups / 查询词 / 筛选条件真正变化」时才发生。
  //
  // ── 结果集来源分两种 ──────────────────────────────────────────────────
  // · 有搜索词 ⇒ 全文检索命中的标签（既有行为，不变）。
  // · 无搜索词但有筛选条件 ⇒ **全部标签**（buildBrowseResults）。
  //   理由：会话级筛选（会话名 / 保存时间）的判据作用在**会话**上，
  //   若结果集只含「命中搜索词的标签」，这两类筛选就没有判据可作用
  //   ⇒「按会话名找」永远筛不出东西。详见 ./searchBrowseMode 的文件头。
  const baseResults = useMemo(
    () => {
      if (normalizedSearchQuery) {
        return AdvancedSearch.search(groups, {
          query: normalizedSearchQuery,
          searchPinned: true,
        });
      }
      return isBrowseMode ? buildBrowseResults(groups) : [];
    },
    [groups, isBrowseMode, normalizedSearchQuery]
  );
  // 筛选项被隐藏 ≠ 筛选条件失效。
  // 设置页在**另一个标签页**里被改动时，本页会收到 storage 变更 ⇒
  // 用户可能「开启过固定标签筛选 → 设了条件 → 再关掉设置」。
  // 若条件继续生效，用户看不到筛选项却被筛掉了结果 —— 这是最坏的一种隐形行为。
  // 所以设置一关，条件一并作废（activeFilterCount 与埋点口径同步跟着走）。
  //
  // ↑ 这段判定的**执行位置**搬到了列表层（见 filterControls 的来处）：
  // 条件与它的有效性必须同源，否则两处各判一遍必然漂移。
  const searchResults = useMemo(
    () => applySearchFilters(baseResults, effectiveFilters),
    [baseResults, effectiveFilters]
  );
  const sessionResults = useMemo(() => buildSessionSearchResults(searchResults), [searchResults]);
  const matchingTabs = useMemo(
    () => sessionResults.flatMap(session => session.matches),
    [sessionResults]
  );


  // ── 2026-10-20 审计 A-11：搜索结果也要有渲染上限 ───────────────────────
  // 修复前这里**全量渲染**所有匹配结果：400 会话 × 20 标签搜一个宽泛词
  // （如 "https"）⇒ 91311 个 DOM 节点、搜索响应 1250ms、滚动掉到 11fps。
  // 主列表早有虚拟化（lazyTabRows + useNearViewport），搜索这条路却没有 ——
  // 而搜索是本产品最高频的「找回」路径。
  //
  // 当前**只有一道**防线（判据在 searchWindowing.ts，可测）：
  //   1. **条数上限**：命中很多时只展示最靠前的部分。AdvancedSearch 已按
  //      相关度排好序 ⇒ 截断是排序的兑现，不是信息损失。截断了必须说清
  //      「还有 N 条未显示」，否则用户会以为只找到了这么多。
  //
  // ── 2026-10-22 架构审计 D1 更正 ──────────────────────────────────────────
  // 这段注释原先写着「两道防线」，第二条是「**分片渲染**：结果条数没超上限、
  // 但会话分组多时，按片渲染」—— 而它**在生产代码里不存在**：
  // `searchWindowing.ts` 的 `computeVisibleChunks` / `chunkResults` /
  // `SEARCH_CHUNK_SIZE` 三个导出**零生产调用点**（只有单测在测它们）。
  //
  // 为什么这句谎话危险：只看这个文件的人会以为「搜索路径已经做了渲染上限」，
  // 于是以为「200 条截断管住了渲染量」—— 但它只管住了**标签条数**，
  // **没管住卡头数**（visibleSessionResults 按整组保留：400 组各命中 1 个标签时，
  // 200 组全部渲染，每组一个卡头）。
  //
  // ⇒ 注释必须说真话。分片能力**还没接线**（接线需要给 useNearViewport 加
  // 「当前第几片」的接口），接线前不许在这里声称它存在。
  // 守卫见 tests/guards/noPhantomMechanisms.test.ts。
  const resultWindow = useMemo(
    () => buildResultWindow(matchingTabs.length),
    [matchingTabs.length]
  );
  const visibleSessionResults = useMemo(() => {
    // 截断按**标签条数**算（用户感知的是「条结果」），但渲染的最小单位是
    // 「会话分组」—— 一个分组里的命中标签要么全在、要么全不在，
    // 否则摘要行「匹配 n/m 个标签」会与实际显示的不符。
    const kept: SessionSearchResult[] = [];
    let used = 0;
    for (const session of sessionResults) {
      if (used >= resultWindow.visible) break;
      kept.push(session);
      used += session.matches.length;
    }
    return kept;
  }, [sessionResults, resultWindow.visible]);
  // ── 埋点：leading + trailing 节流（见 ./searchAnalytics） ────────────────
  // 依赖 filters 对象时每敲一个字符就会重跑；节流后连续输入只在窗口首尾各发一次，
  // 且保证「用户停下时的最终状态」一定被记录（trailing 补发）。
  const analyticsStateRef = useRef({ lastSignature: '', lastEmitAt: 0 });
  const latestSnapshotRef = useRef<SearchEventSnapshot>({
    query: normalizedSearchQuery,
    domain: null,
    groupName: null,
    pinned: 'all',
    savedWithin: null,
    resultCount: 0,
  });
  const trailingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const emitSearchEvents = useCallback((snapshot: SearchEventSnapshot) => {
    const names = searchEventNames(snapshot);
    for (const name of names) {
      void trackProductEvent(name, {
        query: snapshot.query,
        resultCount: snapshot.resultCount,
        ...(name === 'search_filtered'
          ? {
              domain: snapshot.domain,
              groupName: snapshot.groupName,
              pinned: snapshot.pinned,
              savedWithin: snapshot.savedWithin,
            }
          : {
              hasDomainFilter: !!snapshot.domain,
              hasSavedWithinFilter: !!snapshot.savedWithin,
            }),
      });
    }
    analyticsStateRef.current = {
      lastSignature: buildSearchEventSignature(snapshot),
      lastEmitAt: Date.now(),
    };
  }, []);

  useEffect(() => {
    const snapshot: SearchEventSnapshot = {
      query: normalizedSearchQuery,
      domain: effectiveFilters.domain || null,
      groupName: effectiveFilters.groupName || null,
      pinned: effectiveFilters.pinned || 'all',
      savedWithin: effectiveFilters.savedWithin || null,
      resultCount: searchResults.length,
    };
    latestSnapshotRef.current = snapshot;

    // ── 空搜索词时不是「什么都不用记」 ──────────────────────────────────
    // 没有搜索词、但**有生效的筛选条件** ⇒ 这是一次真实的「筛选浏览」
    // （用户按域名/时间找会话），必须记 `search_filtered`。
    // 两者都没有 ⇒ 用户只是打开扩展看了一眼，什么都没做 ⇒ 不记。
    // 判定在 `searchEventNames` 里（口径与「发哪些事件」同源）。
    if (!snapshot.query && !hasActiveSearchFilters(snapshot)) return;

    const state = analyticsStateRef.current;
    const now = Date.now();
    if (
      shouldEmitSearchEvents({
        lastSignature: state.lastSignature,
        lastEmitAt: state.lastEmitAt,
        nextSignature: buildSearchEventSignature(snapshot),
        now,
      })
    ) {
      if (trailingTimerRef.current) {
        clearTimeout(trailingTimerRef.current);
        trailingTimerRef.current = null;
      }
      emitSearchEvents(snapshot);
      return;
    }

    // 窗口内：重排 trailing 定时器（每次输入都把补发时间推到窗口末尾），
    // 补发的是 latestSnapshotRef 里的最新快照，不是触发本次 effect 的旧快照。
    if (trailingTimerRef.current) clearTimeout(trailingTimerRef.current);
    const wait = remainingMsUntilAllowed(state.lastEmitAt, now, SEARCH_EVENT_THROTTLE_MS);
    trailingTimerRef.current = setTimeout(() => {
      trailingTimerRef.current = null;
      const latest = latestSnapshotRef.current;
      if (!latest.query && !hasActiveSearchFilters(latest)) return;
      if (buildSearchEventSignature(latest) === analyticsStateRef.current.lastSignature) return;
      emitSearchEvents(latest);
    }, wait);
  }, [emitSearchEvents, effectiveFilters, normalizedSearchQuery, searchResults.length]);

  useEffect(
    () => () => {
      if (trailingTimerRef.current) clearTimeout(trailingTimerRef.current);
    },
    []
  );

  // 复活去重守卫（逻辑见 @/utils/openGuard，可单测）：与 TabGroup 同一对类、同一套语义 ——
  // 单 tab 按 tabId 冷却去重，整组恢复按 group.id 加同类在途锁。组件卸载即丢弃，无需额外清理。
  //
  // 【为什么搜索页必须有】搜索页的「打开标签 / 恢复整个会话」原先不经过任何守卫，
  // 而 SW 的 OPEN_TAB / OPEN_TABS **不做去重**（service-worker.ts）⇒ 双击一个结果标题
  // 就是同一 URL 开出两个浏览器标签；双击「恢复整个会话」就是两个装满同一批标签的窗口。
  // 同样的动作在列表页只会执行一次 —— 同一个产品两个界面两种行为。
  const openGuardRef = useRef<OpenGuard | null>(null);
  const openAllGuardRef = useRef<OpenAllGuard | null>(null);
  if (openGuardRef.current === null) openGuardRef.current = new OpenGuard();
  if (openAllGuardRef.current === null) openAllGuardRef.current = new OpenAllGuard();

  const restoreSession = (group: TabGroup) => {
    const allGuard = openAllGuardRef.current as OpenAllGuard;
    // 在途锁（与 TabGroup.openAllTabs 同口径）：恢复流程（SW 开窗口 + 删本地组）结束前，
    // 同一会话的重复点击直接忽略。
    //
    // 【命中锁不能一声不吭】静默 return 等于「点了没反应」，用户只能自己猜
    // 「没点上」还是「坏了」——「按了键没反应必须有一句话解释」是本项目的第一性原则。
    if (!allGuard.tryAcquire(group.id)) {
      showRestoreError('正在恢复该会话，请稍候…');
      return;
    }
    const releaseAll = () => allGuard.release(group.id);
    // 兜底：dispatch 悬挂时不永久锁死该会话的恢复入口
    const safetyTimer = setTimeout(releaseAll, 10000);
    const releaseAllOnce = () => {
      clearTimeout(safetyTimer);
      releaseAll();
    };

    const tabsPayload = group.tabs.map(tab => ({
      url: tab.url,
      pinned: !!tab.pinned,
    }));

    void trackProductEvent('session_restored', {
      sessionId: group.id,
      sessionName: group.name,
      source: 'search',
      tabCount: group.tabs.length,
    });

    // ── 先开后删（与 TabGroup.openAllTabs 同口径）────────────────────────
    // 原顺序是先 dispatch(deleteGroup) 再发 OPEN_TABS：SW 拒开或页面关闭导致无回包
    // 时，会话已被物理删除而无回收站。现在只有 success:true 才消费原会话。
    const consumeSession = () => {
      if (group.isLocked) {
        // 锁定组恢复后保留，可反复用；无 dispatch 可挂 finally，此处即解锁
        releaseAllOnce();
        return;
      }
      // ponytail: 去掉 fake dispatch，依赖真实 thunk fulfilled 触发 reducer + middleware
      dispatch(deleteGroup(group.id))
        .unwrap()
        .then(payload => {
          // 与 TabGroup.openAllTabs 同口径：恢复会整组物理移除，广播登记失败
          // 必须 surface，否则对端复活而用户以为恢复成功。
          const warn = deleteBroadcastWarn(payload);
          if (warn) showDeleteError(warn);
        })
        .catch(error => {
          logError('恢复会话后清理原会话失败:', error);
          showDeleteError(mutationErrorMessage('恢复会话后清理原会话', error));
        })
        .finally(releaseAllOnce);
    };

    chrome.runtime.sendMessage(
      {
        type: 'OPEN_TABS',
        data: { tabs: tabsPayload },
      },
      (res: unknown) => {
        const r = res as
          | { success?: boolean; skippedUnopenable?: number; error?: string }
          | undefined;
        // 与 TabGroup.openAllTabs 同口径：没有 success:true 就没有证据证明标签
        // 打开了，记录原样保留（可重试），不能先删后开。
        if (!r || r.success !== true) {
          releaseAllOnce();
          // 2026-10-19 审计 F-7：同 TabGroup，SW 的机器码要先翻译成中文。
          showDeleteError(
            `${toServiceWorkerErrorCopy(r?.error, '恢复会话失败')}。原会话仍保留在列表中。`
          );
          return;
        }
        consumeSession();
        if (typeof r.skippedUnopenable === 'number' && r.skippedUnopenable > 0) {
          const keptNote = group.isLocked
            ? '该会话已锁定，记录仍在列表中。'
            : '这几个地址不再保存在列表中。';
          showDeleteError(
            `已恢复 ${tabsPayload.length - r.skippedUnopenable} 个标签；另有 ` +
              `${r.skippedUnopenable} 个在当前设备无法打开（本地文件、临时链接或浏览器内部页面）。` +
              keptNote
          );
          return;
        }
        // ── 2026-10-22 审计 P1-4：成功必须出声 ─────────────────────────────
        // 修复前这里**什么都不说**：窗口开了、会话卡从列表消失、屏幕上零反馈。
        // 「我的会话怎么没了？」是用户看到卡片凭空消失时的第一反应，
        // 而它其实是成功。
        //
        // 对照：列表页（TabGroup）同一动作早就有播报，搜索页没有 ——
        // 同一个产品动作，两个界面两种反馈。
        // 文案复用 restoreFeedbackCopy.ts：列表页与搜索页共用一份措辞。
        //
        // ── 2026-10-22 审计 P0-4：挂上「撤销」 ───────────────────────────
        // 未锁定会话恢复后即被消费（记录从列表移除、无回收站）⇒ 这次成功
        // 同时是一次**不可撤销的删除**。给它配一条退路，是产品该有的最低配置。
        // 锁定会话从不被消费 ⇒ 没有东西可撤 ⇒ 不挂按钮（挂了就是骗人）。
        // 撤销凭据里的 group 是**消费前**的那份快照（闭包捕获的旧值）。
        showConsumeToast(
          restoreGroupSuccessMessage(tabsPayload.length, group.isLocked),
          group.isLocked ? undefined : { group },
        );
      }
    );
  };

  const handleOpenTab = (tab: Tab, group: TabGroup) => {
    // ── 不可开的地址先于一切拦下（与 TabGroup.handleOpenTab 同口径）─────────
    // 顺序理由见 TabGroup：排在锁定分支之后 ⇒ 锁定组的 success:false 回包被丢弃、
    // 点了没反应；排在去重守卫之后 ⇒ 第二次点击的文案会谎报「刚刚已打开」。
    if (!isOpenableTabUrl(tab.url)) {
      showRestoreError('此标签在当前设备无法打开，已保留在会话中');
      return;
    }
    // ── 在途+冷却去重（与 TabGroup.handleOpenTab 同口径，见 @/utils/openGuard）──
    // mutation 回包前的重复点击直接忽略；回包后冷却期内同样忽略，防止同一 URL
    // 被二次点开导致开出多个浏览器标签（SW 的 OPEN_TAB 不做去重）。
    // 锁定组不删本地项、恢复立即可见，只需防双击（见 openCooldownMs）；
    // 失败必须 release，否则该 tab 会被记住一整个冷却窗口、点重试无反应。
    const guard = openGuardRef.current as OpenGuard;
    // 【冷却命中必须出声】tryAcquire 失败就静默 return 等于「点了没反应」。
    if (!guard.tryAcquire(tab.id, group.isLocked)) {
      showRestoreError('刚刚已打开这个标签，正在冷却中，请稍候再试');
      return;
    }
    const releaseOnFailure = () => guard.release(tab.id);
    // ── 点开即消费（2026-10-14，与 TabGroup.handleOpenTab 同口径） ─────────
    // 先开后删，SW 回包 success 才删；SW 拒开 / 前置不可开 → 提示 + 记录保留。
    // 锁定组从不消费（与整组恢复语义一致）。两处必须同口径，否则同一个产品
    // 在两个界面两种行为。
    if (group.isLocked) {
      // ── 2026-10-22 审计 P1-4 + P1-6：锁定分支也要有**成功门** ─────────
      // 修复前这里是 `.catch` 一个 promise、**没有 `.then`** ⇒
      //   · 成功：零反馈（行也还在、屏幕也不动，用户分不出「已打开」与「没反应」）
      //   · 失败：SW 拒开是 `sendResponse({success:false})` ⇒ promise **resolve
      //     而不是 reject** ⇒ `.catch` 根本不触发 ⇒ 失败也零反馈
      // 改用 callback 形式，照抄下面未锁定分支的 success 判定：
      // 没有 success:true 就没有证据证明打开了，不能报成功。
      chrome.runtime.sendMessage(
        {
          type: 'OPEN_TAB',
          data: { url: tab.url, pinned: !!tab.pinned },
        },
        (res: unknown) => {
          const r = res as { success?: boolean; error?: string } | undefined;
          if (!r || r.success !== true) {
            releaseOnFailure();
            showRestoreError(toServiceWorkerErrorCopy(r?.error, '打开失败，已保留在会话中'));
            return;
          }
          // 锁定组不消费记录，但**行也还在** —— 屏幕上同样什么都不动，
          // 「点了没反应」与「已打开」用户分不出来。
          showRestoreSuccessMessage(openSingleTabSuccessMessage(true));
        }
      );
      return;
    }
    chrome.runtime.sendMessage(
      {
        type: 'OPEN_TAB',
        data: { url: tab.url, pinned: !!tab.pinned },
      },
      (res: unknown) => {
        const r = res as { success?: boolean; error?: string } | undefined;
        if (!r || r.success !== true) {
          releaseOnFailure();
          showRestoreError(toServiceWorkerErrorCopy(r?.error, '打开失败，已保留在会话中'));
          return;
        }
        dispatch(deleteTabAndSync({ groupId: group.id, tabId: tab.id }))
          .unwrap()
          .then(payload => {
            const warn = deleteBroadcastWarn(payload);
            if (warn) showDeleteError(warn);
            // ── 2026-10-22 审计 P1-4：点开即消费 = 一次不可撤销的删除 ──
            // 这是本产品**最高频**的动作，却是零反馈的：标签行消失、
            // 页面打开、屏幕上什么都不动。用户无法区分「已打开」与「被删了」。
            // 成功门已过（SW 回包 success:true），所以这里可以放心报成功。
            //
            // ── 2026-10-22 审计 P0-4：挂上「撤销」 ───────────────────────
            // 点开即消费 = 一次不可撤销的删除（无回收站），而这是本产品
            // 最高频的动作。给一条退路。
            // 撤销凭据带**下标**：撤销时把这条标签插回原来的位置，而不是
            // 追加到末尾（顺序是用户自己排的，撤销不该偷偷改它）。
            showConsumeToast(
              openSingleTabSuccessMessage(false),
              {
                group,
                consumedTabId: tab.id,
                consumedIndex: group.tabs.findIndex(t => t.id === tab.id),
              },
            );
          })
          .catch(error => {
            logError('打开后从会话移除失败:', error);
            showDeleteError(mutationErrorMessage('标签已打开，但从会话移除', error));
          });
      }
    );
  };

  const handleDeleteTab = (tab: Tab, group: TabGroup) => {
    // 锁定会话不逐条删除：锁定承诺「防误删」，而删除不可撤销（无回收站）。
    // 按钮在锁定组里已不渲染（见 renderTabItem），这里是绕过 UI 时的兵底 ——
    // 与批量删除 / 恢复两条路径的 `if (group.isLocked) continue` 同一口径。
    if (group.isLocked) {
      showDeleteError('该会话已锁定，解锁后才能删除其中的标签');
      return;
    }

    const runDelete = () => {
      dispatch(deleteTabAndSync({ groupId: group.id, tabId: tab.id }))
        .unwrap()
        .then(payload => {
          // 删掉组内最后一个标签会变成「整组物理移除」，广播登记失败同样要 surface。
          const warn = deleteBroadcastWarn(payload);
          if (warn) showDeleteError(warn);
        })
        .catch(error => {
          showDeleteError(mutationErrorMessage('更新会话', error));
        });
    };

    // 删掉最后一条活跃标签 = 整组物理移除（判据复用 applyRemoveTab 的同一份语义）：
    // 后果与「删除整个会话」等价 ⇒ 与列表页、与整组删除同口径走确认开关。
    if (!confirmBeforeDelete || !shouldAutoDeleteAfterTabRemoval(group, tab.id)) {
      runDelete();
      return;
    }

    showConfirm({
      title: `删除「${group.name}」？`,
      message: '这是该会话的最后一条标签记录，删除后整个会话会从列表消失，无法恢复。确认继续吗？',
      type: 'danger',
      confirmText: '删除',
      cancelText: '取消',
      onConfirm: runDelete,
      onCancel: () => {},
    });
  };

  const handleRestoreAllSearchResults = () => {
    if (matchingTabs.length === 0) {
      return;
    }

    const sessionCount = sessionResults.length;
    showConfirm({
      title: `${bulkActionTitle(isBrowseMode ? 'browse' : 'search', '恢复')}${matchingTabs.length} 个标签？`,
      // ── 2026-10-19 审计 F-4：文案必须等于真实行为 ──────────────────────
      // 原先这里写「未锁定的会话将从列表移除」，而实际执行的只是
      // consumeMatchedTabs —— 对**命中的标签**逐条 deleteTabAndSync。
      // 一个会话有 10 条标签、只中 1 条时，恢复后该会话仍在列表里（剩 9 条），
      // 而确认框与结果提示都说「会话从列表移除」：两处都在说一件没发生的事。
      //
      // 真实语义：会话内**只有命中的那些标签**被移除；某会话若因此被清空，
      // 它会随「删掉最后一条」一并消失（那是有条件的一句话说清，不是承诺）。
      message: `将在新窗口打开 ${sessionCount} 个会话中的 ${matchingTabs.length} 个标签；` +
        `命中的标签会从所属会话中移除，会话内其余标签保留。` +
        `（某会话若因此被清空，会一并从列表消失；删除不可恢复。）确认继续吗？`,
      type: 'info',
      confirmText: '全部恢复',
      cancelText: '取消',
      onConfirm: () => runRestoreAllSearchResults(),
      onCancel: () => {},
    });
  };

  const runRestoreAllSearchResults = () => {

    const tabsPayload = matchingTabs.map(({ tab }) => ({
      url: tab.url,
      pinned: !!tab.pinned,
    }));

    // 串行删除每枚 tab：deleteTabAndSync 内部处理"删到组空→自动整组删除"。
    // 旧版用 updateGroup(filter) 走 diff 通道，存在 UI 状态陈旧时误伤的风险（根因 R3）。
    // 只在 OPEN_TABS 回 success:true 后执行（先开后删，失败时记录原样保留）。
    //
    // ── 2026-10-22 审计 P0-4：消费是**批量**的，撤销也得能一次撤回来 ──────
    // 这里**如实**回报「真正被消费掉的是哪些」，而不是「本来打算消费哪些」：
    // 某条删除失败时那条标签还在列表里，撤销若按「打算消费的清单」还原，
    // 就会去动一条根本没被消费的标签（把用户后来加进去的东西顶掉）。
    //
    // 为什么改成 await：撤销的还原清单要等消费**落地**才定得了，而排队中的
    // 删除命令会把还原结果又删掉 —— 撤销必须排在消费之后（SW 的单写者队列
    // 保证同一条命令链上的顺序）。
    const consumeMatchedTabs = async (): Promise<Array<{ group: TabGroup; ref: ConsumedTabRef }>> => {
      const consumed: Array<{ group: TabGroup; ref: ConsumedTabRef }> = [];
      for (const { tab, group } of matchingTabs) {
        if (group.isLocked) continue;
        // 原下标必须在**消费前**取：消费之后这条标签已经不在列表里，
        // 下标就找不回来了（撤销要靠它把标签插回原来的位置）。
        const index = group.tabs.findIndex(t => t.id === tab.id);
        try {
          const res = await dispatch(deleteTabAndSync({ groupId: group.id, tabId: tab.id })).unwrap();
          const warn = deleteBroadcastWarn(res);
          if (warn) showDeleteError(warn);
          if (index >= 0) consumed.push({ group, ref: { tabId: tab.id, index } });
        } catch (error) {
          logError('批量恢复后删除会话失败:', error);
          showDeleteError(mutationErrorMessage('批量恢复后清理原会话', error));
        }
      }
      return consumed;
    };

    /**
     * 把「消费了哪些」整理成撤销凭据：**按会话分组**。
     *
     * 同一个会话里可能命中好几条 —— 它们共用一份「消费前的整组快照」，
     * 撤销时一次把这一会话里被消费掉的那几条原样插回（顺序也回到原样）。
     */
    const buildUndoSpecs = (
      consumed: Array<{ group: TabGroup; ref: ConsumedTabRef }>,
    ): ConsumeUndoSpec[] => {
      const byGroup = new Map<string, { group: TabGroup; refs: ConsumedTabRef[] }>();
      for (const { group, ref } of consumed) {
        const entry = byGroup.get(group.id);
        if (entry) entry.refs.push(ref);
        else byGroup.set(group.id, { group, refs: [ref] });
      }
      return [...byGroup.values()].map(({ group, refs }) => ({
        group,
        consumedTabs: refs,
      }));
    };

    chrome.runtime.sendMessage(
      {
        type: 'OPEN_TABS',
        data: { tabs: tabsPayload },
      },
      (res: unknown) => {
        const r = res as
          | { success?: boolean; skippedUnopenable?: number; error?: string }
          | undefined;
        // 批量恢复同样先开后删：没有 success:true 就没有证据证明标签打开了，
        // 一条记录都不消费（原实现是发送前就跨多个组删，失败时全丢）。
        if (!r || r.success !== true) {
          showDeleteError(
            `${toServiceWorkerErrorCopy(r?.error, '恢复失败')}。所涉记录仍保留在列表中。`
          );
          return;
        }
        // 消费是逐条派发删除命令的**异步**过程，所以成功提示等它落地再出 ——
        // 「已恢复 N 个标签，命中的标签已从所属会话移除」这句话，只有在
        // 那 N 条真的被移除之后才是真的（撤销的还原清单也才定得下来）。
        void (async () => {
          const consumed = await consumeMatchedTabs();
          const undoSpecs = buildUndoSpecs(consumed);
          if (typeof r.skippedUnopenable === 'number' && r.skippedUnopenable > 0) {
            // 同 F-4：只说真实发生的事 —— 移除的是**命中的标签**，不是整个会话。
            const removedNote = matchingTabs.some(t => !t.group.isLocked)
              ? '命中的标签已从所属会话移除，会话内其余标签保留。'
              : '所涉会话均已锁定，记录仍在列表中。';
            // 部分成功也是一次消费（能打开的那些已经被移出会话了）⇒
            // 这条提示上**同样**挂「撤销」，否则用户手里有一条没退路的消费。
            showConsumeToast(
              `已恢复 ${tabsPayload.length - r.skippedUnopenable} 个标签；另有 ` +
                `${r.skippedUnopenable} 个在当前设备无法打开（本地文件、临时链接或浏览器内部页面）。` +
                removedNote,
              undoSpecs.length > 0 ? undoSpecs : undefined,
              { type: 'error' },
            );
            return;
          }
          // 2026-10-18 C 组：全成功时原先**零反馈** —— 对话框关掉、窗口开了、
          // 列表少几行；命中标签分散在多个会话且每会话只中 1 条时，视觉上只是
          // 几行消失，用户无法确证「恢复了几个」。与列表页整组恢复同口径报条数。
          //
          // 2026-10-20 审计 A-1：措辞改用共享模块（restoreFeedbackCopy），
          // 列表页与搜索页引用同一份文案 —— 两处各写一遍迟早漂。
          //
          // 2026-10-22 审计 P0-4：挂上「撤销」—— 批量恢复一次可能从好几个
          // 会话里消费掉几十条记录，是本产品**一次吞掉最多记录**的动作，
          // 最需要一条退路。
          showConsumeToast(
            restoreAllSearchSuccessMessage(matchingTabs.length),
            undoSpecs.length > 0 ? undoSpecs : undefined,
          );
        })();
      }
    );
  };

  const handleDeleteAllSearchResults = async () => {
    if (matchingTabs.length === 0) {
      return;
    }

    try {
      for (const { tab, group } of matchingTabs) {
        if (group.isLocked) continue;
        const res = await dispatch(deleteTabAndSync({ groupId: group.id, tabId: tab.id })).unwrap();
        const warn = deleteBroadcastWarn(res);
        if (warn) showDeleteError(warn);
      }
    } catch (error) {
      logError('批量删除搜索结果失败:', error);
      showDeleteError('删除操作失败，请重试');
    }
  };

  const handleRequestDeleteAllSearchResults = () => {
    if (!confirmBeforeDelete) {
      void handleDeleteAllSearchResults();
      return;
    }

    showConfirm({
      title: `${bulkActionTitle(isBrowseMode ? 'browse' : 'search', '删除')}${matchingTabs.length} 个标签？`,
      message: `将从所属会话中永久移除这 ${matchingTabs.length} 条标签记录（锁定会话除外），删除后无法恢复。确认继续吗？`,
      type: 'danger',
      confirmText: '删除',
      cancelText: '取消',
      onConfirm: handleDeleteAllSearchResults,
      onCancel: () => {},
    });
  };

  const renderTabItem = ({ tab, group }: { tab: Tab; group: TabGroup }) => {
    // 「本设备打不开」按 **URL 现算**，不读 `tab.unopenable` 标记（理由见 DraggableTab：
    // 那个标记只有云端读取路径会盖章）。列表页会把这一行灰掉并划掉标题，搜索页此前
    // 不标 —— 同一个标签两个界面两种长相，搜索页那一行看起来是能点开的，点下去只会
    // 弹一句「此标签在当前设备无法打开」。现算后两处口径一致。
    const isUnopenable = !isOpenableTabUrl(tab.url);
    return (
    <div className={`tab-item group/tab${isUnopenable ? ' tab-item-unopenable' : ''}`}>
      {showFavicons && (
        <SafeFavicon src={tab.favicon} alt="" className="tab-item-favicon" />
      )}

      <div className="flex-1 min-w-0 flex items-center gap-3">
        <a
          href="#"
          className="tab-item-title tab-item-title-hover transition-colors flex items-center gap-1"
          onClick={event => {
            event.preventDefault();
            handleOpenTab(tab, group);
          }}
          title={tab.title}
          aria-label={isUnopenable ? `${tab.title}（此标签在当前设备无法打开，仍保留在会话中）` : undefined}
        >
          <HighlightText text={tab.title} highlight={searchQuery} />
          {tab.pinned && <PinIcon />}
        </a>
        {/* URL 显示形态统一走 @/utils/sessionPresentation（与列表页同一个函数，别再各写一份） */}
        <span className="tab-item-url hidden sm:block">{getDisplayUrl(tab.url)}</span>
      </div>

      {/* 锁定会话不渲染删除：锁定承诺「防误删」，而删除不可撤销（无回收站）。
          与批量删除按钮的文案「锁定会话除外」同一口径，只是这里直接不给落点。 */}
      {!group.isLocked && (
        <div className="tab-item-actions">
          <button
            onClick={() => handleDeleteTab(tab, group)}
            className="btn-icon p-1 tab-item-delete-btn flat-interaction"
            title="从会话中移除这条记录（无法恢复）"
            aria-label={`从会话中移除（无法恢复）: ${tab.title}`}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
    </div>
    );
  };

  /**
   * 结果区里的筛选区（工具条 + 面板）。
   *
   * 面板本体在 `SearchFilterPanel` 里 —— 与主列表**共用同一份**。
   * 状态只有一处（由列表层持有），这里是它的一个渲染点。
   */
  const FiltersPanel = ({ withOuterMargin }: { withOuterMargin?: boolean }) => (
    <SearchFilterSection
      controls={filterControls}
      title={resultViewTitle(isBrowseMode ? 'browse' : 'search')}
      // browse 形态下不显示标题：卡片头已经写着「符合条件的会话」，
      // 筛选区再写一遍「按条件筛选会话」是同一句话在同一屏里出现两次。
      // 判据与形态判定同源，见 searchBrowseMode.showFilterSectionTitle。
      showTitle={showFilterSectionTitle(isBrowseMode ? 'browse' : 'search')}
      collectPinnedTabs={collectPinnedTabs}
      variant={withOuterMargin ? 'inset' : 'flush'}
    />
  );

  if (sessionResults.length === 0) {
    return (
      <div>
        {/* ── 2026-10-20 键盘可达性：空结果也必须播报 ──────────────────────
            空结果与有结果走的是**两个不同的渲染分支**（这里 return 的是
            EmptyState，上面那个分支 return 的是结果卡）⇒ 有结果时的 live
            region 在空结果时**根本不在 DOM 里**。
            若只在有结果的分支放 live region，「搜了个不存在的词」这件事
            就彻底静默 —— 而这恰恰是最需要反馈的时刻（用户会以为搜索坏了）。
            所以两个分支各放一个常驻的 polite live region。 */}
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
        >
          {hasNoCriteria
            ? noCriteriaEmptyTitle
            : isBrowseMode
              ? browseEmptyTitle
              : `没有找到与“${searchQuery}”相关的会话或标签`}
        </div>
        <FiltersPanel />
        <EmptyState
          tone="search"
          icon={
            <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 empty-state-default-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          }
          title={
            hasNoCriteria
              ? noCriteriaEmptyTitle
              : isBrowseMode
                ? browseEmptyTitle
                : '没有找到可找回的会话'
          }
          description={
            hasNoCriteria
              ? noCriteriaEmptyDescription
              : isBrowseMode
                ? browseEmptyDescription
                : `没有找到与“${searchQuery}”相关的会话或标签，请尝试其他关键词。`
          }
          action={
            <div className="text-xs theme-text-muted space-y-3">
              {activeFilterCount > 0 && (
                <button
                  onClick={clearFilters}
                  className="theme-radius-control theme-btn-hover border theme-border-default px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors dark:text-gray-300"
                >
                  清空筛选后重试
                </button>
              )}
              {/* ── 2026-10-22 审计 L-1：提示从「三条 bullet」压成「一条」──
                  这个 action 块原本塞着一个小标题 + 三条 list-item，
                  在「搜不到」这个**用户已经挫败**的时刻占据整屏高度，
                  却给不了一个可点的动作。压成一条：
                    · 高度从 ~90px 降到 ~30px，空态不再喧宾夺主；
                    · 固定标签筛选器默认隐藏（见上方 collectPinnedTabs 注释），
                      提示文案仍不能无条件承诺一个用户看不到的筛选项 ——
                      所以那句仍然是**条件渲染**的（tests/pinnedFilterAvailability
                      守的就是这一条）。 */}
              <ul className="list-disc list-inside space-y-0.5 text-left">
                <li>{searchEmptyHint(collectPinnedTabs)}</li>
              </ul>
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div
      className="tab-group-card animate-in group/card"
      role="region"
      aria-label={resultRegionLabel(
        isBrowseMode ? 'browse' : 'search',
        sessionResults.length,
        matchingTabs.length
      )}
    >
      {/* ── 2026-10-20 键盘可达性：结果数量变化必须被读屏播报 ──────────────
          修复前：容器只有 `role="region"` + 一句 `aria-label`，**没有 aria-live**；
          整个文档的 [aria-live] 元素数 = 0。而搜索时焦点留在输入框里 ⇒
          读屏用户在输入关键词后**听不到任何结果反馈**（「搜到了几个？」
          永远得不到回答），空结果态同样不播报。

          为什么不能只靠 aria-label 承载动态计数：`aria-label` 描述的是**这个
          区域是什么**，不是「区域内容变了」的通知。区域内容变化要靠 live
          region 播报。对照：TabList 的加载态与 Toast 都正确用了 aria-live
          ⇒ 这是遗漏，不是全局约定缺失。

          做法：常驻一个 polite live region（**不能**用 {cond && <div>…} 的
          挂载式写法 —— 区域和文案同一帧插入的话多数读屏不会播报），
          内容是「共 N 个匹配会话、M 个匹配标签」。aria-atomic 让整句被重读。

          计数不放 aria-label 是刻意的：aria-label 保留给「这是搜索结果区」，
          动态计数交给 live region —— 两件事、两个机制。 */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {isBrowseMode
          ? browseSummaryCopy(sessionResults.length, matchingTabs.length)
          : searchSummaryCopy(sessionResults.length, matchingTabs.length)}
      </div>
      <div className="tab-group-header gap-2">
        <div className="flex items-center gap-2 sm:gap-3 flex-1 min-w-0">
          <div className="p-1 -ml-1">
            <svg className="w-4 h-4 theme-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>

          <h3 className="tab-group-title truncate">
            {resultCardTitle(isBrowseMode ? 'browse' : 'search')}
          </h3>

          {/* ── 2026-10-20 审计 A-13：徽章显示的是**标签数**，不是会话数 ──
              修复前显示 sessionResults.length（会话数）：搜 "React" 命中 1 个会话里的
              2 个标签 ⇒ 徽章显示「1」，而结果区里列了 2 行标签。用户会以为只有
              1 条结果。改成标签数，并让会话数与标签数都能读到。
              showTabCount 关掉时不渲染这枚徽章（2026-10-20 审计 A-9：让开关
              真的生效；title 里仍保留「N 个会话 · M 个标签」的完整信息）。 */}
          {showTabCount && (
            <span
              className="tab-group-count flex-shrink-0"
              title={`${sessionResults.length} 个会话 · ${matchingTabs.length} 个标签`}
            >
              {matchingTabs.length}
            </span>
          )}
        </div>

        {matchingTabs.length > 0 && (
          // group-focus-within/card：只有 group-hover 时，纯键盘用户 Tab 到这两个
          // 「恢复全部 / 删除全部」按钮时它们仍是透明的——其中删除全部是不可撤销的批量操作。
          // 触屏无 hover，窄屏常驻显示。
          <div className="flex items-center gap-0.5 sm:gap-1 opacity-100 md:opacity-0 md:group-hover/card:opacity-100 group-focus-within/card:opacity-100 md:group-focus-within/card:opacity-100 transition-opacity duration-150 flex-shrink-0">
            <button
              onClick={handleRestoreAllSearchResults}
              className="btn-icon p-1.5 tab-group-action-accent flat-interaction"
              title="在新窗口恢复所有匹配标签"
              aria-label={`在新窗口恢复所有匹配标签，共 ${matchingTabs.length} 个标签页`}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
              </svg>
            </button>

            <button
              onClick={handleRequestDeleteAllSearchResults}
              className="btn-icon p-1.5 tab-group-action-danger flat-interaction"
              title="删除所有搜索到的标签页"
              aria-label={`删除所有搜索到的标签页，共 ${matchingTabs.length} 个`}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
              </svg>
            </button>
          </div>
        )}
      </div>

      <FiltersPanel withOuterMargin />

      <div className="space-y-3 px-2 pb-2">
        {visibleSessionResults.map((session: SessionSearchResult) => (
          <div
            key={session.group.id}
            className="theme-radius-card theme-border-default theme-bg-elevated border p-3"
            style={{ contentVisibility: 'auto', containIntrinsicSize: '240px' }}
          >
            <div className="flex flex-col gap-2 sm:gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                    {session.group.name}
                  </h4>
                  {/* 锁标记：搜索结果里没有逐条删除按钮（锁定会话），必须给用户
                      一个可见的解释，否则「少了一个 X」看起来像渲染残缺。
                      与 TabGroup 卡片头部同一图标、同一 class、同一份 aria。 */}
                  {session.group.isLocked && (
                    <span
                      className="tab-group-lock-icon flex-shrink-0"
                      title="会话已锁定，不会逐条移除其中的标签"
                      aria-label="会话已锁定"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                      </svg>
                    </span>
                  )}
                </div>
                {/* 命中数已并入摘要行（匹配 n/m 个标签），不再单列徽章 */}
                <p className="mt-1 text-xs theme-text-muted">
                  {getSessionResultSummary(session.group, session.matches.length)}
                </p>
              </div>

              <button
                onClick={() => restoreSession(session.group)}
                className="theme-accent-outline theme-radius-control self-start border px-3 py-1.5 text-xs font-medium transition-colors"
              >
                恢复整个会话
              </button>
            </div>

            <div className="mt-3 space-y-1 border-t border-gray-100 dark:border-gray-800 pt-3">
              {session.matches.map(result => (
                <React.Fragment key={`${result.group.id}-${result.tab.id}`}>
                  {renderTabItem({ tab: result.tab, group: result.group })}
                </React.Fragment>
              ))}
            </div>
          </div>
        ))}

        {/* ── 2026-10-20 审计 A-11：截断必须说清「还有多少、为什么」─────────
            截断了不说 = 用户以为「只找到这么多条」（与 2026-10-19 审计 F-5
            「重复导入被误报成备份文件坏了」是同一类：真实原因不告诉用户，
            用户据此做出错误判断）。 */}
        {resultWindow.truncated && (
          <div
            role="status"
            className="theme-well theme-radius-control px-3 py-2.5 text-xs theme-text-secondary"
          >
            {isBrowseMode
              ? browseTruncationMessage(resultWindow.hidden)
              : resultTruncationMessage(resultWindow.hidden)}
          </div>
        )}
      </div>
    </div>
  );
};

export default SearchResultList;
