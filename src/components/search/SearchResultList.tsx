import React from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { Tab, TabGroup } from '@/types/tab';
import { updateGroup, deleteGroup } from '@/store/slices/tabSlice';

interface SearchResultListProps {
  searchQuery: string;
}

export const SearchResultList: React.FC<SearchResultListProps> = ({ searchQuery }) => {
  const dispatch = useAppDispatch();
  const { groups } = useAppSelector(state => state.tabs);
  const { useDoubleColumnLayout } = useAppSelector(state => state.settings);

  // 从所有标签组中提取匹配的标签
  const matchingTabs: Array<{ tab: Tab; group: TabGroup }> = [];

  if (searchQuery) {
    const query = searchQuery.toLowerCase();

    groups.forEach(group => {
      group.tabs.forEach(tab => {
        if (
          tab.title.toLowerCase().includes(query) ||
          tab.url.toLowerCase().includes(query)
        ) {
          matchingTabs.push({ tab, group });
        }
      });
    });
  }

  if (matchingTabs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-40 space-y-2 text-gray-500">
        <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <p>没有找到匹配的标签</p>
      </div>
    );
  }

  // 不再需要获取用户状态和设置

  const handleOpenTab = async (tab: Tab, group: TabGroup) => {
    // 如果标签组没有锁定，则从标签组中移除该标签页
    if (!group.isLocked) {
      try {
        // 如果标签组只有一个标签页，则删除整个标签组
        if (group.tabs.length === 1) {
          await dispatch(deleteGroup(group.id)).unwrap();
          console.log(`删除标签组: ${group.id}`);
        } else {
          // 否则更新标签组，移除该标签页
          const updatedTabs = group.tabs.filter(t => t.id !== tab.id);
          const updatedGroup = {
            ...group,
            tabs: updatedTabs,
            updatedAt: new Date().toISOString()
          };
          await dispatch(updateGroup(updatedGroup)).unwrap();
          console.log(`更新标签组: ${group.id}, 剩余标签页: ${updatedTabs.length}`);
        }

        // 然后发送消息给后台脚本打开标签页
        chrome.runtime.sendMessage({
          type: 'OPEN_TAB',
          data: { url: tab.url }
        });
      } catch (error) {
        console.error('更新标签组失败:', error);
      }
    } else {
      // 如果标签组已锁定，直接打开标签页
      chrome.runtime.sendMessage({
        type: 'OPEN_TAB',
        data: { url: tab.url }
      });
    }
  };

  const handleDeleteTab = (tab: Tab, group: TabGroup) => {
    const updatedTabs = group.tabs.filter(t => t.id !== tab.id);
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
  };

  // 将搜索结果分为左右两栏（双栏布局时使用）
  const leftColumnTabs = matchingTabs.filter((_, index) => index % 2 === 0);
  const rightColumnTabs = matchingTabs.filter((_, index) => index % 2 === 1);

  // 渲染单个标签项
  const renderTabItem = ({ tab, group }: { tab: Tab; group: TabGroup }) => (
    <div
      className="flex items-center py-1 px-2 hover:bg-gray-100 transition-colors rounded mb-1"
    >
      <div className="flex items-center space-x-2 flex-1 min-w-0">
        {tab.favicon && (
          <img src={tab.favicon} alt="" className="w-4 h-4 flex-shrink-0" />
        )}
        <a
          href="#"
          className="truncate text-blue-600 hover:underline text-sm flex-1 min-w-0"
          onClick={(e) => {
            e.preventDefault();
            handleOpenTab(tab, group);
          }}
          title={tab.title}
        >
          {tab.title}
        </a>
      </div>
      <button
        onClick={() => handleDeleteTab(tab, group)}
        className="text-gray-400 hover:text-red-500 p-1 hover:bg-gray-100 transition-colors ml-1 opacity-0 group-hover:opacity-100"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );

  // 恢复所有搜索到的标签页
  const handleRestoreAllSearchResults = async () => {
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

    // 处理每个需要更新的标签组
    for (const { group, tabsToRemove } of Object.values(groupsToUpdate)) {
      try {
        // 如果要删除的标签页数量等于标签组中的所有标签页，则删除整个标签组
        if (tabsToRemove.length === group.tabs.length) {
          await dispatch(deleteGroup(group.id)).unwrap();
          console.log(`删除标签组: ${group.id}`);
        } else {
          // 否则更新标签组，移除这些标签页
          const updatedTabs = group.tabs.filter(t => !tabsToRemove.includes(t.id));
          const updatedGroup = {
            ...group,
            tabs: updatedTabs,
            updatedAt: new Date().toISOString()
          };
          await dispatch(updateGroup(updatedGroup)).unwrap();
          console.log(`更新标签组: ${group.id}, 剩余标签页: ${updatedTabs.length}`);
        }
      } catch (error) {
        console.error('更新标签组失败:', error);
      }
    }

    // 打开所有标签页
    chrome.runtime.sendMessage({
      type: 'OPEN_TABS',
      data: { urls }
    });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-base font-medium">搜索结果 ({matchingTabs.length})</h3>
        {matchingTabs.length > 0 && (
          <button
            onClick={handleRestoreAllSearchResults}
            className="text-blue-600 hover:text-blue-800 text-xs hover:underline flex items-center"
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
};

export default SearchResultList;
