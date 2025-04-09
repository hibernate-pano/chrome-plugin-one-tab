import React, { useState } from 'react';
import { useAppDispatch } from '@/store/hooks';
import { updateGroupName, toggleGroupLock, deleteGroup, updateGroup, moveTab } from '@/store/slices/tabSlice';
import { DraggableTab } from '@/components/dnd/DraggableTab';
import { TabGroup as TabGroupType, Tab } from '@/types/tab';

interface TabGroupProps {
  group: TabGroupType;
}

export const TabGroup: React.FC<TabGroupProps> = ({ group }) => {
  const dispatch = useAppDispatch();

  const [isEditing, setIsEditing] = useState(false);
  const [newName, setNewName] = useState(group.name);
  const [isExpanded, setIsExpanded] = useState(true);

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setNewName(e.target.value);
  };

  const handleNameSubmit = () => {
    if (newName.trim() !== '') {
      dispatch(updateGroupName({ groupId: group.id, name: newName.trim() }));
      setIsEditing(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleNameSubmit();
    } else if (e.key === 'Escape') {
      setNewName(group.name);
      setIsEditing(false);
    }
  };

  const handleDelete = () => {
    if (window.confirm('确定要删除这个标签组吗？')) {
      dispatch(deleteGroup(group.id));
    }
  };

  const handleToggleLock = () => {
    dispatch(toggleGroupLock(group.id));
  };

  const handleOpenAllTabs = async () => {
    // 收集所有标签页的 URL
    const urls = group.tabs.map(tab => tab.url);

    // 如果标签组没有锁定，先删除标签组
    if (!group.isLocked) {
      try {
        // 先更新 Redux 状态和 Chrome 存储
        await dispatch(deleteGroup(group.id)).unwrap();
        console.log(`删除标签组: ${group.id}`);

        // 然后发送消息给后台脚本打开标签页
        chrome.runtime.sendMessage({
          type: 'OPEN_TABS',
          data: { urls }
        });
      } catch (error) {
        console.error('删除标签组失败:', error);
      }
    } else {
      // 如果标签组已锁定，直接打开标签页
      chrome.runtime.sendMessage({
        type: 'OPEN_TABS',
        data: { urls }
      });
    }
  };

  const handleOpenTab = async (tab: Tab) => {
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

  return (
    <div className="card-material overflow-hidden mb-4 transition-material">
      <div className="flex items-center justify-between p-4 bg-surface border-b border-gray-200">
        <div className="flex items-center space-x-2">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-gray-500 hover:text-gray-700 transition-material"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className={`h-5 w-5 transform transition-transform ${isExpanded ? 'rotate-0' : '-rotate-90'}`}
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
              className="input-material px-2 py-1 w-full"
              autoFocus
            />
          ) : (
            <h3
              className="text-lg font-medium cursor-pointer text-gray-900 transition-material"
              onDoubleClick={() => !group.isLocked && setIsEditing(true)}
            >
              {group.name}
            </h3>
          )}
          <span className="text-sm text-gray-500 transition-material">
            ({group.tabs.length} 个标签页)
          </span>
        </div>
        <div className="flex items-center space-x-2">
          <button
            onClick={handleOpenAllTabs}
            className="p-2 text-gray-500 hover:text-gray-700 transition-material rounded-full hover:bg-gray-100"
            title="打开所有标签页"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd" />
            </svg>
          </button>
          <button
            onClick={handleToggleLock}
            className={`p-2 rounded-full hover:bg-gray-100 transition-material ${group.isLocked ? 'text-warning' : 'text-gray-500'} hover:text-warning`}
            title={group.isLocked ? '解锁标签组' : '锁定标签组'}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
            </svg>
          </button>
          {!group.isLocked && (
            <button
              onClick={handleDelete}
              className="p-2 rounded-full hover:bg-gray-100 transition-material text-gray-500 hover:text-error"
              title="删除标签组"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {isExpanded && (
        <div className="divide-y divide-gray-200">
          {group.tabs.map((tab, index) => (
            <DraggableTab
              key={tab.id}
              tab={tab}
              groupId={group.id}
              index={index}
              moveTab={(sourceGroupId, sourceIndex, targetGroupId, targetIndex) => {
                dispatch(moveTab({ sourceGroupId, sourceIndex, targetGroupId, targetIndex }));
              }}
              handleOpenTab={handleOpenTab}
              handleDeleteTab={(tabId) => {
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
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
};