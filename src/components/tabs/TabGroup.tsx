import React, { useState, useCallback, useEffect, memo } from 'react';
import { useAppDispatch } from '@/app/store/hooks';
import { updateGroupNameAndSync, toggleGroupLockAndSync, deleteGroup, updateGroup } from '@/features/tabs/store/tabGroupsSlice';
import { TabGroup as TabGroupType, Tab } from '@/types/tab';
import { useDebounce, useSmartCache } from '@/shared/hooks/useMemoryOptimization';
import { useComponentCleanup } from '@/shared/hooks/useComponentCleanup';
import { componentHoverStyles, getInteractionStyles } from '@/shared/utils/hoverEffects';
import { cn } from '@/shared/utils/cn';

interface TabGroupProps {
  group: TabGroupType;
  onDelete?: () => void;
  onSelect?: () => void;
}

/**
 * 标签组组件
 * 使用React.memo优化渲染性能，只有在必要时才重新渲染
 */
export const TabGroup: React.FC<TabGroupProps> = memo(({ group, onDelete, onSelect }) => {
  const dispatch = useAppDispatch();
  const { addCleanupTask } = useComponentCleanup(`TabGroup-${group.id}`);

  // 使用智能缓存存储组件状态
  const { get: getCachedState, set: setCachedState } = useSmartCache<string, any>(50, 10 * 60 * 1000);

  const [isEditing, setIsEditing] = useState(false);
  const [newName, setNewName] = useState(group.name);

  // 从缓存或localStorage获取折叠状态
  const getInitialExpandedState = useCallback(() => {
    const cacheKey = `expanded_${group.id}`;
    const cached = getCachedState(cacheKey);
    if (cached !== undefined) return cached;

    const savedState = localStorage.getItem(`tabGroup_${group.id}_expanded`);
    const state = savedState !== null ? JSON.parse(savedState) : true;
    setCachedState(cacheKey, state);
    return state;
  }, [group.id, getCachedState, setCachedState]);

  const [isExpanded, setIsExpanded] = useState(getInitialExpandedState);

  // 防抖的名称更新函数
  const debouncedUpdateName = useDebounce(
    useCallback((name: string) => {
      dispatch(updateGroupNameAndSync({ groupId: group.id, newName: name }));
    }, [dispatch, group.id]),
    500
  );

  // 当组ID变化时，更新折叠状态
  useEffect(() => {
    // 从localStorage获取该组的折叠状态
    const savedState = localStorage.getItem(`tabGroup_${group.id}_expanded`);
    if (savedState !== null) {
      setIsExpanded(JSON.parse(savedState));
    }
  }, [group.id]);

  // 使用useCallback记忆化回调函数，避免不必要的重新创建
  const handleNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setNewName(e.target.value);
  }, []);

  const handleNameSubmit = useCallback(() => {
    if (newName.trim() !== '') {
      dispatch(updateGroupNameAndSync({ groupId: group.id, name: newName.trim() }));
      setIsEditing(false);
    }
  }, [dispatch, group.id, newName]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleNameSubmit();
    } else if (e.key === 'Escape') {
      setNewName(group.name);
      setIsEditing(false);
    }
  }, [handleNameSubmit, group.name]);

  const handleDelete = useCallback(() => {
    if (window.confirm('确定要删除这个标签组吗？')) {
      dispatch(deleteGroup(group.id));
    }
  }, [dispatch, group.id]);

  const handleToggleLock = useCallback(() => {
    dispatch(toggleGroupLockAndSync(group.id));
  }, [dispatch, group.id]);

  // 保存折叠状态到localStorage
  const handleToggleExpand = useCallback(() => {
    const newExpandedState = !isExpanded;
    setIsExpanded(newExpandedState);
    localStorage.setItem(`tabGroup_${group.id}_expanded`, JSON.stringify(newExpandedState));
  }, [isExpanded, group.id]);

  /**
   * 打开标签组中的所有标签页
   * 如果标签组未锁定，则在打开后删除该标签组
   */
  const handleOpenAllTabs = useCallback(() => {
    // 直接从group.tabs中提取URL列表，不需要嵌套useMemo
    const urls = group.tabs.map(tab => tab.url);

    // 如果标签组没有锁定，先在UI中删除标签组
    if (!group.isLocked) {
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
    }

    // 最后发送消息给后台脚本打开标签页
    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'OPEN_TABS',
        data: { urls }
      });
    }, 50); // 小延迟确保 UI 先更新
  }, [dispatch, group.id, group.isLocked, group.tabs]);

  // 处理删除单个标签
  const handleDeleteTab = useCallback((tabId: string) => {
    const updatedTabs = group.tabs.filter(t => t.id !== tabId);
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
  }, [dispatch, group]);

  // 使用useCallback记忆化handleOpenTab函数
  const handleOpenTab = useCallback((tab: Tab) => {
    // 如果标签组没有锁定，先从标签组中移除该标签页
    if (!group.isLocked) {
      // 如果标签组只有一个标签页，则删除整个标签组
      if (group.tabs.length === 1) {
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
  }, [dispatch, group]);

  return (
    <div
      className={cn(
        "mb-4 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm hover:shadow-md transition-all duration-200",
        "overflow-hidden focus-within:ring-2 focus-within:ring-blue-500 focus-within:ring-offset-2",
        componentHoverStyles.tabGroup
      )}
      role="region"
      aria-labelledby={`group-title-${group.id}`}
      aria-describedby={`group-description-${group.id}`}
    >
      {/* 卡片头部 - 重新设计 */}
      <div className="relative">
        {/* 状态指示条 */}
        <div className={cn(
          "absolute top-0 left-0 right-0 h-1",
          group.isLocked
            ? "bg-gradient-to-r from-yellow-400 to-orange-400"
            : group.syncStatus === 'synced'
            ? "bg-gradient-to-r from-green-400 to-emerald-400"
            : group.syncStatus === 'pending'
            ? "bg-gradient-to-r from-blue-400 to-indigo-400"
            : "bg-gradient-to-r from-gray-300 to-gray-400"
        )}></div>

        {/* 背景渐变 */}
        <div className={cn(
          "absolute inset-0",
          group.isLocked
            ? "bg-gradient-to-r from-yellow-50 to-orange-50 dark:from-yellow-900/20 dark:to-orange-900/20"
            : "bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20"
        )}></div>

        {/* 头部内容 */}
        <div className="relative flex items-center p-4">
          {/* 左侧：展开按钮和标签组信息 */}
          <div className="flex items-center space-x-3 flex-grow min-w-0">
            <button
              onClick={handleToggleExpand}
              className={cn(
                "flex-shrink-0 w-8 h-8 rounded-lg bg-white dark:bg-gray-700 shadow-sm border border-gray-200 dark:border-gray-600",
                "flex items-center justify-center text-gray-500 dark:text-gray-400",
                "hover:bg-gray-50 dark:hover:bg-gray-600 hover:text-blue-600 dark:hover:text-blue-400",
                "transition-all duration-200",
                getInteractionStyles({ focus: true })
              )}
              title={isExpanded ? '折叠标签组' : '展开标签组'}
              aria-label={isExpanded ? '折叠标签组' : '展开标签组'}
              aria-expanded={isExpanded}
              aria-controls={`group-content-${group.id}`}
            >
              <svg
                className={cn(
                  "w-4 h-4 transition-transform duration-200",
                  isExpanded ? 'rotate-180' : ''
                )}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {/* 标签组信息 */}
            <div className="flex-grow min-w-0">
              {isEditing ? (
                <input
                  type="text"
                  value={newName}
                  onChange={handleNameChange}
                  onBlur={handleNameSubmit}
                  onKeyDown={handleKeyDown}
                  className="w-full px-3 py-2 text-lg font-semibold bg-white dark:bg-gray-700 border border-blue-300 dark:border-blue-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoFocus
                />
              ) : (
                <div>
                  <h3
                    id={`group-title-${group.id}`}
                    className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate"
                  >
                    {group.name}
                  </h3>
                  <div
                    id={`group-description-${group.id}`}
                    className="flex items-center space-x-3 mt-1 flex-wrap gap-y-1"
                  >
                    <span className="inline-flex items-center text-sm text-gray-600 dark:text-gray-400">
                      <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                      </svg>
                      {group.tabs.length} 个标签页
                    </span>

                    <span className="inline-flex items-center text-sm text-gray-500 dark:text-gray-500">
                      <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                      {new Date(group.createdAt).toLocaleDateString()}
                    </span>

                    {/* 状态指示器 */}
                    <div className="flex items-center space-x-2">
                      {group.isLocked && (
                        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-200">
                          <svg className="w-3 h-3 mr-1" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                          </svg>
                          已锁定
                        </span>
                      )}

                      {/* 同步状态指示器 */}
                      {group.syncStatus === 'synced' && (
                        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-200">
                          <svg className="w-3 h-3 mr-1" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                          </svg>
                          已同步
                        </span>
                      )}

                      {group.syncStatus === 'pending' && (
                        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200">
                          <svg className="w-3 h-3 mr-1 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                          同步中
                        </span>
                      )}

                      {group.syncStatus === 'error' && (
                        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-200">
                          <svg className="w-3 h-3 mr-1" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                          </svg>
                          同步失败
                        </span>
                      )}

                      {/* 本地标签组指示器 */}
                      {!group.syncStatus && (
                        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                          <svg className="w-3 h-3 mr-1" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM3 10a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6zM14 9a1 1 0 00-1 1v6a1 1 0 001 1h2a1 1 0 001-1v-6a1 1 0 00-1-1h-2z" clipRule="evenodd" />
                          </svg>
                          本地
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
          {/* 右侧：操作按钮 */}
          <div className="flex items-center space-x-2">
            {/* 打开全部按钮 */}
            <button
              onClick={handleOpenAllTabs}
              className={cn(
                "px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg",
                "transition-all duration-200 shadow-sm hover:shadow-md",
                "flex items-center space-x-2",
                getInteractionStyles({ focus: true })
              )}
              title="打开所有标签页"
              aria-label={`打开 ${group.name} 中的所有 ${group.tabs.length} 个标签页`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
              <span>恢复全部</span>
            </button>

            {/* 更多操作按钮 */}
            <div className="flex items-center space-x-1">
              <button
                onClick={() => !group.isLocked && setIsEditing(true)}
                className={cn(
                  "w-8 h-8 rounded-lg bg-white dark:bg-gray-700 shadow-sm border border-gray-200 dark:border-gray-600",
                  "flex items-center justify-center text-gray-500 dark:text-gray-400",
                  "hover:bg-gray-50 dark:hover:bg-gray-600 hover:text-blue-600 dark:hover:text-blue-400",
                  "transition-all duration-200",
                  getInteractionStyles({ focus: true }),
                  group.isLocked && "opacity-50 cursor-not-allowed"
                )}
                title={group.isLocked ? '锁定的标签组不能重命名' : '重命名标签组'}
                disabled={group.isLocked}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>

              <button
                onClick={handleToggleLock}
                className={cn(
                  "w-8 h-8 rounded-lg bg-white dark:bg-gray-700 shadow-sm border border-gray-200 dark:border-gray-600",
                  "flex items-center justify-center",
                  "hover:bg-gray-50 dark:hover:bg-gray-600",
                  "transition-all duration-200",
                  getInteractionStyles({ focus: true }),
                  group.isLocked
                    ? "text-yellow-600 dark:text-yellow-400 hover:text-yellow-700 dark:hover:text-yellow-300"
                    : "text-gray-500 dark:text-gray-400 hover:text-yellow-600 dark:hover:text-yellow-400"
                )}
                title={group.isLocked ? '解锁标签组' : '锁定标签组'}
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  {group.isLocked ? (
                    <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                  ) : (
                    <path fillRule="evenodd" d="M3 7a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7zm2 0v8h10V7H5z" clipRule="evenodd" />
                  )}
                </svg>
              </button>

              {!group.isLocked && (
                <button
                  onClick={handleDelete}
                  className={cn(
                    "w-8 h-8 rounded-lg bg-white dark:bg-gray-700 shadow-sm border border-gray-200 dark:border-gray-600",
                    "flex items-center justify-center text-gray-500 dark:text-gray-400",
                    "hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-500 dark:hover:text-red-400",
                    "transition-all duration-200",
                    getInteractionStyles({ focus: true })
                  )}
                  title="删除标签组"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 标签页内容区域 - 重新设计 */}
      <div
        id={`group-content-${group.id}`}
        className={cn(
          "transition-all duration-300 ease-in-out overflow-hidden",
          isExpanded ? "max-h-96 opacity-100" : "max-h-0 opacity-0"
        )}
        aria-hidden={!isExpanded}
      >
        <div className="p-4 bg-gray-50 dark:bg-gray-900/50">
          <div
            className="space-y-2"
            role="list"
            aria-label={`${group.name} 中的标签页`}
          >
            {group.tabs.map((tab, index) => (
              <div
                key={tab.id}
                className={cn(
                  "group relative bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700",
                  "hover:border-blue-300 dark:hover:border-blue-600 hover:shadow-sm",
                  "transition-all duration-200 focus-within:ring-2 focus-within:ring-blue-500 focus-within:ring-offset-1",
                  componentHoverStyles.tabItem
                )}
                role="listitem"
                aria-label={`标签页 ${index + 1}: ${tab.title || 'Untitled'}`}
              >
                <div
                  className="flex items-center p-3 cursor-pointer focus:outline-none"
                  onClick={() => handleOpenTab(tab)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleOpenTab(tab);
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`打开标签页: ${tab.title || 'Untitled'}`}
                >
                  {/* 左侧：序号和图标 */}
                  <div className="flex items-center space-x-3 flex-shrink-0">
                    <div className="w-6 h-6 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-xs font-medium text-gray-600 dark:text-gray-400">
                      {index + 1}
                    </div>
                    <div className="relative">
                      <img
                        src={tab.favicon || '/icon16.png'}
                        alt=""
                        className="w-5 h-5 rounded"
                        onError={(e) => {
                          e.currentTarget.src = '/icon16.png';
                        }}
                      />
                      {/* 网站类型指示器 */}
                      {tab.url.includes('github.com') && (
                        <div className="absolute -top-1 -right-1 w-3 h-3 bg-gray-900 rounded-full"></div>
                      )}
                      {tab.url.includes('stackoverflow.com') && (
                        <div className="absolute -top-1 -right-1 w-3 h-3 bg-orange-500 rounded-full"></div>
                      )}
                    </div>
                  </div>

                  {/* 中间：标签信息 */}
                  <div className="flex-1 min-w-0 mx-3">
                    <div className="flex items-center space-x-2">
                      <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                        {tab.title || 'Untitled'}
                      </h4>
                      {/* 标签页状态指示器 */}
                      {tab.url.startsWith('https://') && (
                        <svg className="w-3 h-3 text-green-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M2.166 4.999A11.954 11.954 0 0010 1.944 11.954 11.954 0 0017.834 5c.11.65.166 1.32.166 2.001 0 5.225-3.34 9.67-8 11.317C5.34 16.67 2 12.225 2 7c0-.682.057-1.35.166-2.001zm11.541 3.708a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                        </svg>
                      )}
                    </div>
                    <div className="flex items-center space-x-2 mt-1">
                      <p className="text-xs text-gray-500 dark:text-gray-400 truncate flex-1">
                        {tab.url}
                      </p>
                      {/* 域名标签 */}
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 flex-shrink-0">
                        {new URL(tab.url).hostname.replace('www.', '')}
                      </span>
                    </div>
                  </div>

                  {/* 右侧：操作按钮 */}
                  <div className="flex items-center space-x-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleOpenTab(tab);
                      }}
                      className={cn(
                        "w-7 h-7 rounded-md bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400",
                        "hover:bg-blue-100 dark:hover:bg-blue-900/50 flex items-center justify-center",
                        "transition-colors duration-200",
                        getInteractionStyles({ focus: true })
                      )}
                      title="打开标签页"
                      aria-label={`打开标签页: ${tab.title || 'Untitled'}`}
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                    </button>

                    {!group.isLocked && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteTab(tab.id);
                        }}
                        className={cn(
                          "w-7 h-7 rounded-md bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400",
                          "hover:bg-red-100 dark:hover:bg-red-900/50 flex items-center justify-center",
                          "transition-colors duration-200",
                          getInteractionStyles({ focus: true })
                        )}
                        title="删除标签页"
                        aria-label={`删除标签页: ${tab.title || 'Untitled'}`}
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  // 优化重渲染逻辑，只有在以下情况下才重新渲染：
  // 1. 标签组ID变化
  // 2. 标签组名称变化
  // 3. 标签组锁定状态变化
  // 4. 标签组内的标签数量变化
  // 5. 标签组内的标签内容变化（通过比较最后更新时间和标签ID列表）

  // 基本属性比较
  const basicPropsEqual =
    prevProps.group.id === nextProps.group.id &&
    prevProps.group.name === nextProps.group.name &&
    prevProps.group.isLocked === nextProps.group.isLocked &&
    prevProps.group.tabs.length === nextProps.group.tabs.length &&
    prevProps.group.updatedAt === nextProps.group.updatedAt;

  // 如果基本属性不相等，则需要重新渲染
  if (!basicPropsEqual) return false;

  // 如果标签数量变化，则需要重新渲染（这已经在上面检查过了）
  // 如果标签ID列表变化，则需要重新渲染（更精确的检查）
  if (prevProps.group.tabs.length === nextProps.group.tabs.length) {
    // 只有当标签数量相同时才比较标签ID列表
    for (let i = 0; i < prevProps.group.tabs.length; i++) {
      if (prevProps.group.tabs[i].id !== nextProps.group.tabs[i].id) {
        return false; // 标签ID不同，需要重新渲染
      }
    }
  }

  // 所有检查都通过，不需要重新渲染
  return true;
});