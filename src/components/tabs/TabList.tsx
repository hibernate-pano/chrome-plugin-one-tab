import React, { useEffect, lazy } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { loadGroups, moveGroupAndSync } from '@/store/slices/tabSlice';
import { invalidateGroupsCache } from '@/utils/storage';
import { runMigrations } from '@/utils/migrationUtils';
import { DraggableTabGroup } from '@/components/dnd/DraggableTabGroup';
import { SearchResultList } from '@/components/search/SearchResultList';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PersonalizedWelcome, QuickActionTips } from '@/components/common/PersonalizedWelcome';

interface TabListProps {
  searchQuery: string;
}

const ReorderView = lazy(() => import('@/components/tabs/ReorderView'));

export const TabList: React.FC<TabListProps> = ({ searchQuery }) => {
  const dispatch = useAppDispatch();
  const { groups, isLoading, error } = useAppSelector(state => state.tabs);
  const { layoutMode, reorderMode } = useAppSelector(state => state.settings);

  useEffect(() => {
    const initializeData = async () => {
      try {
        await runMigrations();
        dispatch(loadGroups());
      } catch (migrationError) {
        console.error('初始化数据失败:', migrationError);
        dispatch(loadGroups());
      }
    };

    initializeData();

    const messageListener = (message: { type?: string }) => {
      if (message.type === 'REFRESH_TAB_LIST') {
        invalidateGroupsCache();
        dispatch(loadGroups());
      }
      return true;
    };

    chrome.runtime.onMessage.addListener(messageListener);

    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
    };
  }, [dispatch]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        tone="warning"
        title="会话列表暂时不可用"
        description={error}
        action={
          <button
            type="button"
            onClick={() => {
              dispatch(loadGroups());
            }}
            className="rounded-2xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            重新加载
          </button>
        }
        className="min-h-[16rem] flex flex-col justify-center"
      />
    );
  }

  const sortedGroups = [...groups].sort((left, right) => {
    if (!!left.isFavorite !== !!right.isFavorite) {
      return left.isFavorite ? -1 : 1;
    }

    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  });

  const filteredGroups = sortedGroups;
  const totalTabCount = filteredGroups.reduce((count, group) => count + group.tabs.length, 0);

  if (filteredGroups.length === 0 && !searchQuery) {
    return (
      <div className="space-y-4">
        <PersonalizedWelcome tabCount={totalTabCount} className="flat-card p-6" />
        <div className="flat-card p-6">
          <EmptyState
            tone="default"
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
      ) : layoutMode === 'double' ? (
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
    </div>
  );
};

export default TabList;
