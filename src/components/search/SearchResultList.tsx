import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { Tab, TabGroup } from '@/types/tab';
import { deleteGroup, deleteTabAndSync, deleteBroadcastWarn } from '@/store/slices/tabSlice';
import { isOpenableTabUrl } from '@/utils/inputValidation';
import { OpenGuard, OpenAllGuard } from '@/utils/openGuard';
import { useToast } from '@/contexts/ToastContext';
import { useEnhancedToast } from '@/utils/toastHelper';
import { trackProductEvent } from '@/utils/productEvents';
import {
  AdvancedSearch,
  SearchFilters,
  SessionSearchResult,
  applySearchFilters,
  buildSessionSearchResults,
} from '@/utils/search';
import {
  SEARCH_EVENT_THROTTLE_MS,
  SearchEventSnapshot,
  buildSearchEventSignature,
  remainingMsUntilAllowed,
  searchEventNames,
  shouldEmitSearchEvents,
} from './searchAnalytics';
import HighlightText from './HighlightText';
import { SafeFavicon } from '@/components/common/SafeFavicon';
import { EmptyState } from '@/components/common/EmptyState';
import { getSessionResultSummary } from '@/utils/sessionPresentation';
import { logError } from '../../utils/log';

const PinIcon = () => (
  <svg className="w-3 h-3 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
  </svg>
);

/** 筛选控件的 id 前缀：同一时刻只有一个搜索结果面板，固定前缀即可保证 label 唯一。 */
const FILTER_IDS = {
  pinned: 'search-filter-pinned',
  domain: 'search-filter-domain',
  groupName: 'search-filter-group-name',
  savedWithin: 'search-filter-saved-within',
} as const;

interface SearchResultListProps {
  searchQuery: string;
}

