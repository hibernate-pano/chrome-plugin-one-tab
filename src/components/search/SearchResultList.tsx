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
      <div className="flex flex-col items-center justify-center h-64 space-y-2 text-gray-500 dark:text-gray-400">
        <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <p>没有找到匹配的标签</p>
      </div>
    );
  }
  
  const handleOpenTab = async (tab: Tab, group: TabGroup) => {
    // 如果标签组没有锁定，则从标签组中移除该标签页
    if (!group.isLocked) {
      const updatedTabs = group.tabs.filter(t => t.id !== tab.id);
      
      try {
        // 先更新 Redux 状态和 Chrome 存储
        if (updatedTabs.length === 0) {
          await dispatch(deleteGroup(group.id)).unwrap();
          console.log(`删除标签组: ${group.id}`);
        } else {
          // 否则更新标签组
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
  
  return (
    <div className="space-y-1">
      <h3 className="text-lg font-medium mb-2">搜索结果</h3>
      <div className="card-material overflow-hidden">
        <div className="divide-y divide-gray-200">
          {matchingTabs.map(({ tab, group }) => (
            <div
              key={tab.id}
              className="flex items-center justify-between p-3 hover:bg-gray-100 rounded-md transition-material"
            >
              <div 
                className="flex items-center space-x-2 flex-1 min-w-0 cursor-pointer" 
                onClick={() => handleOpenTab(tab, group)}
              >
                {tab.favicon && (
                  <img src={tab.favicon} alt="" className="w-4 h-4 flex-shrink-0" />
                )}
                <div className="truncate">
                  <span className="font-medium text-gray-900 transition-material">{tab.title}</span>
                  <div className="flex items-center text-xs text-gray-500 truncate transition-material">
                    <span className="truncate">{tab.url}</span>
                    <span className="mx-1">•</span>
                    <span className="text-gray-400 whitespace-nowrap">来自: {group.name}</span>
                  </div>
                </div>
              </div>
              <button
                onClick={() => handleDeleteTab(tab, group)}
                className="text-gray-500 hover:text-error p-1 rounded-full hover:bg-gray-100 transition-material"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default SearchResultList;
