import React, { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { loadGroups } from '@/store/slices/tabSlice';
import { invalidateGroupsCache, onGroupsChanged } from '@/utils/storage';
import { runMigrations } from '@/utils/migrationUtils';
import { DraggableTabGroup } from '@/components/dnd/DraggableTabGroup';
import { SearchResultList } from '@/components/search/SearchResultList';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PersonalizedWelcome } from '@/components/common/PersonalizedWelcome';
import { toListErrorCopy } from './listErrorCopy';
import { getContextOrigin } from '@/core/contextOrigin';
import { logError } from '../../utils/log';

interface TabListProps {
  searchQuery: string;
}

export const TabList: React.FC<TabListProps> = ({ searchQuery }) => {
  const dispatch = useAppDispatch();
  const { groups, isLoading, error } = useAppSelector(state => state.tabs);
  const { layoutMode } = useAppSelector(state => state.settings);

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
  useEffect(() => {
    if (error) logError('加载会话列表失败:', error);
  }, [error]);

  const errorCopy = toListErrorCopy(error);

  // 只有「冷启动还没有任何数据」才整页 loading。
  // 后台刷新（onGroupsChanged / REFRESH_TAB_LIST）也会把 isLoading 置真，
  // 若照旧整页替换，拖拽/同步每次落盘都会闪一次全屏 spinner——即用户看到的
  // 「整个标签管理器页面都刷新了」。有数据时让刷新静默进行。
  if (isLoading && groups.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  // 同理：已有数据时后台刷新失败不该把列表整页换成错误页，日志照旧（见上 error effect）。
  if (error && groups.length === 0) {
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
      </div>
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
                  <DraggableTabGroup key={group.id} group={group} />
                ))}
              </div>
            ));
          })()}
        </div>
      ) : (
        <div className="space-y-2 transition-all duration-300 ease-out">
          {filteredGroups.map(group => (
            <DraggableTabGroup key={group.id} group={group} />
          ))}
        </div>
      )}
    </div>
  );
};

export default TabList;
