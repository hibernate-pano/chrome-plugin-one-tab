import React, { useEffect, lazy, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { loadGroups, loadDeletedGroups, restoreGroup, purgeGroup, moveGroupAndSync } from '@/store/slices/tabSlice';
import { invalidateGroupsCache } from '@/utils/storage';
import { runMigrations } from '@/utils/migrationUtils';
import { DraggableTabGroup } from '@/components/dnd/DraggableTabGroup';
import { SearchResultList } from '@/components/search/SearchResultList';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PersonalizedWelcome, QuickActionTips } from '@/components/common/PersonalizedWelcome';
import { useToast } from '@/contexts/ToastContext';
import { useEnhancedToast } from '@/utils/toastHelper';
import type { TabGroup as TabGroupType } from '@/types/tab';

interface TabListProps {
  searchQuery: string;
}

const ReorderView = lazy(() => import('@/components/tabs/ReorderView'));

export const TabList: React.FC<TabListProps> = ({ searchQuery }) => {
  const dispatch = useAppDispatch();
  const { groups, deletedGroups, isLoading, error } = useAppSelector(state => state.tabs);
  const { layoutMode, reorderMode } = useAppSelector(state => state.settings);
  const { showConfirm, showToast } = useToast();
  const { showRestoreSuccess, showRestoreError } = useEnhancedToast();

  useEffect(() => {
    const initializeData = async () => {
      try {
        await runMigrations();
        dispatch(loadGroups());
        dispatch(loadDeletedGroups());
      } catch (migrationError) {
        console.error('初始化数据失败:', migrationError);
        dispatch(loadGroups());
        dispatch(loadDeletedGroups());
      }
    };

    initializeData();

    const messageListener = (message: { type?: string }) => {
      if (message.type === 'REFRESH_TAB_LIST') {
        invalidateGroupsCache();
        dispatch(loadGroups());
        dispatch(loadDeletedGroups());
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

      <DeletedGroupsSection
        deletedGroups={deletedGroups}
        onRestore={groupId => {
          dispatch(restoreGroup(groupId))
            .unwrap()
            .then(() => showRestoreSuccess(1))
            .catch(err => showRestoreError(err.message || '未知错误'));
        }}
        onPurge={groupId => {
          showConfirm({
            title: '彻底删除',
            message: '彻底删除后无法恢复（仅移除本地，云端墓碑保留）。确定吗？',
            confirmText: '彻底删除',
            cancelText: '取消',
            type: 'danger',
            onCancel: () => {},
            onConfirm: () => {
              dispatch(purgeGroup(groupId))
                .unwrap()
                .then(() => showToast('已彻底删除', 'success'))
                .catch(err => showToast(`删除失败: ${err.message || '未知错误'}`, 'error'));
            },
          });
        }}
      />
    </div>
  );
};

// ── 已删除（误删保护恢复）区 ──────────────────────────────
interface DeletedGroupsSectionProps {
  deletedGroups: TabGroupType[];
  onRestore: (groupId: string) => void;
  onPurge: (groupId: string) => void;
}

const DeletedGroupsSection: React.FC<DeletedGroupsSectionProps> = ({ deletedGroups, onRestore, onPurge }) => {
  const [expanded, setExpanded] = useState(false);

  if (deletedGroups.length === 0) return null;

  return (
    <div className="mt-4 rounded-2xl border border-dashed border-gray-300 bg-gray-50/50 p-4 dark:border-gray-700 dark:bg-gray-900/40">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-sm font-medium text-gray-500 dark:text-gray-400">
          已删除（{deletedGroups.length}）
        </span>
        <span className="text-gray-400">{expanded ? '−' : '+'}</span>
      </button>

      {expanded && (
        <ul className="mt-3 space-y-2">
          {deletedGroups.map(group => (
            <li
              key={group.id}
              className="flex items-center justify-between gap-2 rounded-xl bg-white px-3 py-2 shadow-sm dark:bg-gray-800"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-gray-700 dark:text-gray-200">{group.name}</p>
                <p className="text-xs text-gray-400">{group.tabs.length} 个标签页</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => onRestore(group.id)}
                  className="rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-700 transition hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                >
                  恢复
                </button>
                <button
                  type="button"
                  onClick={() => onPurge(group.id)}
                  className="rounded-md border border-rose-200 px-2 py-1 text-xs text-rose-600 transition hover:bg-rose-50 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950"
                >
                  彻底删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default TabList;
