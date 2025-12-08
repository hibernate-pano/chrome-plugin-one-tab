import React, { useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { TabGroup as TabGroupType } from '@/types/tab';
import { useAppDispatch } from '@/store/hooks';
import { updateGroupNameAndSync, deleteGroup, updateGroup, toggleGroupLockAndSync } from '@/store/slices/tabSlice';
import { SimpleDraggableTab } from './SimpleDraggableTab';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';

interface SimpleDraggableTabGroupProps {
  group: TabGroupType;
  index: number;
}

export const SimpleDraggableTabGroup: React.FC<SimpleDraggableTabGroupProps> = ({ group, index }) => {
  const dispatch = useAppDispatch();
  const [isEditing, setIsEditing] = useState(false);
  const [groupName, setGroupName] = useState(group.name);

  // 禁用标签组拖拽功能 - 标签组应该保持固定位置
  const { setNodeRef } = useSortable({
    id: `group-${group.id}`,
    data: {
      type: 'group',
      group,
      index
    },
    disabled: true, // 禁用拖拽
  });

  // 由于禁用了拖拽，这些属性不再需要
  const attributes = {};
  const listeners = {};
  const transform = null;
  const transition = undefined;
  const isDragging = false;

  // 设置样式，提供清晰的拖拽反馈
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.7 : 1,
    zIndex: isDragging ? 999 : 'auto',
    position: 'relative' as const,
  };

  const handleEditName = () => {
    // 如果标签组已锁定，不允许编辑
    if (group.isLocked) {
      return;
    }
    setIsEditing(true);
  };

  const handleSaveName = () => {
    if (groupName.trim() !== group.name) {
      dispatch(updateGroupNameAndSync({ groupId: group.id, name: groupName.trim() }));
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSaveName();
    } else if (e.key === 'Escape') {
      setGroupName(group.name);
      setIsEditing(false);
    }
  };

  const handleDeleteGroup = () => {
    // 如果标签组已锁定，不允许删除
    if (group.isLocked) {
      return;
    }
    dispatch(deleteGroup(group.id));
  };

  // 处理锁定/解锁标签组
  const handleToggleLock = () => {
    dispatch(toggleGroupLockAndSync(group.id));
  };

  const handleOpenAllTabs = () => {
    // 安全检查
    if (!group.tabs || !Array.isArray(group.tabs)) {
      console.warn('Invalid group.tabs data:', group.tabs);
      return;
    }
    // 收集所有标签页的 URL
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
  };

  const handleOpenTab = (tab: any) => {
    // 打开标签页
    chrome.tabs.create({ url: tab.url });

    // 从标签组中删除该标签页
    const updatedTabs = group.tabs.filter(t => t.id !== tab.id);

    if (updatedTabs.length === 0) {
      // 如果标签组中没有剩余标签页，删除整个标签组
      dispatch(deleteGroup(group.id));
    } else {
      // 否则更新标签组
      const updatedGroup = {
        ...group,
        tabs: updatedTabs,
        updatedAt: new Date().toISOString()
      };
      dispatch(updateGroup(updatedGroup));
    }
  };

  const handleDeleteTab = (tabId: string) => {
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
  };

  // 安全检查并创建标签页ID列表，用于SortableContext
  if (!group.tabs || !Array.isArray(group.tabs)) {
    console.warn('Invalid group.tabs data in SimpleDraggableTabGroup:', group);
    return null;
  }
  const tabIds = group.tabs.map(tab => `${group.id}-tab-${tab.id}`);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden select-none group-item ${isDragging ? 'border-gray-400 dark:border-gray-500 dragging' : ''}`}
    >
      <div
        className="flex items-center justify-between p-2 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 cursor-move"
        {...attributes}
        {...listeners}
      >
        <div className="flex items-center space-x-2 flex-1 min-w-0">
          {isEditing ? (
            <input
              type="text"
              className="flex-1 min-w-0 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              onBlur={handleSaveName}
              onKeyDown={handleKeyDown}
              autoFocus
            />
          ) : (
            <div
              className="flex-1 min-w-0 truncate text-sm font-medium text-gray-900 dark:text-gray-100"
              onDoubleClick={handleEditName}
              title={group.name}
            >
              {group.name}
            </div>
          )}

          <div className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
            {group.tabs.length} 个标签页
          </div>
        </div>

        <div className="flex items-center space-x-1">
          <button
            onClick={handleOpenAllTabs}
            className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 text-xs hover:underline"
            title="打开所有标签页"
          >
            恢复全部
          </button>
          <button
            onClick={handleEditName}
            className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors ${group.isLocked ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed' : 'text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300'}`}
            title={group.isLocked ? '锁定的标签组不能重命名' : '重命名标签组'}
            disabled={group.isLocked}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>

          <button
            onClick={handleToggleLock}
            className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors ${group.isLocked ? 'text-yellow-500 dark:text-yellow-400' : 'text-gray-400 hover:text-yellow-500 dark:text-gray-500 dark:hover:text-yellow-400'}`}
            title={group.isLocked ? '解锁标签组' : '锁定标签组'}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
            </svg>
          </button>

          <button
            onClick={handleDeleteGroup}
            className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors ${group.isLocked ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed' : 'text-gray-400 hover:text-red-500 dark:text-gray-500 dark:hover:text-red-400'}`}
            title={group.isLocked ? '锁定的标签组不能删除' : '删除标签组'}
            disabled={group.isLocked}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>

      {group.tabs && Array.isArray(group.tabs) && (
        <div className="px-2 pt-2 pb-2 space-y-1 group tabs-container">
          <SortableContext items={tabIds} strategy={verticalListSortingStrategy}>
            {group.tabs.map((tab, index) => (
              <SimpleDraggableTab
                key={tab.id}
                tab={tab}
                groupId={group.id}
                index={index}
                handleOpenTab={handleOpenTab}
                handleDeleteTab={handleDeleteTab}
              />
            ))}
          </SortableContext>
        </div>
      )}
    </div>
  );
};
