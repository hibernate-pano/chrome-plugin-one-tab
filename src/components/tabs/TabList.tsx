import React, { useEffect, lazy } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { deleteGroup, loadGroups, loadRecentRestores, moveGroupAndSync, recordRecentRestore } from '@/store/slices/tabSlice';
import { invalidateGroupsCache } from '@/utils/storage';
import { runMigrations } from '@/utils/migrationUtils';
import { DraggableTabGroup } from '@/components/dnd/DraggableTabGroup';
import { SearchResultList } from '@/components/search/SearchResultList';
import { RecentRestoreEntry, TabGroup as TabGroupType } from '@/types/tab';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PersonalizedWelcome, QuickActionTips } from '@/components/common/PersonalizedWelcome';
import { useEnhancedToast } from '@/utils/toastHelper';
import { useToast } from '@/contexts/ToastContext';
import { trackProductEvent } from '@/utils/productEvents';
import { buildRecentRestoreEntry, buildSessionRestoreMessage, getRestoreSourceLabel } from '@/utils/sessionPresentation';

interface TabListProps {
  searchQuery: string;
}

const ReorderView = lazy(() => import('@/components/tabs/ReorderView'));

const formatRecentSaveTime = (createdAt: string) => {
  const date = new Date(createdAt);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const quickEntryClassName =
  'w-full rounded-xl border border-gray-200 dark:border-gray-700 px-3 py-3 text-left transition-colors hover:border-primary-300 hover:bg-primary-50 dark:hover:bg-gray-800';

export const TabList: React.FC<TabListProps> = ({ searchQuery }) => {
  const dispatch = useAppDispatch();
  const { groups, recentRestores, isLoading, error } = useAppSelector(state => state.tabs);
  const { layoutMode, reorderMode } = useAppSelector(state => state.settings);
  const { showDeleteError } = useEnhancedToast();
  const { showToast } = useToast();

  useEffect(() => {
    const initializeData = async () => {
      try {
        await runMigrations();
        dispatch(loadGroups());
        dispatch(loadRecentRestores());
      } catch (migrationError) {
        console.error('初始化数据失败:', migrationError);
        dispatch(loadGroups());
        dispatch(loadRecentRestores());
      }
    };

    initializeData();

    const messageListener = (message: { type?: string }) => {
      if (message.type === 'REFRESH_TAB_LIST') {
        invalidateGroupsCache();
        dispatch(loadGroups());
        dispatch(loadRecentRestores());
      }
      return true;
    };

    chrome.runtime.onMessage.addListener(messageListener);

    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
    };
  }, [dispatch]);

  const restoreSession = (group: TabGroupType) => {
    const tabsPayload = group.tabs.map(tab => ({
      url: tab.url,
      pinned: !!tab.pinned,
    }));

    dispatch(recordRecentRestore(buildRecentRestoreEntry(group, 'recent-save')));
    void trackProductEvent('session_restored', {
      sessionId: group.id,
      sessionName: group.name,
      source: 'recent-save',
      tabCount: group.tabs.length,
    });

    if (!group.isLocked) {
      dispatch({ type: 'tabs/deleteGroup/fulfilled', payload: group.id });

      dispatch(deleteGroup(group.id))
        .unwrap()
        .catch(error => {
          console.error('恢复会话后删除原会话失败:', error);
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

  const restoreRecentSession = (entry: RecentRestoreEntry) => {
    dispatch(recordRecentRestore({
      ...entry,
      restoredAt: new Date().toISOString(),
      source: 'recent-restore',
    }));
    void trackProductEvent('session_restored_again', {
      sessionId: entry.sessionId,
      sessionName: entry.name,
      source: entry.source,
      tabCount: entry.tabCount,
    });

    showToast(
      `已再次恢复会话“${entry.name}”，${entry.tabCount} 个标签页，来源：${getRestoreSourceLabel(entry.source)}`,
      'success',
      4500
    );

    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'OPEN_TABS',
        data: { tabs: entry.tabs },
      });
    }, 100);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (error) {
    return <div className="flex items-center justify-center h-64 text-red-600">{error}</div>;
  }

  const sortedGroups = [...groups].sort((left, right) => {
    if (!!left.isFavorite !== !!right.isFavorite) {
      return left.isFavorite ? -1 : 1;
    }

    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  });

  const filteredGroups = sortedGroups;
  const recentGroups = [...groups]
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .slice(0, 3);
  const totalTabCount = filteredGroups.reduce((count, group) => count + group.tabs.length, 0);

  if (filteredGroups.length === 0 && !searchQuery) {
    return (
      <div className="space-y-4">
        <PersonalizedWelcome tabCount={totalTabCount} className="flat-card p-6" />
        <div className="flat-card p-6">
          <EmptyState
            title="先保存一个工作会话"
            description="点击右上角的「保存会话」按钮，把当前窗口保存成可稍后找回的工作会话。"
            action={
              <button
                onClick={async () => {
                  const tabs = await chrome.tabs.query({ currentWindow: true });
                  const windowId = tabs[0]?.windowId;
                  chrome.runtime.sendMessage({
                    type: 'SAVE_ALL_TABS',
                    data: { windowId },
                  });
                }}
                className="px-6 py-2 text-sm font-medium flat-button-primary flat-interaction"
              >
                保存当前窗口
              </button>
            }
          />
        </div>
        <QuickActionTips className="flat-card p-4" />
      </div>
    );
  }

  if (reorderMode) {
    return (
      <React.Suspense fallback={<div>加载中...</div>}>
        <ReorderView />
      </React.Suspense>
    );
  }

  return (
    <div className="space-y-3 micro-interaction-container">
      {searchQuery ? (
        <SearchResultList searchQuery={searchQuery} />
      ) : (
        <>
          {recentRestores.length > 0 && (
            <div className="flat-card p-4">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div>
                  <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">最近恢复</h2>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    查看最近恢复过的会话，也能按最近一次的来源再次打开。
                  </p>
                </div>
              </div>
              <div className="space-y-2">
                {recentRestores.map(entry => (
                  <button
                    key={`restore-${entry.sessionId}`}
                    onClick={() => restoreRecentSession(entry)}
                    className={quickEntryClassName}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{entry.name}</div>
                          <span className="rounded-full bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-[11px] text-gray-600 dark:text-gray-300">
                            {getRestoreSourceLabel(entry.source)}
                          </span>
                        </div>
                        <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                          {entry.tabCount} 个标签页
                          {entry.pinnedCount > 0 ? ` · ${entry.pinnedCount} 个固定标签页` : ''}
                          {` · ${formatRecentSaveTime(entry.restoredAt)}`}
                        </div>
                        {entry.notes && (
                          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400 line-clamp-2">
                            {entry.notes}
                          </div>
                        )}
                      </div>
                      <span className="rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-medium text-white">
                        再次恢复
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {recentGroups.length > 0 && (
            <div className="flat-card p-4">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div>
                  <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">最近保存</h2>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    直接恢复最近保存的会话，继续上次的工作现场。
                  </p>
                </div>
              </div>
              <div className="space-y-2">
                {recentGroups.map(group => (
                  <button
                    key={`recent-${group.id}`}
                    onClick={() => restoreSession(group)}
                    className={quickEntryClassName}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{group.name}</div>
                          <span className="rounded-full bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-[11px] text-gray-600 dark:text-gray-300">
                            最近保存
                          </span>
                          {group.isFavorite && (
                            <span className="rounded-full bg-amber-100 dark:bg-amber-900/40 px-2 py-0.5 text-[11px] text-amber-700 dark:text-amber-300">
                              已收藏
                            </span>
                          )}
                        </div>
                        <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                          {group.tabs.length} 个标签页
                          {group.tabs.some(tab => tab.pinned) ? ` · ${group.tabs.filter(tab => tab.pinned).length} 个固定标签页` : ''}
                          {group.createdAt ? ` · ${formatRecentSaveTime(group.createdAt)}` : ''}
                        </div>
                        {group.notes && (
                          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400 line-clamp-2">
                            {group.notes}
                          </div>
                        )}
                      </div>
                      <span className="rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-medium text-white">
                        恢复会话
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {layoutMode === 'double' ? (
            <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 gap-2 sm:gap-3 md:gap-4">
              <div className="space-y-2 transition-all duration-300 ease-out">
                {filteredGroups
                  .filter((_, index) => index % 2 === 0)
                  .map(group => (
                    <DraggableTabGroup
                      key={group.id}
                      group={group}
                      index={filteredGroups.findIndex(item => item.id === group.id)}
                      moveGroup={(dragIndex, hoverIndex) => {
                        dispatch(moveGroupAndSync({ dragIndex, hoverIndex }));
                      }}
                    />
                  ))}
              </div>

              <div className="space-y-2 transition-all duration-300 ease-out">
                {filteredGroups
                  .filter((_, index) => index % 2 === 1)
                  .map(group => (
                    <DraggableTabGroup
                      key={group.id}
                      group={group}
                      index={filteredGroups.findIndex(item => item.id === group.id)}
                      moveGroup={(dragIndex, hoverIndex) => {
                        dispatch(moveGroupAndSync({ dragIndex, hoverIndex }));
                      }}
                    />
                  ))}
              </div>
            </div>
          ) : (
            <div className="space-y-2 transition-all duration-300 ease-out">
              {filteredGroups.map((group, index) => (
                <DraggableTabGroup
                  key={group.id}
                  group={group}
                  index={index}
                  moveGroup={(dragIndex, hoverIndex) => {
                    dispatch(moveGroupAndSync({ dragIndex, hoverIndex }));
                  }}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default TabList;
