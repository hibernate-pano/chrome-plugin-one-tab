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

  // 不再需要获取用户状态和设置

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
      try {
        // 如果标签组只有一个标签页，则删除整个标签组
        if (group.tabs.length === 1) {
          await dispatch(deleteGroup(group.id)).unwrap();
          console.log(`删除标签组: ${group.id}`);
        } else {
          // 否则更新标签组，移除该标签页
          const updatedTabs = group.tabs.filter(t => t.id !== tab.id);
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
    <div className="mb-2 transition-colors bg-white border border-gray-200 rounded-md shadow-sm pb-2">
      <div className="flex items-center p-2 bg-gray-50 border-b border-gray-200 rounded-t-md">
        <div className="flex items-center space-x-3 flex-grow">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-gray-500 hover:text-primary-600 transition-colors p-1 hover:bg-gray-100"
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
              className="border border-gray-300 rounded px-2 py-1 w-full text-sm"
              autoFocus
            />
          ) : (
            <h3
              className="text-base font-medium text-gray-900"
            >
              {group.name}
            </h3>
          )}
          <span className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded-full ml-1">
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
      {isExpanded && (
        <div className="px-2 pt-2 space-y-1 group">
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