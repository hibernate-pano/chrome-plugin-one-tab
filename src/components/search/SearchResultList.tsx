import React from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { Tab, TabGroup } from '@/types/tab';
import { updateGroup, deleteGroup } from '@/store/slices/tabSlice';
import { shouldAutoDeleteAfterTabRemoval, shouldAutoDeleteAfterMultipleTabRemoval } from '@/utils/tabGroupUtils';
import { useToast } from '@/contexts/ToastContext';
import HighlightText from './HighlightText';
import { SafeFavicon } from '@/components/common/SafeFavicon';
import { EmptyState } from '@/components/common/EmptyState';

interface SearchResultListProps {
  searchQuery: string;
}

export const SearchResultList: React.FC<SearchResultListProps> = ({ searchQuery }) => {
  const dispatch = useAppDispatch();
  const { groups } = useAppSelector(state => state.tabs);
  const { showConfirm, showToast } = useToast();
  // 搜索结果强制使用单栏显示，不再依赖用户的布局设置
  // const { layoutMode } = useAppSelector(state => state.settings);

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
      <EmptyState
        icon={
          <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        }
        title="没有找到匹配的标签"
        description={`没有找到包含"${searchQuery}"的标签页，请尝试其他关键词。`}
        className="h-40"
      />
    );
  }

  // 不再需要获取用户状态和设置

  const handleOpenTab = (tab: Tab, group: TabGroup) => {
    // 如果标签组没有锁定，先从标签组中移除该标签页
    if (!group.isLocked) {
      // 使用工具函数检查是否应该自动删除标签组
      if (shouldAutoDeleteAfterTabRemoval(group, tab.id)) {
        // 先在Redux中删除标签组，立即更新UI
        dispatch({ type: 'tabs/deleteGroup/fulfilled', payload: group.id });

        // 然后异步完成存储操作
        dispatch(deleteGroup(group.id))
          .then(() => {
            console.log(`自动删除空标签组: ${group.name} (ID: ${group.id})`);
          })
          .catch(error => {
            console.error('删除标签组失败:', error);
          });
      } else {
        // 否则更新标签组，移除该标签页
        const updatedTabs = group.tabs.filter(t => t.id !== tab.id);
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
            console.log(`更新标签组: ${group.name}, 剩余标签页: ${updatedTabs.length}`);
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
  };

  const handleDeleteTab = (tab: Tab, group: TabGroup) => {
    // 使用工具函数检查是否应该自动删除标签组
    if (shouldAutoDeleteAfterTabRemoval(group, tab.id)) {
      dispatch(deleteGroup(group.id));
      console.log(`自动删除空标签组: ${group.name} (ID: ${group.id})`);
    } else {
      const updatedTabs = group.tabs.filter(t => t.id !== tab.id);
      const updatedGroup = {
        ...group,
        tabs: updatedTabs,
        updatedAt: new Date().toISOString()
      };
      dispatch(updateGroup(updatedGroup));
      console.log(`从标签组删除标签页: ${group.name}, 剩余标签页: ${updatedTabs.length}`);
    }
  };

  // 搜索结果强制使用单栏显示，不再需要分栏逻辑
  // const leftColumnTabs = matchingTabs.filter((_, index) => index % 2 === 0);
  // const rightColumnTabs = matchingTabs.filter((_, index) => index % 2 === 1);

  // 渲染单个标签项
  const renderTabItem = ({ tab, group }: { tab: Tab; group: TabGroup }) => (
    <div
      className="flex items-center py-0.5 px-2 bg-white dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors rounded"
    >
      <div className="flex items-center space-x-2 flex-1 min-w-0">
        <SafeFavicon src={tab.favicon} alt="" />
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
  );

  // 恢复所有搜索到的标签页
  const handleRestoreAllSearchResults = () => {
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
      if (tabsToRemove.length === group.tabs.length) {
        // 先在Redux中删除标签组，立即更新UI
        dispatch({ type: 'tabs/deleteGroup/fulfilled', payload: group.id });
      } else {
        // 否则更新标签组，移除这些标签页
        const updatedTabs = group.tabs.filter(t => !tabsToRemove.includes(t.id));
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
        if (tabsToRemove.length === group.tabs.length) {
          dispatch(deleteGroup(group.id))
            .then(() => {
              console.log(`删除标签组: ${group.id}`);
            })
            .catch(error => {
              console.error('删除标签组失败:', error);
            });
        } else {
          // 否则更新标签组，移除这些标签页
          const updatedTabs = group.tabs.filter(t => !tabsToRemove.includes(t.id));
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
  };

  // 删除所有搜索到的标签页
  const handleDeleteAllSearchResults = async () => {
    if (matchingTabs.length === 0) return;

    console.log(`🚀 开始批量删除 ${matchingTabs.length} 个标签页`);
    console.log('匹配的标签页:', matchingTabs.map(m => `${m.tab.title} (来自 ${m.group.name})`));

    // 处理标签组更新
    // 我们需要按标签组分组处理，因为每个标签组的锁定状态可能不同
    const groupsToUpdate = matchingTabs.reduce((acc, { tab, group }) => {
      if (group.isLocked) {
        console.log(`⚠️  跳过锁定标签组: ${group.name}`);
        return acc; // 如果标签组已锁定，不删除标签页
      }

      if (!acc[group.id]) {
        acc[group.id] = { group, tabsToRemove: [] };
      }
      acc[group.id].tabsToRemove.push(tab.id);
      return acc;
    }, {} as Record<string, { group: TabGroup; tabsToRemove: string[] }>);

    console.log(`📋 需要处理 ${Object.keys(groupsToUpdate).length} 个标签组`);

    // 先在UI中更新标签组，立即更新界面
    Object.values(groupsToUpdate).forEach(({ group, tabsToRemove }) => {
      // 使用工具函数检查是否应该自动删除标签组
      if (shouldAutoDeleteAfterMultipleTabRemoval(group, tabsToRemove)) {
        console.log(`🔄 UI更新: 标记删除标签组 ${group.name}`);
        // 先在Redux中删除标签组，立即更新UI
        dispatch({ type: 'tabs/deleteGroup/fulfilled', payload: group.id });
      } else {
        // 否则更新标签组，移除这些标签页
        const updatedTabs = group.tabs.filter(t => !tabsToRemove.includes(t.id));
        const updatedGroup = {
          ...group,
          tabs: updatedTabs,
          updatedAt: new Date().toISOString()
        };
        console.log(`🔄 UI更新: 标记更新标签组 ${group.name}, 剩余 ${updatedTabs.length} 个标签页`);
        // 先在Redux中更新标签组，立即更新UI
        dispatch({ type: 'tabs/updateGroup/fulfilled', payload: updatedGroup });
      }
    });

    // 关键修复：使用Promise包装setTimeout，确保等待存储操作完成
    return new Promise<void>((resolve, reject) => {
      setTimeout(async () => {
        try {
          console.log('开始执行批量删除的存储操作...');

          // 关键修复：串行执行存储操作，避免竞态条件
          const results = [];
          console.log('⏳ 开始串行执行存储操作...');

          for (const { group, tabsToRemove } of Object.values(groupsToUpdate)) {
            // 使用工具函数检查是否应该自动删除标签组
            if (shouldAutoDeleteAfterMultipleTabRemoval(group, tabsToRemove)) {
              console.log(`🗑️  准备删除空标签组: ${group.name} (${group.id})`);
              await dispatch(deleteGroup(group.id)).unwrap();
              console.log(`✅ 删除空标签组完成: ${group.id}`);
              results.push({ action: 'delete', groupId: group.id });
            } else {
              // 否则更新标签组，移除这些标签页
              const updatedTabs = group.tabs.filter(t => !tabsToRemove.includes(t.id));
              const updatedGroup = {
                ...group,
                tabs: updatedTabs,
                updatedAt: new Date().toISOString()
              };
              console.log(`📝 准备更新标签组: ${group.name} (${group.id}), 剩余标签页: ${updatedTabs.length}`);
              await dispatch(updateGroup(updatedGroup)).unwrap();
              console.log(`✅ 更新标签组完成: ${group.id}, 剩余标签页: ${updatedTabs.length}`);
              results.push({ action: 'update', groupId: group.id, remainingTabs: updatedTabs.length });
            }
          }

          console.log('✅ 所有存储操作串行执行完成');

          // 显示详细的操作结果
          console.log('📊 批量删除操作结果:');
          results.forEach((result, index) => {
            if (result.action === 'delete') {
              console.log(`  ${index + 1}. 删除标签组: ${result.groupId}`);
            } else {
              console.log(`  ${index + 1}. 更新标签组: ${result.groupId}, 剩余: ${result.remainingTabs} 个标签页`);
            }
          });

          // 显示成功提示
          showToast(`成功删除 ${matchingTabs.length} 个标签页`, 'success');
          console.log(`🎉 所有批量删除操作已完成并保存到存储 (处理了 ${results.length} 个标签组)`);

          resolve();
        } catch (error) {
          console.error('❌ 批量删除存储操作失败:', error);
          showToast('删除操作失败，请重试', 'error');

          // 详细的错误信息
          if (error instanceof Error) {
            console.error('错误详情:', error.message);
            console.error('错误堆栈:', error.stack);
          }

          reject(error);
        }
      }, 50); // 小延迟确保 UI 先更新
    });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-base font-medium text-gray-900 dark:text-gray-100">搜索结果 ({matchingTabs.length})</h3>
        {matchingTabs.length > 0 && (
          <div className="flex items-center space-x-2">
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
            <button
              onClick={() => showConfirm({
                title: '删除确认',
                message: `确定要删除所有搜索结果中的 ${matchingTabs.length} 个标签页吗？此操作不可撤销。`,
                type: 'danger',
                confirmText: '删除',
                cancelText: '取消',
                onConfirm: handleDeleteAllSearchResults,
                onCancel: () => { }
              })}
              className="text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 text-xs hover:underline flex items-center"
              title="删除所有搜索到的标签页"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              删除全部
            </button>
          </div>
        )}
      </div>
      {/* 搜索结果强制使用单栏布局显示 */}
      <div className="space-y-0.5 group">
        {matchingTabs.map(tabInfo => (
          <React.Fragment key={tabInfo.tab.id}>
            {renderTabItem(tabInfo)}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
};

export default SearchResultList;
