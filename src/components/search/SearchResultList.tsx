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
          <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 empty-state-default-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        }
        title="没有找到匹配的标签"
        description={`没有找到包含"${searchQuery}"的标签页，请尝试其他关键词。`}
        action={
          <div className="text-xs theme-text-muted space-y-1">
            <div>小提示：</div>
            <ul className="list-disc list-inside space-y-0.5 text-left">
              <li>支持搜索标题或 URL 关键词</li>
              <li>尝试更短的关键词或检查大小写</li>
              <li>可在设置里导入/同步以获取更多结果</li>
            </ul>
          </div>
        }
        className="h-40"
      />
    );
  }

  const handleOpenTab = (tab: Tab, group: TabGroup) => {
    if (!group.isLocked) {
      if (shouldAutoDeleteAfterTabRemoval(group, tab.id)) {
        dispatch({ type: 'tabs/deleteGroup/fulfilled', payload: group.id });
        dispatch(deleteGroup(group.id))
          .then(() => {
            console.log(`自动删除空标签组: ${group.name} (ID: ${group.id})`);
          })
          .catch(error => {
            console.error('删除标签组失败:', error);
          });
      } else {
        const updatedTabs = group.tabs.filter(t => t.id !== tab.id);
        const updatedGroup = {
          ...group,
          tabs: updatedTabs,
          updatedAt: new Date().toISOString()
        };
        dispatch({ type: 'tabs/updateGroup/fulfilled', payload: updatedGroup });
        dispatch(updateGroup(updatedGroup))
          .then(() => {
            console.log(`更新标签组: ${group.name}, 剩余标签页: ${updatedTabs.length}`);
          })
          .catch(error => {
            console.error('更新标签组失败:', error);
          });
      }
    }

    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'OPEN_TAB',
        data: { url: tab.url }
      });
    }, 50);
  };

  const handleDeleteTab = (tab: Tab, group: TabGroup) => {
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

  // 提取域名显示
  const getDisplayUrl = (url: string) => {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.replace('www.', '');
    } catch {
      return url;
    }
  };

  const renderTabItem = ({ tab, group }: { tab: Tab; group: TabGroup }) => (
    <div className="tab-item group/tab">
      {/* Favicon */}
      <SafeFavicon src={tab.favicon} alt="" className="tab-item-favicon" />

      {/* 标题和 URL */}
      <div className="flex-1 min-w-0 flex items-center gap-3">
        <a
          href="#"
          className="tab-item-title tab-item-title-hover transition-colors"
          onClick={(e) => {
            e.preventDefault();
            handleOpenTab(tab, group);
          }}
          title={tab.title}
        >
          <HighlightText text={tab.title} highlight={searchQuery} />
        </a>
        <span className="tab-item-url hidden sm:block">
          {getDisplayUrl(tab.url)}
        </span>
      </div>

      {/* 操作按钮 */}
      <div className="tab-item-actions">
        <button
          onClick={() => handleDeleteTab(tab, group)}
          className="btn-icon p-1 tab-item-delete-btn"
          title="删除标签页"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );

  const handleRestoreAllSearchResults = () => {
    if (matchingTabs.length === 0) return;

    const urls = matchingTabs.map(({ tab }) => tab.url);

    const groupsToUpdate = matchingTabs.reduce((acc, { tab, group }) => {
      if (group.isLocked) return acc;

      if (!acc[group.id]) {
        acc[group.id] = { group, tabsToRemove: [] };
      }
      acc[group.id].tabsToRemove.push(tab.id);
      return acc;
    }, {} as Record<string, { group: TabGroup; tabsToRemove: string[] }>);

    Object.values(groupsToUpdate).forEach(({ group, tabsToRemove }) => {
      if (tabsToRemove.length === group.tabs.length) {
        dispatch({ type: 'tabs/deleteGroup/fulfilled', payload: group.id });
      } else {
        const updatedTabs = group.tabs.filter(t => !tabsToRemove.includes(t.id));
        const updatedGroup = {
          ...group,
          tabs: updatedTabs,
          updatedAt: new Date().toISOString()
        };
        dispatch({ type: 'tabs/updateGroup/fulfilled', payload: updatedGroup });
      }
    });

    setTimeout(() => {
      Object.values(groupsToUpdate).forEach(({ group, tabsToRemove }) => {
        if (tabsToRemove.length === group.tabs.length) {
          dispatch(deleteGroup(group.id))
            .then(() => console.log(`删除标签组: ${group.id}`))
            .catch(error => console.error('删除标签组失败:', error));
        } else {
          const updatedTabs = group.tabs.filter(t => !tabsToRemove.includes(t.id));
          const updatedGroup = {
            ...group,
            tabs: updatedTabs,
            updatedAt: new Date().toISOString()
          };
          dispatch(updateGroup(updatedGroup))
            .then(() => console.log(`更新标签组: ${group.id}, 剩余标签页: ${updatedTabs.length}`))
            .catch(error => console.error('更新标签组失败:', error));
        }
      });

      chrome.runtime.sendMessage({
        type: 'OPEN_TABS',
        data: { urls }
      });
    }, 100);
  };

  const handleDeleteAllSearchResults = async () => {
    if (matchingTabs.length === 0) return;

    const groupsToUpdate = matchingTabs.reduce((acc, { tab, group }) => {
      if (group.isLocked) return acc;

      if (!acc[group.id]) {
        acc[group.id] = { group, tabsToRemove: [] };
      }
      acc[group.id].tabsToRemove.push(tab.id);
      return acc;
    }, {} as Record<string, { group: TabGroup; tabsToRemove: string[] }>);

    Object.values(groupsToUpdate).forEach(({ group, tabsToRemove }) => {
      if (shouldAutoDeleteAfterMultipleTabRemoval(group, tabsToRemove)) {
        dispatch({ type: 'tabs/deleteGroup/fulfilled', payload: group.id });
      } else {
        const updatedTabs = group.tabs.filter(t => !tabsToRemove.includes(t.id));
        const updatedGroup = {
          ...group,
          tabs: updatedTabs,
          updatedAt: new Date().toISOString()
        };
        dispatch({ type: 'tabs/updateGroup/fulfilled', payload: updatedGroup });
      }
    });

    return new Promise<void>((resolve, reject) => {
      setTimeout(async () => {
        try {
          const results = [];

          for (const { group, tabsToRemove } of Object.values(groupsToUpdate)) {
            if (shouldAutoDeleteAfterMultipleTabRemoval(group, tabsToRemove)) {
              await dispatch(deleteGroup(group.id)).unwrap();
              results.push({ action: 'delete', groupId: group.id });
            } else {
              const updatedTabs = group.tabs.filter(t => !tabsToRemove.includes(t.id));
              const updatedGroup = {
                ...group,
                tabs: updatedTabs,
                updatedAt: new Date().toISOString()
              };
              await dispatch(updateGroup(updatedGroup)).unwrap();
              results.push({ action: 'update', groupId: group.id, remainingTabs: updatedTabs.length });
            }
          }

          showToast(`成功删除 ${matchingTabs.length} 个标签页`, 'success');
          resolve();
        } catch (error) {
          console.error('批量删除存储操作失败:', error);
          showToast('删除操作失败，请重试', 'error');
          reject(error);
        }
      }, 50);
    });
  };

  return (
    <div className="tab-group-card animate-in group/card">
      {/* 搜索结果头部 - 与标签组头部样式一致 */}
      <div className="tab-group-header">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          {/* 搜索图标 */}
          <div className="p-1 -ml-1">
            <svg className="w-4 h-4 theme-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>

          {/* 标题 */}
          <h3 className="tab-group-title truncate">
            搜索结果
          </h3>

          {/* 数量徽章 */}
          <span className="tab-group-count flex-shrink-0">
            {matchingTabs.length}
          </span>
        </div>

        {/* 操作按钮 */}
        {matchingTabs.length > 0 && (
          <div className="flex items-center gap-1 opacity-0 group-hover/card:opacity-100 transition-opacity duration-150">
            {/* 恢复全部 */}
            <button
              onClick={handleRestoreAllSearchResults}
              className="btn-icon p-1.5 tab-group-action-accent"
              title="恢复所有搜索到的标签页"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
              </svg>
            </button>

            {/* 删除全部 */}
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
              className="btn-icon p-1.5 tab-group-action-danger"
              title="删除所有搜索到的标签页"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* 标签列表 - 与标签组内容样式一致 */}
      <div className="tab-group-tabs-container">
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
