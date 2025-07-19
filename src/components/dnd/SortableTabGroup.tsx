import React, { useState, useRef, useEffect, useCallback, memo, useMemo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { TabGroup as TabGroupType } from '@/types/tab';
import { useAppDispatch } from '@/app/store/hooks';
import { updateGroupName, deleteGroup, updateGroup } from '@/features/tabs/store/tabGroupsSlice';
import { SortableTab } from './SortableTab';
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable';
import { dragPerformanceMonitor } from '@/shared/utils/dragPerformance';
import { getDragStyles, getDragClassName, dragPresets } from '@/shared/utils/dragVisualFeedback';
import { cn } from '@/shared/utils/cn';
import '@/styles/drag-drop.css';

interface SortableTabGroupProps {
  group: TabGroupType;
  index: number;
}

const SortableTabGroupComponent: React.FC<SortableTabGroupProps> = ({ group, index }) => {
  const dispatch = useAppDispatch();
  const [isExpanded, setIsExpanded] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [groupName, setGroupName] = useState(group.name);
  const [isMarkedForDeletion, setIsMarkedForDeletion] = useState(false);

  // 使用ref跟踪组件是否已卸载
  const isMounted = useRef(true);

  useEffect(() => {
    // 组件挂载时设置为true
    isMounted.current = true;

    // 组件卸载时设置为false
    return () => {
      isMounted.current = false;
    };
  }, []);

  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({
    id: `group-${group.id}`,
    data: {
      type: 'group',
      group,
      index,
    },
  });

  // 使用统一的拖拽视觉反馈
  const dragState = isDragging ? 'dragging' : 'idle';
  const dragStyles = getDragStyles({
    ...dragPresets.group,
    state: dragState,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    ...dragStyles,
  };

  const dragClassName = getDragClassName({
    ...dragPresets.group,
    state: dragState,
  });

  const handleToggleExpand = () => {
    if (isMounted.current) {
      setIsExpanded(!isExpanded);
    }
  };

  const handleEditName = () => {
    if (isMounted.current) {
      setIsEditing(true);
    }
  };

  const handleSaveName = () => {
    if (!isMounted.current || isMarkedForDeletion) return;

    if (groupName.trim() !== group.name) {
      try {
        dispatch(updateGroupName({ groupId: group.id, name: groupName.trim() }));
      } catch (error) {
        console.error('更新标签组名称失败:', error);
      }
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isMounted.current || isMarkedForDeletion) return;

    if (e.key === 'Enter') {
      handleSaveName();
    } else if (e.key === 'Escape') {
      setGroupName(group.name);
      setIsEditing(false);
    }
  };


  const handleDeleteTab = useCallback((tabId: string) => {
    if (!isMounted.current || isMarkedForDeletion) return;

    try {
      const updatedTabs = group.tabs.filter(t => t.id !== tabId);
      if (updatedTabs.length === 0) {
        // Mark for deletion instead of dispatching immediately
        setIsMarkedForDeletion(true);
      } else {
        const updatedGroup = {
          ...group,
          tabs: updatedTabs,
          updatedAt: new Date().toISOString(),
        };
        dispatch(updateGroup(updatedGroup));
      }
    } catch (error) {
      console.error('删除标签页失败:', error);
    }
  }, [dispatch, group, isMounted, isMarkedForDeletion]);

  useEffect(() => {
    if (isMarkedForDeletion && isMounted.current) {
      const timer = setTimeout(() => {
        if (isMounted.current) { // Double check mount status before dispatch
          dispatch(deleteGroup(group.id));
        }
      }, 0); // Use a minimal delay
      return () => clearTimeout(timer);
    }
  }, [isMarkedForDeletion, dispatch, group.id, isMounted]);

  // If marked for deletion, render nothing to allow graceful unmount
  if (isMarkedForDeletion) {
    return null;
  }

  // Create a list of sortable tab IDs - 使用useMemo优化性能
  const tabIds = useMemo(() =>
    group.tabs.map(tab => `${group.id}-tab-${tab.id}`),
    [group.tabs, group.id]
  );
  
  // Ensure other handlers also check isMarkedForDeletion if they could conflict
  const safeHandleOpenTab = useCallback((tab: any) => {
    if (!isMounted.current || isMarkedForDeletion) return;
    // Original handleOpenTab logic
    try {
      chrome.tabs.create({ url: tab.url });
      const updatedTabs = group.tabs.filter(t => t.id !== tab.id);
      if (updatedTabs.length === 0) {
        setIsMarkedForDeletion(true); // Also mark for deletion here
      } else {
        const updatedGroup = {
          ...group,
          tabs: updatedTabs,
          updatedAt: new Date().toISOString(),
        };
        dispatch(updateGroup(updatedGroup));
      }
    } catch (error) {
      console.error('打开标签页失败:', error);
    }
  }, [dispatch, group, isMounted, isMarkedForDeletion]);

  const safeHandleDeleteGroup = useCallback(() => {
    if (!isMounted.current || isMarkedForDeletion) return;
    setIsMarkedForDeletion(true); // Mark for deletion
  }, [isMounted, isMarkedForDeletion]);

  // Update props for SortableTab to use the new safe handlers if necessary
  // For now, assuming SortableTab's internal isMounted check is sufficient for its direct actions
  // The main change is how SortableTabGroup handles its own deletion trigger.

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "bg-white rounded-lg border border-gray-200 overflow-hidden select-none group-item",
        dragClassName
      )}
      data-onboarding="tab-group"
    >
      <div
        className="flex items-center justify-between p-2 bg-gray-50 border-b border-gray-200 cursor-move"
        {...attributes}
        {...listeners}
      >
        <div className="flex items-center space-x-2 flex-1 min-w-0">
          <button
            onClick={handleToggleExpand}
            className="text-gray-500 hover:text-gray-700 p-1 rounded-full hover:bg-gray-200"
            title={isExpanded ? '折叠标签组' : '展开标签组'}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className={`h-4 w-4 ${isExpanded ? 'rotate-0' : '-rotate-90'}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
          {isEditing ? (
            <input
              type="text"
              value={groupName}
              onChange={e => isMounted.current && setGroupName(e.target.value)}
              onBlur={handleSaveName}
              onKeyDown={handleKeyDown}
              className="flex-1 px-2 py-1 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
            />
          ) : (
            <div
              className="flex-1 truncate font-medium text-gray-700 hover:text-gray-900"
              onClick={handleEditName}
              title={group.name}
            >
              {group.name}
            </div>
          )}
          <div className="text-xs text-gray-500 whitespace-nowrap">
            {group.tabs.length} 个标签页
          </div>
        </div>
        <div className="flex items-center space-x-1">
          <button
            onClick={safeHandleDeleteGroup}
            className="text-gray-400 hover:text-red-500 p-1 rounded hover:bg-gray-200"
            title="删除标签组"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </svg>
          </button>
        </div>
      </div>
      {isExpanded && (
        <div className="px-2 pt-1 space-y-1 group" style={{ overflow: 'hidden' }}>
          <SortableContext items={tabIds} strategy={rectSortingStrategy}>
            {group.tabs.map((tab, index) => (
              <SortableTab
                key={tab.id}
                tab={tab}
                groupId={group.id}
                index={index}
                handleOpenTab={safeHandleOpenTab}
                handleDeleteTab={handleDeleteTab}
              />
            ))}
          </SortableContext>
        </div>
      )}
    </div>
  );
};

// 使用memo优化性能，避免不必要的重新渲染
export const SortableTabGroup = memo(SortableTabGroupComponent);
export default SortableTabGroup;
