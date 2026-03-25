import React, { useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { Tab, TabGroup } from '@/types/tab';
import { deleteGroup, recordRecentRestore, updateGroup } from '@/store/slices/tabSlice';
import { shouldAutoDeleteAfterMultipleTabRemoval, shouldAutoDeleteAfterTabRemoval } from '@/utils/tabGroupUtils';
import { useToast } from '@/contexts/ToastContext';
import { useEnhancedToast } from '@/utils/toastHelper';
import { trackProductEvent } from '@/utils/productEvents';
import {
  AdvancedSearch,
  SearchFilters,
  SearchResult,
  SessionSearchResult,
  applySearchFilters,
  buildSessionSearchResults,
} from '@/utils/search';
import HighlightText from './HighlightText';
import { SafeFavicon } from '@/components/common/SafeFavicon';
import { EmptyState } from '@/components/common/EmptyState';
import { buildRecentRestoreEntry, buildSessionRestoreMessage, getSessionResultSummary } from '@/utils/sessionPresentation';

const PinIcon = () => (
  <svg className="w-3 h-3 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
  </svg>
);

interface SearchResultListProps {
  searchQuery: string;
}

export const SearchResultList: React.FC<SearchResultListProps> = ({ searchQuery }) => {
  const dispatch = useAppDispatch();
  const { groups } = useAppSelector(state => state.tabs);
  const { showConfirm, showToast } = useToast();
  const { showDeleteSuccess, showDeleteError, showRestoreSuccess, showRestoreError } = useEnhancedToast();
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [filters, setFilters] = useState<SearchFilters>({});
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    if (!searchQuery) {
      setSearchResults([]);
      return;
    }

    const baseResults = AdvancedSearch.search(groups, {
      query: searchQuery,
      searchPinned: true,
    });

    const filteredResults = applySearchFilters(baseResults, filters);
    setSearchResults(filteredResults);
    void trackProductEvent('search_performed', {
      query: searchQuery,
      resultCount: filteredResults.length,
      hasDomainFilter: !!filters.domain,
      hasSavedWithinFilter: !!filters.savedWithin,
    });

    if (filters.domain || filters.groupName || filters.pinned !== undefined || filters.savedWithin) {
      void trackProductEvent('search_filtered', {
        query: searchQuery,
        domain: filters.domain || null,
        groupName: filters.groupName || null,
        pinned: filters.pinned || 'all',
        savedWithin: filters.savedWithin || null,
        resultCount: filteredResults.length,
      });
    }
  }, [filters, groups, searchQuery]);

  const sessionResults = buildSessionSearchResults(searchResults);
  const matchingTabs = sessionResults.flatMap(session => session.matches);

  const getDisplayUrl = (url: string) => {
    try {
      return new URL(url).hostname.replace('www.', '');
    } catch {
      return url;
    }
  };

  const restoreSession = (group: TabGroup) => {
    const tabsPayload = group.tabs.map(tab => ({
      url: tab.url,
      pinned: !!tab.pinned,
    }));

    dispatch(recordRecentRestore(buildRecentRestoreEntry(group, 'search')));
    void trackProductEvent('session_restored', {
      sessionId: group.id,
      sessionName: group.name,
      source: 'search',
      tabCount: group.tabs.length,
    });

    if (!group.isLocked) {
      dispatch({ type: 'tabs/deleteGroup/fulfilled', payload: group.id });
      dispatch(deleteGroup(group.id))
        .unwrap()
        .catch(error => {
          console.error('恢复会话后清理原会话失败:', error);
          showDeleteError(`恢复会话后清理原会话失败: ${error.message || '未知错误'}`);
        });
    }

    showToast(buildSessionRestoreMessage(group), 'success', 4500);

    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'OPEN_TABS',
        data: { tabs: tabsPayload },
      });
    }, 100);
  };

  const handleOpenTab = (tab: Tab, group: TabGroup) => {
    if (!group.isLocked) {
      if (shouldAutoDeleteAfterTabRemoval(group, tab.id)) {
        dispatch({ type: 'tabs/deleteGroup/fulfilled', payload: group.id });
        dispatch(deleteGroup(group.id))
          .unwrap()
          .then(() => {
            showDeleteSuccess(`已恢复标签页并自动删除空会话 "${group.name}"`);
          })
          .catch(error => {
            console.error('删除会话失败:', error);
            showDeleteError(`删除会话失败: ${error.message || '未知错误'}`);
          });
      } else {
        const updatedTabs = group.tabs.filter(item => item.id !== tab.id);
        const updatedGroup = {
          ...group,
          tabs: updatedTabs,
          updatedAt: new Date().toISOString(),
        };

        dispatch({ type: 'tabs/updateGroup/fulfilled', payload: updatedGroup });
        dispatch(updateGroup(updatedGroup))
          .unwrap()
          .then(() => {
            showRestoreSuccess(1);
          })
          .catch(error => {
            console.error('更新会话失败:', error);
            showRestoreError(`更新会话失败: ${error.message || '未知错误'}`);
          });
      }
    } else {
      showRestoreSuccess(1);
    }

    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'OPEN_TAB',
        data: { url: tab.url, pinned: !!tab.pinned },
      });
    }, 50);
  };

  const handleDeleteTab = (tab: Tab, group: TabGroup) => {
    if (shouldAutoDeleteAfterTabRemoval(group, tab.id)) {
      dispatch(deleteGroup(group.id))
        .unwrap()
        .then(() => {
          showDeleteSuccess(`已删除会话 "${group.name}"（最后一个标签页已删除）`);
        })
        .catch(error => {
          showDeleteError(`删除会话失败: ${error.message || '未知错误'}`);
        });
      return;
    }

    const updatedTabs = group.tabs.filter(item => item.id !== tab.id);
    const updatedGroup = {
      ...group,
      tabs: updatedTabs,
      updatedAt: new Date().toISOString(),
    };

    dispatch(updateGroup(updatedGroup))
      .unwrap()
      .then(() => {
        showDeleteSuccess(`已从 "${group.name}" 删除标签页 (剩余 ${updatedTabs.length} 个)`);
      })
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

    const groupsToUpdate = matchingTabs.reduce((accumulator, { tab, group }) => {
      if (group.isLocked) {
        return accumulator;
      }

      if (!accumulator[group.id]) {
        accumulator[group.id] = { group, tabsToRemove: [] };
      }

      accumulator[group.id].tabsToRemove.push(tab.id);
      return accumulator;
    }, {} as Record<string, { group: TabGroup; tabsToRemove: string[] }>);

    Object.values(groupsToUpdate).forEach(({ group, tabsToRemove }) => {
      if (tabsToRemove.length === group.tabs.length) {
        dispatch({ type: 'tabs/deleteGroup/fulfilled', payload: group.id });
        return;
      }

      dispatch({
        type: 'tabs/updateGroup/fulfilled',
        payload: {
          ...group,
          tabs: group.tabs.filter(tab => !tabsToRemove.includes(tab.id)),
          updatedAt: new Date().toISOString(),
        },
      });
    });

    setTimeout(() => {
      Object.values(groupsToUpdate).forEach(({ group, tabsToRemove }) => {
        if (tabsToRemove.length === group.tabs.length) {
          dispatch(deleteGroup(group.id))
            .unwrap()
            .catch(error => {
              console.error('批量恢复后删除会话失败:', error);
              showDeleteError(`批量恢复后删除会话失败: ${error.message || '未知错误'}`);
            });
          return;
        }

        const updatedTabs = group.tabs.filter(tab => !tabsToRemove.includes(tab.id));
        dispatch(updateGroup({
          ...group,
          tabs: updatedTabs,
          updatedAt: new Date().toISOString(),
        })).unwrap().catch(error => {
          console.error('批量恢复后更新会话失败:', error);
          showRestoreError(`批量恢复后更新会话失败: ${error.message || '未知错误'}`);
        });
      });

      showToast(`已在新窗口恢复 ${matchingTabs.length} 个匹配标签，涉及 ${sessionResults.length} 个会话`, 'success', 4500);

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

    const groupsToUpdate = matchingTabs.reduce((accumulator, { tab, group }) => {
      if (group.isLocked) {
        return accumulator;
      }

      if (!accumulator[group.id]) {
        accumulator[group.id] = { group, tabsToRemove: [] };
      }

      accumulator[group.id].tabsToRemove.push(tab.id);
      return accumulator;
    }, {} as Record<string, { group: TabGroup; tabsToRemove: string[] }>);

    try {
      for (const { group, tabsToRemove } of Object.values(groupsToUpdate)) {
        if (shouldAutoDeleteAfterMultipleTabRemoval(group, tabsToRemove)) {
          await dispatch(deleteGroup(group.id)).unwrap();
          continue;
        }

        const updatedTabs = group.tabs.filter(tab => !tabsToRemove.includes(tab.id));
        await dispatch(updateGroup({
          ...group,
          tabs: updatedTabs,
          updatedAt: new Date().toISOString(),
        })).unwrap();
      }

      showDeleteSuccess(`成功删除 ${matchingTabs.length} 个搜索命中的标签页`);
    } catch (error) {
      console.error('批量删除搜索结果失败:', error);
      showDeleteError('删除操作失败，请重试');
    }
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
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">会话搜索结果</h3>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center flat-interaction"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.207A1 1 0 013 6.5V4z" />
          </svg>
          {showFilters ? '隐藏筛选' : '显示筛选'}
        </button>
      </div>

      {showFilters && (
        <div className={`bg-gray-50 dark:bg-gray-700 rounded-lg p-3 mb-3 ${withOuterMargin ? 'mx-2' : ''}`}>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-300 mb-1">固定标签页</label>
              <select
                value={filters.pinned || 'all'}
                onChange={event => setFilters({ ...filters, pinned: event.target.value as SearchFilters['pinned'] })}
                className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-600 text-gray-900 dark:text-gray-100"
              >
                <option value="all">全部</option>
                <option value="only">仅固定</option>
                <option value="exclude">排除固定</option>
              </select>
            </div>

            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-300 mb-1">域名</label>
              <input
                type="text"
                placeholder="输入域名..."
                value={filters.domain || ''}
                onChange={event => setFilters({ ...filters, domain: event.target.value })}
                className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-600 text-gray-900 dark:text-gray-100"
              />
            </div>

            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-300 mb-1">会话名称</label>
              <input
                type="text"
                placeholder="输入会话名称..."
                value={filters.groupName || ''}
                onChange={event => setFilters({ ...filters, groupName: event.target.value })}
                className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-600 text-gray-900 dark:text-gray-100"
              />
            </div>

            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-300 mb-1">保存时间</label>
              <select
                value={filters.savedWithin || ''}
                onChange={event => {
                  const nextValue = event.target.value as SearchFilters['savedWithin'] | '';
                  setFilters({ ...filters, savedWithin: nextValue || undefined });
                }}
                className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-600 text-gray-900 dark:text-gray-100"
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
          icon={
            <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 empty-state-default-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          }
          title="没有找到可找回的会话"
          description={`没有找到与“${searchQuery}”相关的会话或标签，请尝试其他关键词。`}
          action={
            <div className="text-xs theme-text-muted space-y-1">
              <div>小提示：</div>
              <ul className="list-disc list-inside space-y-0.5 text-left">
                <li>支持搜索会话名称、备注、标签标题或 URL</li>
                <li>可结合域名、保存时间和固定标签筛选</li>
                <li>如果刚换设备，可先登录后手动同步一次</li>
              </ul>
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
          <div className="flex items-center gap-1 opacity-0 group-hover/card:opacity-100 transition-opacity duration-150">
            <button
              onClick={handleRestoreAllSearchResults}
              className="btn-icon p-1.5 tab-group-action-accent flat-interaction"
              title="在新窗口恢复所有匹配标签"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
              </svg>
            </button>

            <button
              onClick={() => showConfirm({
                title: '删除确认',
                message: `确定要删除所有搜索结果中的 ${matchingTabs.length} 个标签页吗？此操作不可撤销。`,
                type: 'danger',
                confirmText: '删除',
                cancelText: '取消',
                onConfirm: handleDeleteAllSearchResults,
                onCancel: () => {},
              })}
              className="btn-icon p-1.5 tab-group-action-danger flat-interaction"
              title="删除所有搜索到的标签页"
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
          <div key={session.group.id} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/40 p-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                    {session.group.name}
                  </h4>
                  {session.group.isFavorite && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                      收藏
                    </span>
                  )}
                  <span className="rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs text-gray-600 dark:text-gray-300">
                    命中 {session.matches.length}
                  </span>
                </div>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {getSessionResultSummary(session.group, session.matches.length)}
                </p>
                {session.group.notes && (
                  <p className="mt-2 text-xs text-gray-600 dark:text-gray-300 line-clamp-2">
                    <HighlightText text={session.group.notes} highlight={searchQuery} />
                  </p>
                )}
              </div>

              <button
                onClick={() => restoreSession(session.group)}
                className="self-start rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-700"
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
