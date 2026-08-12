import React, { useEffect, lazy } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { loadGroups, moveGroupAndSync, setSearchQuery } from '@/store/slices/tabSlice';
import {
  selectSortedGroups,
  selectIsLoading,
  selectLastLoadedAt,
  selectError,
  selectLayoutMode,
  selectReorderMode,
} from '@/store/selectors/tabSelectors';
import { invalidateGroupsCache } from '@/utils/storage';
import { runMigrations } from '@/utils/migrationUtils';
import { DraggableTabGroup } from '@/components/dnd/DraggableTabGroup';
import { SearchResultList } from '@/components/search/SearchResultList';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PersonalizedWelcome, QuickActionTips } from '@/components/common/PersonalizedWelcome';
import { useListVirtualizer } from '@/hooks/useVirtualizer';
import type { TabGroup } from '@/types/tab';

interface TabListProps {
  searchQuery: string;
}

const ReorderView = lazy(() => import('@/components/tabs/ReorderView'));

export const TabList: React.FC<TabListProps> = ({ searchQuery }) => {
  const dispatch = useAppDispatch();
  // 离散 selector 切片 —— 每个 useAppSelector 只订阅一个字段。
  // 旧实现 `useAppSelector(state => ({...}))` 每次 dispatch 都返回新对象引用，
  // 触发 React-Redux "Selector unknown returned a different result" 警告并击穿 memoization。
  const isLoading = useAppSelector(selectIsLoading);
  const lastLoadedAt = useAppSelector(selectLastLoadedAt);
  const error = useAppSelector(selectError);
  const layoutMode = useAppSelector(selectLayoutMode);
  const reorderMode = useAppSelector(selectReorderMode);
  const sortedGroups = useAppSelector(selectSortedGroups);

  useEffect(() => {
    // popup 入口已经把 local 数据塞进 preloadedState（lastLoadedAt !== null），
    // 跳过重复的 loadGroups，避免无谓的 Storage 读 + Loading 闪烁。
    // service worker 通过 REFRESH_TAB_LIST 推送的更新仍会走到下面的 listener。
    if (lastLoadedAt) return;

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
  }, [dispatch, lastLoadedAt]);

  // Virtualize long lists so the popup stays responsive. Reorder and search
  // paths bypass this and render via their own components. Must be called
  // unconditionally — never after an early `return`.
  const { virtualizer, parentRef, enabled } = useListVirtualizer(sortedGroups, {
    itemHeight: 220,
    overscan: 3,
    threshold: 30,
  });

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
            className="rounded-2xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition hover:bg-gray-50/80 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            重新加载
          </button>
        }
        className="min-h-[16rem] flex flex-col justify-center"
      />
    );
  }

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
                className="px-6 py-2 text-sm font-medium flat-button-primary flat-interaction focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
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
        <SearchResultList searchQuery={searchQuery} onClearSearch={() => dispatch(setSearchQuery(''))} />
      ) : layoutMode === 'double' ? (
        (() => {
          // Single-pass split: each column gets a (group, index) pair so we can
          // pass the ORIGINAL filteredGroups index without an O(N^2) findIndex.
          const left: Array<{ group: TabGroup; index: number }> = [];
          const right: Array<{ group: TabGroup; index: number }> = [];
          filteredGroups.forEach((group, index) => {
            const bucket = index % 2 === 0 ? left : right;
            bucket.push({ group, index });
          });
          return (
            <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 gap-2 sm:gap-3 md:gap-4">
              <div className="space-y-2 transition-all duration-300 ease-out">
                {left.map(({ group, index }) => (
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

              <div className="space-y-2 transition-all duration-300 ease-out">
                {right.map(({ group, index }) => (
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
            </div>
          );
        })()
      ) : enabled ? (
        <div
          ref={parentRef}
          className="overflow-auto"
          style={{ maxHeight: '70vh' }}
        >
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map(vi => {
              const group = filteredGroups[vi.index];
              return (
                <div
                  key={group.id}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <DraggableTabGroup
                    group={group}
                    index={vi.index}
                    moveGroup={(dragIndex, hoverIndex) => {
                      dispatch(moveGroupAndSync({ dragIndex, hoverIndex }));
                    }}
                  />
                </div>
              );
            })}
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