export const SearchResultList: React.FC<SearchResultListProps> = ({ searchQuery }) => {
  const dispatch = useAppDispatch();
  const { groups } = useAppSelector(state => state.tabs);
  const confirmBeforeDelete = useAppSelector(state => state.settings.confirmBeforeDelete);
  const { showConfirm } = useToast();
  const { showDeleteError, showRestoreError } = useEnhancedToast();
  const [filters, setFilters] = useState<SearchFilters>({});
  const [showFilters, setShowFilters] = useState(false);
  const [isFilterPending, startFilterTransition] = useTransition();
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const normalizedSearchQuery = deferredSearchQuery.trim();

  // 搜索管线（全文检索 → 筛选 → 按会话归组）是本组件最重的计算。
  // 此前每次渲染都全量重跑，包括用户每敲一个字符的中间态；
  // 用 useMemo 把重算收敛到「groups / 查询词 / 筛选条件真正变化」时才发生。
  const baseResults = useMemo(
    () =>
      normalizedSearchQuery
        ? AdvancedSearch.search(groups, {
            query: normalizedSearchQuery,
            searchPinned: true,
          })
        : [],
    [groups, normalizedSearchQuery]
  );
  const searchResults = useMemo(() => applySearchFilters(baseResults, filters), [baseResults, filters]);
  const sessionResults = useMemo(() => buildSessionSearchResults(searchResults), [searchResults]);
  const matchingTabs = useMemo(
    () => sessionResults.flatMap(session => session.matches),
    [sessionResults]
  );
  const activeFilterCount = useMemo(
    () =>
      [
        !!filters.domain?.trim(),
        !!filters.groupName?.trim(),
        !!filters.savedWithin,
        filters.pinned === 'only' || filters.pinned === 'exclude',
      ].filter(Boolean).length,
    [filters.domain, filters.groupName, filters.savedWithin, filters.pinned]
  );

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
      domain: filters.domain || null,
      groupName: filters.groupName || null,
      pinned: filters.pinned || 'all',
      savedWithin: filters.savedWithin || null,
      resultCount: searchResults.length,
    };
    latestSnapshotRef.current = snapshot;

    if (!snapshot.query) return;

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
      if (!latest.query) return;
      if (buildSearchEventSignature(latest) === analyticsStateRef.current.lastSignature) return;
      emitSearchEvents(latest);
    }, wait);
  }, [emitSearchEvents, filters, normalizedSearchQuery, searchResults.length]);

  useEffect(
    () => () => {
      if (trailingTimerRef.current) clearTimeout(trailingTimerRef.current);
    },
    []
  );

  const updateFilters = useCallback((updater: (current: SearchFilters) => SearchFilters) => {
    startFilterTransition(() => {
      setFilters(current => updater(current));
    });
  }, []);

  const clearFilters = useCallback(() => {
    startFilterTransition(() => {
      setFilters({});
    });
  }, []);

  const getDisplayUrl = useCallback((url: string) => {
    try {
      return new URL(url).hostname.replace('www.', '');
    } catch {
      return url;
    }
  }, []);

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
          showDeleteError(`恢复会话后清理原会话失败: ${error.message || '未知错误'}`);
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
          showDeleteError(`${r?.error || '恢复会话失败'}。原会话仍保留在列表中。`);
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
        }
      }
    );
  };

  const handleOpenTab = (tab: Tab, group: TabGroup) => {
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
      chrome.runtime.sendMessage({
        type: 'OPEN_TAB',
        data: { url: tab.url, pinned: !!tab.pinned },
      }).catch(error => {
        logError('打开标签失败:', error);
        showRestoreError(`打开失败：${error?.message || '未知错误'}`);
      });
      return;
    }
    if (!isOpenableTabUrl(tab.url)) {
      releaseOnFailure();
      showRestoreError('此标签在当前设备无法打开，已保留在会话中');
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
          showRestoreError(r?.error || '打开失败，已保留在会话中');
          return;
        }
        dispatch(deleteTabAndSync({ groupId: group.id, tabId: tab.id }))
          .unwrap()
          .then(payload => {
            const warn = deleteBroadcastWarn(payload);
            if (warn) showDeleteError(warn);
          })
          .catch(error => {
            logError('打开后从会话移除失败:', error);
            showDeleteError(`标签已打开，但从会话移除失败: ${error.message || '未知错误'}`);
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
    dispatch(deleteTabAndSync({ groupId: group.id, tabId: tab.id }))
      .unwrap()
      .then(payload => {
        // 删掉组内最后一个标签会变成「整组物理移除」，广播登记失败同样要 surface。
        const warn = deleteBroadcastWarn(payload);
        if (warn) showDeleteError(warn);
      })
      .catch(error => {
        showDeleteError(`更新会话失败: ${error.message || '未知错误'}`);
      });
  };

  const handleRestoreAllSearchResults = () => {
    if (matchingTabs.length === 0) {
      return;
    }

    const sessionCount = sessionResults.length;
    showConfirm({
      title: `恢复搜索结果中的 ${matchingTabs.length} 个标签？`,
      message: `将在新窗口打开 ${sessionCount} 个会话中的 ${matchingTabs.length} 个标签；未锁定的会话将从列表移除（恢复即消费原会话，无回收站）。确认继续吗？`,
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
    const consumeMatchedTabs = () => {
      void (async () => {
        for (const { tab, group } of matchingTabs) {
          if (group.isLocked) continue;
          try {
            const res = await dispatch(deleteTabAndSync({ groupId: group.id, tabId: tab.id })).unwrap();
            const warn = deleteBroadcastWarn(res);
            if (warn) showDeleteError(warn);
          } catch (error) {
            logError('批量恢复后删除会话失败:', error);
            showDeleteError(`批量恢复后清理原会话失败: ${(error as { message?: string })?.message || '未知错误'}`);
          }
        }
      })();
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
          showDeleteError(`${r?.error || '恢复失败'}。所涉记录仍保留在列表中。`);
          return;
        }
        consumeMatchedTabs();
        if (typeof r.skippedUnopenable === 'number' && r.skippedUnopenable > 0) {
          // 批量会话里锁定态可能混杂，按「是否真的删了记录」分流：
          const removedNote = matchingTabs.some(t => !t.group.isLocked)
            ? '未锁定的会话已从列表移除（恢复即消费原会话，无回收站）。'
            : '所涉会话均已锁定，记录仍在列表中。';
          showDeleteError(
            `已恢复 ${tabsPayload.length - r.skippedUnopenable} 个标签；另有 ` +
              `${r.skippedUnopenable} 个在当前设备无法打开（本地文件、临时链接或浏览器内部页面）。` +
              removedNote
          );
        }
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
      title: `删除搜索结果中的 ${matchingTabs.length} 个标签？`,
      message: `将从所属会话中永久移除这 ${matchingTabs.length} 条标签记录（锁定会话除外），删除后无法恢复。确认继续吗？`,
      type: 'danger',
      confirmText: '删除',
      cancelText: '取消',
      onConfirm: handleDeleteAllSearchResults,
      onCancel: () => {},
    });
  };

  const renderTabItem = ({ tab, group }: { tab: Tab; group: TabGroup }) => {
    return (
    <div className="tab-item group/tab">
      <SafeFavicon src={tab.favicon} alt="" className="tab-item-favicon" />

      <div className="flex-1 min-w-0 flex items-center gap-3">
        <a
          href="#"
          className="tab-item-title tab-item-title-hover transition-colors flex items-center gap-1"
          onClick={event => {
            event.preventDefault();
            handleOpenTab(tab, group);
          }}
          title={tab.title}
        >
          <HighlightText text={tab.title} highlight={searchQuery} />
          {tab.pinned && <PinIcon />}
        </a>
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

  const FiltersPanel = ({ withOuterMargin }: { withOuterMargin?: boolean }) => (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2 px-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">会话搜索结果</h3>
          {activeFilterCount > 0 && (
            <span className="theme-accent-soft theme-accent-text rounded-full px-2 py-0.5 text-[11px] font-medium">
              {activeFilterCount} 个筛选
            </span>
          )}
          {isFilterPending && (
            <span className="text-[11px] text-gray-500 dark:text-gray-400">更新结果中...</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {activeFilterCount > 0 && (
            <button
              onClick={clearFilters}
              className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 flat-interaction"
            >
              清空筛选
            </button>
          )}
          <button
            onClick={() => setShowFilters(!showFilters)}
            className="text-xs text-primary-600 dark:text-primary-400 hover:underline flex items-center flat-interaction"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.207A1 1 0 013 6.5V4z" />
            </svg>
            {showFilters ? '隐藏筛选' : '显示筛选'}
          </button>
        </div>
      </div>

      {showFilters && (
        <div className={`theme-well theme-radius-control p-3 sm:p-4 mb-3 ${withOuterMargin ? 'mx-2' : ''}`}>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
            <div>
              <label
                htmlFor={FILTER_IDS.pinned}
                className="block text-xs text-gray-600 dark:text-gray-300 mb-1"
              >
                固定标签页
              </label>
              <select
                id={FILTER_IDS.pinned}
                value={filters.pinned || 'all'}
                onChange={event => {
                  const nextPinned = event.target.value as SearchFilters['pinned'];
                  updateFilters(current => ({
                    ...current,
                    pinned: nextPinned === 'all' ? undefined : nextPinned,
                  }));
                }}
                className="w-full text-sm border theme-border-default theme-radius-input-sm theme-focus theme-bg-elevated px-2 py-1 text-gray-900 dark:text-gray-100"
              >
                <option value="all">全部</option>
                <option value="only">仅固定</option>
                <option value="exclude">排除固定</option>
              </select>
            </div>

            <div>
              <label
                htmlFor={FILTER_IDS.domain}
                className="block text-xs text-gray-600 dark:text-gray-300 mb-1"
              >
                域名
              </label>
              <input
                id={FILTER_IDS.domain}
                type="text"
                placeholder="输入域名..."
                value={filters.domain || ''}
                onChange={event => {
                  const nextDomain = event.target.value;
                  updateFilters(current => ({
                    ...current,
                    domain: nextDomain || undefined,
                  }));
                }}
                className="w-full text-sm border theme-border-default theme-radius-input-sm theme-focus theme-bg-elevated px-2 py-1 text-gray-900 dark:text-gray-100"
              />
            </div>

            <div>
              <label
                htmlFor={FILTER_IDS.groupName}
                className="block text-xs text-gray-600 dark:text-gray-300 mb-1"
              >
                会话名称
              </label>
              <input
                id={FILTER_IDS.groupName}
                type="text"
                placeholder="输入会话名称..."
                value={filters.groupName || ''}
                onChange={event => {
                  const nextGroupName = event.target.value;
                  updateFilters(current => ({
                    ...current,
                    groupName: nextGroupName || undefined,
                  }));
                }}
                className="w-full text-sm border theme-border-default theme-radius-input-sm theme-focus theme-bg-elevated px-2 py-1 text-gray-900 dark:text-gray-100"
              />
            </div>

            <div>
              <label
                htmlFor={FILTER_IDS.savedWithin}
                className="block text-xs text-gray-600 dark:text-gray-300 mb-1"
              >
                保存时间
              </label>
              <select
                id={FILTER_IDS.savedWithin}
                value={filters.savedWithin || ''}
                onChange={event => {
                  const nextValue = event.target.value as SearchFilters['savedWithin'] | '';
                  updateFilters(current => ({
                    ...current,
                    savedWithin: nextValue || undefined,
                  }));
                }}
                className="w-full text-sm border theme-border-default theme-radius-input-sm theme-focus theme-bg-elevated px-2 py-1 text-gray-900 dark:text-gray-100"
              >
                <option value="">全部</option>
                <option value="24h">24 小时内</option>
                <option value="7d">7 天内</option>
                <option value="30d">30 天内</option>
                <option value="older">30 天前</option>
              </select>
            </div>
          </div>
        </div>
      )}
    </>
  );

  if (sessionResults.length === 0) {
    return (
      <div>
        <FiltersPanel />
        <EmptyState
          tone="search"
          icon={
            <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 empty-state-default-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          }
          title="没有找到可找回的会话"
          description={`没有找到与“${searchQuery}”相关的会话或标签，请尝试其他关键词。`}
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
              <div className="space-y-1">
                <div>小提示：</div>
                <ul className="list-disc list-inside space-y-0.5 text-left">
                  <li>支持搜索会话名称、标签标题或 URL</li>
                  <li>可结合域名、保存时间和固定标签筛选</li>
                  <li>如果刚换设备，可先登录后手动同步一次</li>
                </ul>
              </div>
            </div>
          }
          className="h-40"
        />
      </div>
    );
  }

  return (
    <div
      className="tab-group-card animate-in group/card"
      role="region"
      aria-label={`搜索结果，共 ${sessionResults.length} 个匹配会话`}
    >
      <div className="tab-group-header gap-2">
        <div className="flex items-center gap-2 sm:gap-3 flex-1 min-w-0">
          <div className="p-1 -ml-1">
            <svg className="w-4 h-4 theme-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>

          <h3 className="tab-group-title truncate">匹配会话</h3>

          <span className="tab-group-count flex-shrink-0">{sessionResults.length}</span>
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
        {sessionResults.map((session: SessionSearchResult) => (
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
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
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
      </div>
    </div>
  );
};

export default SearchResultList;
