import React, { useState, useCallback } from 'react';
import { useAppDispatch } from '@/store/hooks';
import { updateGroupNameAndSync, toggleGroupLockAndSync, deleteGroup, updateGroup, moveTabAndSync } from '@/store/slices/tabSlice';
import { DraggableTab } from '@/components/dnd/DraggableTab';
import { TabGroup as TabGroupType, Tab } from '@/types/tab';
import { shouldAutoDeleteAfterTabRemoval } from '@/utils/tabGroupUtils';
import { useToast } from '@/contexts/ToastContext';
import { useEnhancedToast } from '@/utils/toastHelper';

interface TabGroupProps {
  group: TabGroupType;
}

// 图标组件
const EditIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
  </svg>
);

const LockIcon = ({ locked }: { locked: boolean }) => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    {locked ? (
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
    ) : (
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 10.5V6.75a4.5 4.5 0 119 0v3.75M3.75 21.75h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
    )}
  </svg>
);

const DeleteIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
  </svg>
);

const OpenAllIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
  </svg>
);

export const TabGroup: React.FC<TabGroupProps> = React.memo(({ group }) => {
  const dispatch = useAppDispatch();
  const { showConfirm } = useToast();
  const { showDeleteSuccess, showDeleteError, showRestoreSuccess, showRestoreError } = useEnhancedToast();

  const [isEditing, setIsEditing] = useState(false);
  const [newName, setNewName] = useState(group.name);
  const [isCollapsed, setIsCollapsed] = useState(false);

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
    showConfirm({
      title: '删除确认',
      message: '确定要删除这个标签组吗？',
      type: 'danger',
      confirmText: '删除',
      cancelText: '取消',
      onConfirm: () => {
        dispatch(deleteGroup(group.id))
          .unwrap()
          .then(() => {
            showDeleteSuccess(`已删除标签组 "${group.name}" (${group.tabs.length} 个标签页)`);
          })
          .catch(error => {
            showDeleteError(`删除标签组失败: ${error.message || '未知错误'}`);
          });
      },
      onCancel: () => { }
    });
  }, [dispatch, group.id, group.name, group.tabs.length, showConfirm, showDeleteSuccess, showDeleteError]);

  const handleToggleLock = useCallback(() => {
    dispatch(toggleGroupLockAndSync(group.id));
  }, [dispatch, group.id]);

  const handleOpenAllTabs = useCallback(() => {
    const tabsPayload = group.tabs.map(tab => ({
      url: tab.url,
      pinned: !!tab.pinned,
    }));

    if (!group.isLocked) {
      dispatch({ type: 'tabs/deleteGroup/fulfilled', payload: group.id });
      dispatch(deleteGroup(group.id))
        .unwrap()
        .then(() => {
          console.log(`删除标签组: ${group.id}`);
          showDeleteSuccess(`已恢复标签组 "${group.name}" 并删除原标签组`);
        })
        .catch(error => {
          console.error('删除标签组失败:', error);
          showDeleteError(`删除标签组失败: ${error.message || '未知错误'}`);
        });
    } else {
      showRestoreSuccess(group.tabs.length);
    }

    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'OPEN_TABS',
        data: { tabs: tabsPayload }
      });
    }, 50);
  }, [dispatch, group.id, group.isLocked, group.name, group.tabs, showDeleteSuccess, showDeleteError, showRestoreSuccess]);

  const handleOpenTab = useCallback((tab: Tab) => {
    if (!group.isLocked) {
      if (shouldAutoDeleteAfterTabRemoval(group, tab.id)) {
        dispatch({ type: 'tabs/deleteGroup/fulfilled', payload: group.id });
        dispatch(deleteGroup(group.id))
          .unwrap()
          .then(() => {
            console.log(`自动删除空标签组: ${group.name} (ID: ${group.id})`);
            showDeleteSuccess(`已恢复标签页并自动删除空标签组 "${group.name}"`);
          })
          .catch(error => {
            console.error('删除标签组失败:', error);
            showDeleteError(`删除标签组失败: ${error.message || '未知错误'}`);
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
          .unwrap()
          .then(() => {
            console.log(`更新标签组: ${group.name}, 剩余标签页: ${updatedTabs.length}`);
            showRestoreSuccess(1); // Restore 1 tab
          })
          .catch(error => {
            console.error('更新标签组失败:', error);
            showRestoreError(`更新标签组失败: ${error.message || '未知错误'}`);
          });
      }
    } else {
      showRestoreSuccess(1); // Restore 1 tab
    }

    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'OPEN_TAB',
        data: { url: tab.url, pinned: !!tab.pinned }
      });
    }, 50);
  }, [dispatch, group, showDeleteSuccess, showDeleteError, showRestoreSuccess, showRestoreError]);

  const handleMoveTab = useCallback((sourceGroupId: string, sourceIndex: number, targetGroupId: string, targetIndex: number) => {
    dispatch(moveTabAndSync({
      sourceGroupId,
      sourceIndex,
      targetGroupId,
      targetIndex
    }));
  }, [dispatch]);

  const handleDeleteTab = useCallback((tabId: string) => {
    if (shouldAutoDeleteAfterTabRemoval(group, tabId)) {
      dispatch(deleteGroup(group.id))
        .unwrap()
        .then(() => {
          showDeleteSuccess(`已删除标签组 "${group.name}" (最后一个标签页已删除)`);
        })
        .catch(error => {
          showDeleteError(`删除标签组失败: ${error.message || '未知错误'}`);
        });
      console.log(`自动删除空标签组: ${group.name} (ID: ${group.id})`);
    } else {
      const updatedTabs = group.tabs.filter(t => t.id !== tabId);
      const updatedGroup = {
        ...group,
        tabs: updatedTabs,
        updatedAt: new Date().toISOString()
      };
      dispatch(updateGroup(updatedGroup))
        .unwrap()
        .then(() => {
          showDeleteSuccess(`已从 "${group.name}" 删除标签页 (剩余 ${updatedTabs.length} 个)`);
        })
        .catch(error => {
          showDeleteError(`更新标签组失败: ${error.message || '未知错误'}`);
        });
      console.log(`从标签组删除标签页: ${group.name}, 剩余标签页: ${updatedTabs.length}`);
    }
  }, [dispatch, group, showDeleteSuccess, showDeleteError]);

  // 格式化时间
  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) return '今天';
    if (days === 1) return '昨天';
    if (days < 7) return `${days} 天前`;
    if (days < 30) return `${Math.floor(days / 7)} 周前`;
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  };

  return (
    <div
      className="tab-group-card animate-in group/card micro-interaction-card"
      role="region"
      aria-labelledby={`tab-group-title-${group.id}`}
    >
      {/* 标签组头部 */}
      <div className="tab-group-header">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          {/* 折叠按钮 */}
          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="btn-icon p-1 -ml-1 micro-interaction-button"
            aria-label={isCollapsed ? '展开标签组' : '折叠标签组'}
            aria-expanded={!isCollapsed}
          >
            <svg
              className={`w-4 h-4 transition-transform duration-300 ease-out ${isCollapsed ? '-rotate-90' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {/* 标题 */}
          {isEditing ? (
            <input
              type="text"
              value={newName}
              onChange={handleNameChange}
              onBlur={handleNameSubmit}
              onKeyDown={handleKeyDown}
              className="input py-1 px-2 text-sm font-medium flex-1"
              autoFocus
              aria-label="编辑标签组名称"
            />
          ) : (
            <h3
              id={`tab-group-title-${group.id}`}
              className="tab-group-title truncate cursor-pointer tab-group-title-hover transition-colors flat-interaction"
              onClick={() => !group.isLocked && setIsEditing(true)}
              title={group.isLocked ? group.name : '点击编辑名称'}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (!group.isLocked) setIsEditing(true);
                }
              }}
            >
              {group.name}
            </h3>
          )}

          {/* 数量徽章 */}
          <span 
            className="tab-group-count flex-shrink-0"
            aria-label={`包含 ${group.tabs.length} 个标签页`}
          >
            {group.tabs.length}
          </span>

          {/* 锁定图标 */}
          {group.isLocked && (
            <span 
              className="tab-group-lock-icon flex-shrink-0" 
              title="已锁定"
              aria-label="标签组已锁定"
            >
              <LockIcon locked={true} />
            </span>
          )}

          {/* 时间 */}
          <span className="tab-group-time hidden sm:block flex-shrink-0">
            {formatTime(group.createdAt)}
          </span>
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center gap-1 opacity-0 group-hover/card:opacity-100 transition-all duration-200 ease-out">
          {/* 恢复全部 */}
          <button
            onClick={handleOpenAllTabs}
            className="btn-icon p-1.5 tab-group-action-accent micro-interaction-button"
            title="恢复全部标签页"
            aria-label={`恢复全部 ${group.tabs.length} 个标签页`}
          >
            <OpenAllIcon />
          </button>

          {/* 编辑 */}
          {!group.isLocked && (
            <button
              onClick={() => setIsEditing(true)}
              className="btn-icon p-1.5 micro-interaction-button"
              title="重命名"
              aria-label="重命名标签组"
            >
              <EditIcon />
            </button>
          )}

          {/* 锁定/解锁 */}
          <button
            onClick={handleToggleLock}
            className={`btn-icon p-1.5 micro-interaction-button ${group.isLocked ? 'tab-group-lock-icon' : ''}`}
            title={group.isLocked ? '解锁' : '锁定'}
            aria-label={group.isLocked ? '解锁标签组' : '锁定标签组'}
          >
            <LockIcon locked={group.isLocked} />
          </button>

          {/* 删除 */}
          {!group.isLocked && (
            <button
              onClick={handleDelete}
              className="btn-icon p-1.5 tab-group-action-danger micro-interaction-button"
              title="删除标签组"
              aria-label="删除标签组"
            >
              <DeleteIcon />
            </button>
          )}
        </div>
      </div>

      {/* 标签列表 */}
      <div
        className={`transition-all duration-300 ease-out overflow-hidden ${
          isCollapsed ? 'max-h-0 opacity-0' : 'max-h-[2000px] opacity-100'
        }`}
        aria-hidden={isCollapsed}
      >
        <div className="tab-group-tabs-container">
          {group.tabs.map((tab, index) => (
            <DraggableTab
              key={tab.id}
              tab={tab}
              groupId={group.id}
              index={index}
              moveTab={handleMoveTab}
              handleOpenTab={handleOpenTab}
              handleDeleteTab={handleDeleteTab}
            />
          ))}
        </div>
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  const basicPropsEqual =
    prevProps.group.id === nextProps.group.id &&
    prevProps.group.name === nextProps.group.name &&
    prevProps.group.isLocked === nextProps.group.isLocked &&
    prevProps.group.tabs.length === nextProps.group.tabs.length &&
    prevProps.group.updatedAt === nextProps.group.updatedAt &&
    prevProps.group.createdAt === nextProps.group.createdAt;

  if (!basicPropsEqual) return false;

  if (prevProps.group.tabs.length === nextProps.group.tabs.length) {
    for (let i = 0; i < prevProps.group.tabs.length; i++) {
      const prevTab = prevProps.group.tabs[i];
      const nextTab = nextProps.group.tabs[i];

      if (
        prevTab.id !== nextTab.id ||
        prevTab.title !== nextTab.title ||
        prevTab.url !== nextTab.url ||
        prevTab.favicon !== nextTab.favicon
      ) {
        return false;
      }
    }
  }

  return true;
});
