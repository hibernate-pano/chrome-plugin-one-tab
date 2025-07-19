import React, { useMemo, useCallback } from 'react';
import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import { Tab, TabGroup } from '@/types/tab';
import { updateGroup, deleteGroup } from '@/features/tabs/store/tabGroupsSlice';
import HighlightText from './HighlightText';

interface SearchResultListProps {
  searchQuery: string;
}

export const SearchResultList: React.FC<SearchResultListProps> = React.memo(({ searchQuery }) => {
  const dispatch = useAppDispatch();
  const { groups } = useAppSelector(state => state.tabGroups);
  const { useDoubleColumnLayout } = useAppSelector(state => state.settings);

  // 安全检查：确保groups不为undefined
  const safeGroups = groups || [];

  // 使用useMemo缓存搜索结果，避免每次渲染都重新计算
  const matchingTabs = useMemo(() => {
    const results: Array<{ tab: Tab; group: TabGroup }> = [];
    
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      
      safeGroups.forEach(group => {
        const safeTabs = group.tabs || [];
        safeTabs.forEach(tab => {
          if (
            tab.title?.toLowerCase().includes(query) ||
            tab.url?.toLowerCase().includes(query)
          ) {
            results.push({ tab, group });
          }
        });
      });
    }
    
    return results;
  }, [searchQuery, safeGroups]);

  if (matchingTabs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-40 space-y-2 text-gray-500 dark:text-gray-400">
        <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <p>没有找到匹配的标签</p>
      </div>
    );
  }

  // 不再需要获取用户状态和设置

  const handleOpenTab = useCallback((tab: Tab, group: TabGroup) => {
    // 如果标签组没有锁定，先从标签组中移除该标签页
    if (!group.isLocked) {
      // 如果标签组只有一个标签页，则删除整个标签组
      const groupTabs = group.tabs || [];
      if (groupTabs.length === 1) {
        // 先在Redux中删除标签组，立即更新UI
        dispatch({ type: 'tabs/deleteGroup/fulfilled', payload: group.id });

        // 然后异步完成存储操作
        dispatch(deleteGroup(group.id))
          .then(() => {
            console.log(`删除标签组: ${group.id}`);
          })
          .catch(error => {
            console.error('删除标签组失败:', error);
          });
      } else {
        // 否则更新标签组，移除该标签页
        const updatedTabs = groupTabs.filter(t => t.id !== tab.id);
        const updatedGroup = {
          ...group,
          tabs: updatedTabs,
          updatedAt: new Date().toISOString()
        };

        // 先在Redux中更新标签组，立即更新UI
        dispatch({ type: 'tabs/updateGroup/fulfilled', payload: updatedGroup });

        // 然后异步完成存储操作
        dispatch(updateGroup(updatedGroup))
          .then(() => {
            console.log(`更新标签组: ${group.id}, 剩余标签页: ${updatedTabs.length}`);
          })
          .catch(error => {
            console.error('更新标签组失败:', error);
          });
      }
    }

    // 最后发送消息给后台脚本打开标签页
    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'OPEN_TAB',
        data: { url: tab.url }
      });
    }, 50); // 小延迟确保 UI 先更新
  }, [dispatch]);

  const handleDeleteTab = useCallback((tab: Tab, group: TabGroup) => {
    const groupTabs = group.tabs || [];
    const updatedTabs = groupTabs.filter(t => t.id !== tab.id);
    if (updatedTabs.length === 0) {
      dispatch(deleteGroup(group.id));
    } else {
      const updatedGroup = {
        ...group,
        tabs: updatedTabs,
        updatedAt: new Date().toISOString()
      };
      dispatch(updateGroup(updatedGroup));
    }
  }, [dispatch]);

  // 将搜索结果分为左右两栏（双栏布局时使用）
  const leftColumnTabs = useMemo(() => matchingTabs.filter((_, index) => index % 2 === 0), [matchingTabs]);
  const rightColumnTabs = useMemo(() => matchingTabs.filter((_, index) => index % 2 === 1), [matchingTabs]);

  // 渲染单个标签项
  const renderTabItem = useCallback(({ tab, group }: { tab: Tab; group: TabGroup }) => (
    <div
      className="flex items-center py-1 px-2 bg-white dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors rounded mb-1"
    >
      <div className="flex items-center space-x-2 flex-1 min-w-0">
        {tab.favicon ? (
          <img src={tab.favicon} alt="" className="w-4 h-4 flex-shrink-0" />
        ) : (
          <div className="w-4 h-4 bg-gray-200 dark:bg-gray-600 flex-shrink-0 flex items-center justify-center">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 text-gray-500 dark:text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
        )}
        <a
          href="#"
          className="truncate text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 hover:underline text-sm flex-1 min-w-0"
          onClick={(e) => {
            e.preventDefault();
            handleOpenTab(tab, group);
          }}
          title={tab.title}
        >
          <HighlightText text={tab.title} highlight={searchQuery} />
        </a>
      </div>
      <button
        onClick={() => handleDeleteTab(tab, group)}
        className="text-gray-400 hover:text-red-500 dark:text-gray-500 dark:hover:text-red-400 p-1 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors ml-1 opacity-0 group-hover:opacity-100"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  ), [handleOpenTab, handleDeleteTab, searchQuery]);

  // 恢复所有搜索到的标签页
  const handleRestoreAllSearchResults = useCallback(() => {
    if (matchingTabs.length === 0) return;

    // 收集所有标签页的URL
    const urls = matchingTabs.map(({ tab }) => tab.url);

    // 处理标签组更新
    // 我们需要按标签组分组处理，因为每个标签组的锁定状态可能不同
    const groupsToUpdate = matchingTabs.reduce((acc, { tab, group }) => {
      if (group.isLocked) return acc; // 如果标签组已锁定，不删除标签页

      if (!acc[group.id]) {
        acc[group.id] = { group, tabsToRemove: [] };
      }
      acc[group.id].tabsToRemove.push(tab.id);
      return acc;
    }, {} as Record<string, { group: TabGroup; tabsToRemove: string[] }>);

    // 先在UI中更新标签组，立即更新界面
    Object.values(groupsToUpdate).forEach(({ group, tabsToRemove }) => {
      // 如果要删除的标签页数量等于标签组中的所有标签页，则删除整个标签组
      const groupTabs = group.tabs || [];
      if (tabsToRemove.length === groupTabs.length) {
        // 先在Redux中删除标签组，立即更新UI
        dispatch({ type: 'tabs/deleteGroup/fulfilled', payload: group.id });
      } else {
        // 否则更新标签组，移除这些标签页
        const updatedTabs = groupTabs.filter(t => !tabsToRemove.includes(t.id));
        const updatedGroup = {
          ...group,
          tabs: updatedTabs,
          updatedAt: new Date().toISOString()
        };
        // 先在Redux中更新标签组，立即更新UI
        dispatch({ type: 'tabs/updateGroup/fulfilled', payload: updatedGroup });
      }
    });

    // 异步完成存储操作
    setTimeout(() => {
      Object.values(groupsToUpdate).forEach(({ group, tabsToRemove }) => {
        // 如果要删除的标签页数量等于标签组中的所有标签页，则删除整个标签组
        const groupTabs = group.tabs || [];
        if (tabsToRemove.length === groupTabs.length) {
          dispatch(deleteGroup(group.id))
            .then(() => {
              console.log(`删除标签组: ${group.id}`);
            })
            .catch(error => {
              console.error('删除标签组失败:', error);
            });
        } else {
          // 否则更新标签组，移除这些标签页
          const updatedTabs = groupTabs.filter(t => !tabsToRemove.includes(t.id));
          const updatedGroup = {
            ...group,
            tabs: updatedTabs,
            updatedAt: new Date().toISOString()
          };
          dispatch(updateGroup(updatedGroup))
            .then(() => {
              console.log(`更新标签组: ${group.id}, 剩余标签页: ${updatedTabs.length}`);
            })
            .catch(error => {
              console.error('更新标签组失败:', error);
            });
        }
      });

      // 最后发送消息给后台脚本打开标签页
      chrome.runtime.sendMessage({
        type: 'OPEN_TABS',
        data: { urls }
      });
    }, 100); // 使用 100 毫秒的延迟，确保 UI 先更新
  }, [matchingTabs, dispatch]);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-base font-medium text-gray-900 dark:text-gray-100">搜索结果 ({matchingTabs.length})</h3>
        {matchingTabs.length > 0 && (
          <button
            onClick={handleRestoreAllSearchResults}
            className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 text-xs hover:underline flex items-center"
            title="恢复所有搜索到的标签页"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            恢复全部
          </button>
        )}
      </div>
      {useDoubleColumnLayout ? (
        // 双栏布局
        <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 gap-3">
          {/* 左栏搜索结果 */}
          <div className="space-y-1 group">
            {leftColumnTabs.map(tabInfo => (
              <React.Fragment key={tabInfo.tab.id}>
                {renderTabItem(tabInfo)}
              </React.Fragment>
            ))}
          </div>

          {/* 右栏搜索结果 */}
          <div className="space-y-1 group">
            {rightColumnTabs.map(tabInfo => (
              <React.Fragment key={tabInfo.tab.id}>
                {renderTabItem(tabInfo)}
              </React.Fragment>
            ))}
          </div>
        </div>
      ) : (
        // 单栏布局
        <div className="space-y-1 group">
          {matchingTabs.map(tabInfo => (
            <React.Fragment key={tabInfo.tab.id}>
              {renderTabItem(tabInfo)}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
});

SearchResultList.displayName = 'SearchResultList';

export default SearchResultList;
