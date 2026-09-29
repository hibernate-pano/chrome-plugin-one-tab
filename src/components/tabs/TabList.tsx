import React, { useEffect, lazy } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { loadGroups, moveGroupAndSync } from '@/store/slices/tabSlice';
import { invalidateGroupsCache, onGroupsChanged } from '@/utils/storage';
import { runMigrations } from '@/utils/migrationUtils';
import { DraggableTabGroup } from '@/components/dnd/DraggableTabGroup';
import { SearchResultList } from '@/components/search/SearchResultList';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PersonalizedWelcome, QuickActionTips } from '@/components/common/PersonalizedWelcome';
import { toListErrorCopy } from './listErrorCopy';
import { logError } from '../../utils/log';

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
        logError('初始化数据失败:', migrationError);
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

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = onGroupsChanged(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        dispatch(loadGroups());
      }, 150);
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
  useEffect(() => {
    if (error) logError('加载会话列表失败:', error);
  }, [error]);

  const errorCopy = toListErrorCopy(error);

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
        title={errorCopy.title}
        description={errorCopy.description}
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
          {(() => {
            // 按次序左右对分：前半进左栏、后半进右栏，读序与单栏一致。
            // 历史实现用奇偶交替（index % 2），导致阅读顺序错乱（1,3,5… 后 2,4,6…），
            // 且总数为奇数时左栏恒好多出一个——用户观感就是「左边多一个、右边不匀」。
            // 奇数时把多出的一项放左栏：左栏是读序起点，视觉与语义都更自然。
            const mid = Math.ceil(filteredGroups.length / 2);
            const columns = [filteredGroups.slice(0, mid), filteredGroups.slice(mid)];
            return columns.map((column, columnIndex) => (
              <div key={columnIndex} className="space-y-2 transition-all duration-300 ease-out">
                {column.map(group => (
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
            ));
          })()}
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
