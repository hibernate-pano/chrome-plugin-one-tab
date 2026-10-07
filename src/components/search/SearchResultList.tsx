import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { Tab, TabGroup } from '@/types/tab';
import { deleteGroup, deleteTabAndSync, markTabOpened } from '@/store/slices/tabSlice';
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

  const restoreSession = (group: TabGroup) => {
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

    if (!group.isLocked) {
      // ponytail: 去掉 fake dispatch，依赖真实 thunk fulfilled 触发 reducer + middleware
      dispatch(deleteGroup(group.id))
        .unwrap()
        .catch(error => {
          logError('恢复会话后清理原会话失败:', error);
          showDeleteError(`恢复会话后清理原会话失败: ${error.message || '未知错误'}`);
        });
    }

    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'OPEN_TABS',
        data: { tabs: tabsPayload },
      });
    }, 100);
  };

  const handleOpenTab = (tab: Tab, group: TabGroup) => {
    // 【2026-10-07 P1-2】与 TabGroup.handleOpenTab 同一处修正：原先这里也会
    // 顺手删掉本地记录（「点开即从会话删除」）。两处必须同口径，否则用户在
    // 列表里点开不删、搜出来点开却删 —— 同一个产品在两个界面两种行为。
    // 现在点开只标记 openedAt，消费改为行内的显式「移除」。
    if (!group.isLocked) {
      dispatch(markTabOpened({ groupId: group.id, tabId: tab.id }));
    }

    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'OPEN_TAB',
        data: { url: tab.url, pinned: !!tab.pinned },
      })
        // 2026-10-07 P1-2 附带：原先 sendMessage 的失败无人处理 → SW 被回收 /
        // 扩展重载时用户点了没反应且无任何提示。与「无感 → 无声」同罪。
        .catch(error => {
          logError('打开标签失败:', error);
          showRestoreError(`打开失败：${error?.message || '未知错误'}`);
        });
    }, 50);
  };

  const handleDeleteTab = (tab: Tab, group: TabGroup) => {
    dispatch(deleteTabAndSync({ groupId: group.id, tabId: tab.id }))
      .unwrap()
      .catch(error => {
        showDeleteError(`更新会话失败: ${error.message || '未知错误'}`);
      });
  };

  const handleRestoreAllSearchResults = () => {
    if (matchingTabs.length === 0) {
      return;
    }

    const tabsPayload = matchingTabs.map(({ tab }) => ({
      url: tab.url,
      pinned: !!tab.pinned,
    }));

    // 串行删除每枚 tab：deleteTabAndSync 内部处理"删到组空→自动整组删除"。
    // 旧版用 updateGroup(filter) 走 diff 通道，存在 UI 状态陈旧时误伤的风险（根因 R3）。
    void (async () => {
      for (const { tab, group } of matchingTabs) {
        if (group.isLocked) continue;
        try {
          await dispatch(deleteTabAndSync({ groupId: group.id, tabId: tab.id })).unwrap();
        } catch (error) {
          logError('批量恢复后删除会话失败:', error);
          showDeleteError(`批量恢复后清理原会话失败: ${(error as { message?: string })?.message || '未知错误'}`);
        }
      }
    })();

    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'OPEN_TABS',
        data: { tabs: tabsPayload },
      });
    }, 100);
  };

  const handleDeleteAllSearchResults = async () => {
    if (matchingTabs.length === 0) {
      return;
    }

    try {
      for (const { tab, group } of matchingTabs) {
        if (group.isLocked) continue;
        await dispatch(deleteTabAndSync({ groupId: group.id, tabId: tab.id })).unwrap();
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
      title: '删除确认',
      message: `确定要删除所有搜索结果中的 ${matchingTabs.length} 个标签页吗？此操作不可撤销。`,
      type: 'danger',
      confirmText: '删除',
      cancelText: '取消',
      onConfirm: handleDeleteAllSearchResults,
      onCancel: () => {},
    });
  };

  const renderTabItem = ({ tab, group }: { tab: Tab; group: TabGroup }) => (
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

      <div className="tab-item-actions">
        <button
          onClick={() => handleDeleteTab(tab, group)}
          className="btn-icon p-1 tab-item-delete-btn flat-interaction"
          title="删除标签页"
          aria-label={`删除标签页: ${tab.title}`}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );

  const FiltersPanel = ({ withOuterMargin }: { withOuterMargin?: boolean }) => (
    <>
      <div className="flex items-center justify-between mb-2 px-2">
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
        <div className={`theme-well theme-radius-control p-3 mb-3 ${withOuterMargin ? 'mx-2' : ''}`}>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
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
                  <li>支持搜索会话名称、备注、标签标题或 URL</li>
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
    <div className="tab-group-card animate-in group/card">
      <div className="tab-group-header">
        <div className="flex items-center gap-3 flex-1 min-w-0">
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
          <div className="flex items-center gap-1 opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100 transition-opacity duration-150">
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
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                    {session.group.name}
                  </h4>
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
