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

  // 将搜索结果按标签组分组
  const groupedResults = Object.entries(
    matchingTabs.reduce((acc, { tab, group }) => {
      if (!acc[group.id]) {
        acc[group.id] = { group, tabs: [] };
      }
      acc[group.id].tabs.push(tab);
      return acc;
    }, {} as Record<string, { group: TabGroup; tabs: Tab[] }>)
  );

  // 将分组结果分为左右两栏
  const leftColumnGroups = groupedResults.filter((_, index) => index % 2 === 0);
  const rightColumnGroups = groupedResults.filter((_, index) => index % 2 === 1);

  // 渲染单个标签组的搜索结果
  const renderGroupResults = ([groupId, { group, tabs }]: [string, { group: TabGroup; tabs: Tab[] }]) => (
    <div key={groupId} className="mb-3">
      <div className="flex items-center space-x-1 mb-0.5">
        <h4 className="text-xs font-medium text-gray-700">{group.name}</h4>
        <span className="text-xs text-gray-500">({tabs.length})</span>
      </div>
      <div className="pl-2 space-y-0.5 group">
        {tabs.map(tab => (
          <div
            key={tab.id}
            className="flex items-center py-1 px-1 hover:bg-gray-100 transition-colors"
          >
            <div className="flex items-center space-x-1 flex-1 min-w-0">
              {tab.favicon && (
                <img src={tab.favicon} alt="" className="w-4 h-4 flex-shrink-0" />
              )}
              <a
                href="#"
                className="truncate text-blue-600 hover:underline text-sm"
                onClick={(e) => {
                  e.preventDefault();
                  handleOpenTab(tab, group);
                }}
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
        ))}
      </div>
    </div>
  );

  return (
    <div>
      <h3 className="text-base font-medium mb-2">搜索结果</h3>
      {useDoubleColumnLayout ? (
        // 双栏布局
        <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 gap-3">
          {/* 左栏搜索结果 */}
          <div className="space-y-1">
            {leftColumnGroups.map(renderGroupResults)}
          </div>

          {/* 右栏搜索结果 */}
          <div className="space-y-1">
            {rightColumnGroups.map(renderGroupResults)}
          </div>
        </div>
      ) : (
        // 单栏布局
        <div className="space-y-2">
          {groupedResults.map(renderGroupResults)}
        </div>
      )}
    </div>
  );
};

export default SearchResultList;
