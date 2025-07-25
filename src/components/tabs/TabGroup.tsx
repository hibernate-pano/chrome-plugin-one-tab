import React, { useState, useCallback, useEffect } from 'react';
import { useAppDispatch } from '@/store/hooks';
import { updateGroupNameAndSync, toggleGroupLockAndSync, deleteGroup, updateGroup, moveTabAndSync } from '@/store/slices/tabSlice';
import { DraggableTab } from '@/components/dnd/DraggableTab';
import { TabGroup as TabGroupType, Tab } from '@/types/tab';
import { shouldAutoDeleteAfterTabRemoval } from '@/utils/tabGroupUtils';

interface TabGroupProps {
  group: TabGroupType;
}

/**
 * 标签组组件
 * 使用React.memo优化渲染性能，只有在必要时才重新渲染
 */
export const TabGroup: React.FC<TabGroupProps> = React.memo(({ group }) => {
  const dispatch = useAppDispatch();

  const [isEditing, setIsEditing] = useState(false);
  const [newName, setNewName] = useState(group.name);

  // 从localStorage获取折叠状态的函数，使用useCallback记忆化
  const getInitialExpandedState = useCallback(() => {
    const savedState = localStorage.getItem(`tabGroup_${group.id}_expanded`);
    return savedState !== null ? JSON.parse(savedState) : true;
  }, [group.id]);

  const [isExpanded, setIsExpanded] = useState(getInitialExpandedState);

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

  // 使用useCallback记忆化handleOpenTab函数
  const handleOpenTab = useCallback((tab: Tab) => {
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
  }, [dispatch, group]);

  // 使用useCallback记忆化handleMoveTab函数
  const handleMoveTab = useCallback((sourceGroupId: string, sourceIndex: number, targetGroupId: string, targetIndex: number) => {
    dispatch(moveTabAndSync({
      sourceGroupId,
      sourceIndex,
      targetGroupId,
      targetIndex
    }));
  }, [dispatch]);

  return (
    <div className="mb-2 transition-all duration-200 ease-in-out bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-sm pb-2 hover:shadow-md">
      <div className="flex items-center p-2 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 rounded-t-md">
        <div className="flex items-center space-x-3 flex-grow">
          <button
            onClick={handleToggleExpand}
            className="text-gray-500 hover:text-primary-600 transition-colors p-1 hover:bg-gray-100 group-action-button"
            title={isExpanded ? '折叠标签组' : '展开标签组'}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className={`h-5 w-5 expand-icon ${isExpanded ? 'expanded' : 'collapsed'}`}
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
          {isEditing ? (
            <input
              type="text"
              value={newName}
              onChange={handleNameChange}
              onBlur={handleNameSubmit}
              onKeyDown={handleKeyDown}
              className="border border-gray-300 rounded px-2 py-1 w-full text-sm"
              autoFocus
            />
          ) : (
            <h3
              className="text-base font-medium text-gray-900 dark:text-gray-100"
            >
              {group.name}
            </h3>
          )}
          <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-1.5 py-0.5 rounded-full ml-1">
            {group.tabs.length}
          </span>
        </div>
        <div className="flex items-center space-x-2 ml-auto">
          <button
            onClick={handleOpenAllTabs}
            className="text-blue-600 hover:text-blue-800 text-xs hover:underline"
            title="打开所有标签页"
          >
            恢复全部
          </button>
          <button
            onClick={() => !group.isLocked && setIsEditing(true)}
            className={`p-1 hover:bg-gray-100 transition-colors ${group.isLocked ? 'text-gray-300 cursor-not-allowed' : 'text-gray-500 hover:text-primary-600'}`}
            title={group.isLocked ? '锁定的标签组不能重命名' : '重命名标签组'}
            disabled={group.isLocked}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
            </svg>
          </button>
          <button
            onClick={handleToggleLock}
            className={`p-1 hover:bg-gray-100 transition-colors ${group.isLocked ? 'text-warning' : 'text-gray-500'} hover:text-warning`}
            title={group.isLocked ? '解锁标签组' : '锁定标签组'}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
            </svg>
          </button>
          {!group.isLocked && (
            <button
              onClick={handleDelete}
              className="p-1 hover:bg-gray-100 transition-colors text-gray-500 hover:text-red-500"
              title="删除标签组"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
            </button>
          )}
        </div>
      </div>
      <div className={`tab-group-content ${isExpanded ? 'expanded' : 'collapsed'}`}>
        <div className="px-2 pt-2 space-y-1 group tabs-container">
          {group.tabs.map((tab, index) => (
            <DraggableTab
              key={tab.id}
              tab={tab}
              groupId={group.id}
              index={index}
              moveTab={handleMoveTab}
              handleOpenTab={handleOpenTab}
              handleDeleteTab={useCallback((tabId) => {
                // 使用工具函数检查是否应该自动删除标签组
                if (shouldAutoDeleteAfterTabRemoval(group, tabId)) {
                  dispatch(deleteGroup(group.id));
                  console.log(`自动删除空标签组: ${group.name} (ID: ${group.id})`);
                } else {
                  const updatedTabs = group.tabs.filter(t => t.id !== tabId);
                  const updatedGroup = {
                    ...group,
                    tabs: updatedTabs,
                    updatedAt: new Date().toISOString()
                  };
                  dispatch(updateGroup(updatedGroup));
                  console.log(`从标签组删除标签页: ${group.name}, 剩余标签页: ${updatedTabs.length}`);
                }
              }, [dispatch, group])}
            />
          ))}
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