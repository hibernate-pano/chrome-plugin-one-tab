import React, { useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { TabGroup as TabGroupType } from '@/types/tab';
import { useAppDispatch } from '@/store/hooks';
import { updateGroupNameAndSync, deleteGroup, updateGroup } from '@/store/slices/tabSlice';
import { SortableTab } from './SortableTab';
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable';

interface SortableTabGroupProps {
  group: TabGroupType;
  index: number;
}

export const SortableTabGroup: React.FC<SortableTabGroupProps> = ({ group, index }) => {
  const dispatch = useAppDispatch();
  const [isExpanded, setIsExpanded] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [groupName, setGroupName] = useState(group.name);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    isDragging,
  } = useSortable({
    id: `group-${group.id}`,
    data: {
      type: 'group',
      group,
      index
    }
  });

  // 简化的样式，专注于基本功能
  const style = {
    transform: CSS.Transform.toString(transform),
    opacity: isDragging ? 0.6 : 1,
    position: 'relative' as const,
  };

  const handleToggleExpand = () => {
    setIsExpanded(!isExpanded);
  };

  const handleEditName = () => {
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
    dispatch(deleteGroup(group.id));
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

  // Create a list of sortable tab IDs
  const tabIds = group.tabs.map(tab => `${group.id}-tab-${tab.id}`);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`bg-white rounded-lg border border-gray-200 overflow-hidden select-none ${isDragging ? 'border-gray-400' : ''}`}
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
            title={isExpanded ? "折叠标签组" : "展开标签组"}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className={`h-4 w-4 ${isExpanded ? 'rotate-0' : '-rotate-90'}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {isEditing ? (
            <input
              type="text"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
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
            onClick={handleDeleteGroup}
            className="text-gray-400 hover:text-red-500 p-1 rounded hover:bg-gray-200"
            title="删除标签组"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
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
