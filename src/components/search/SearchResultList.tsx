import React from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { Tab, TabGroup } from '@/types/tab';
import { updateGroup, deleteGroup } from '@/store/slices/tabSlice';
import { syncService } from '@/services/syncService';

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
      <div className="flex flex-col items-center justify-center h-64 space-y-2 text-gray-500">
        <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <p>没有找到匹配的标签</p>
      </div>
    );
  }

  const { isAuthenticated } = useAppSelector(state => state.auth);

  const handleOpenTab = async (tab: Tab, group: TabGroup) => {
    // 如果标签组没有锁定，则从标签组中移除该标签页
    if (!group.isLocked) {
      const updatedTabs = group.tabs.filter(t => t.id !== tab.id);

      try {
        // 先更新 Redux 状态和 Chrome 存储
        if (updatedTabs.length === 0) {
          await dispatch(deleteGroup(group.id)).unwrap();
          console.log(`删除标签组: ${group.id}`);

          // 如果用户已登录，同步删除云端数据
          if (isAuthenticated) {
            console.log('用户已登录，同步删除云端数据');
            // 异步执行同步，不阻塞恢复操作
            syncService.syncAll().catch(err => {
              console.error('恢复标签组后同步失败:', err);
            });
          }
        } else {
          // 否则更新标签组
          const updatedGroup = {
            ...group,
            tabs: updatedTabs,
            updatedAt: new Date().toISOString()
          };
          await dispatch(updateGroup(updatedGroup)).unwrap();
          console.log(`更新标签组: ${group.id}, 剩余标签页: ${updatedTabs.length}`);

          // 如果用户已登录，同步更新到云端
          if (isAuthenticated) {
            console.log('用户已登录，同步更新到云端');
            // 异步执行同步，不阻塞恢复操作
            syncService.syncAll().catch(err => {
              console.error('恢复标签页后同步失败:', err);
            });
          }
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
      <div className="space-y-4">
        {/* Group search results by tab group */}
        {Object.entries(
          matchingTabs.reduce((acc, { tab, group }) => {
            if (!acc[group.id]) {
              acc[group.id] = { group, tabs: [] };
            }
            acc[group.id].tabs.push(tab);
            return acc;
          }, {} as Record<string, { group: TabGroup; tabs: Tab[] }>)
        ).map(([groupId, { group, tabs }]) => (
          <div key={groupId} className="space-y-1">
            <div className="flex items-center space-x-2 mb-1">
              <h4 className="text-sm font-medium text-gray-700">{group.name}</h4>
              <span className="text-xs text-gray-500">({tabs.length})</span>
            </div>
            <div className="pl-4 space-y-1 group">
              {tabs.map(tab => (
                <div
                  key={tab.id}
                  className="flex items-center py-1 px-2 hover:bg-gray-100 rounded-md transition-material"
                >
                  <div className="flex items-center space-x-2 flex-1 min-w-0">
                    {tab.favicon && (
                      <img src={tab.favicon} alt="" className="w-4 h-4 flex-shrink-0" />
                    )}
                    <a
                      href="#"
                      className="truncate text-primary-600 hover:underline"
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
                    className="text-gray-500 hover:text-error p-1 rounded-full hover:bg-gray-100 transition-material ml-1 opacity-0 group-hover:opacity-100"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default SearchResultList;
