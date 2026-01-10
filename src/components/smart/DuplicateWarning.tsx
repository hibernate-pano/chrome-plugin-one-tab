/**
 * 重复标签警告组件
 * 
 * 显示重复标签页列表，提供合并选项
 */

import React, { useState, useEffect } from 'react';
import { TabGroup } from '@/types/tab';
import { smartGroupService, DuplicateInfo } from '@/services/smartGroupService';
import { SafeFavicon } from '@/components/common/SafeFavicon';
import { useAppDispatch } from '@/store/hooks';
import { updateGroup, deleteGroup } from '@/store/slices/tabSlice';
import { useToast } from '@/contexts/ToastContext';
import { logSanitizer } from '@/utils/logSanitizer';

interface DuplicateWarningProps {
  groups: TabGroup[];
  onClose?: () => void;
  className?: string;
}

// 图标组件
const WarningIcon = () => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
  </svg>
);

const TrashIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
  </svg>
);

const CloseIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
  </svg>
);

/**
 * 单个重复项卡片
 */
const DuplicateCard: React.FC<{
  duplicate: DuplicateInfo;
  onRemoveDuplicate: (tabId: string, groupId: string) => void;
}> = ({ duplicate, onRemoveDuplicate }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const firstTab = duplicate.tabs[0].tab;

  return (
    <div className="border border-yellow-200 dark:border-yellow-800 rounded-lg overflow-hidden bg-yellow-50 dark:bg-yellow-900/20">
      {/* 头部 */}
      <div
        className="flex items-center gap-3 p-3 cursor-pointer hover:bg-yellow-100 dark:hover:bg-yellow-900/30 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <SafeFavicon src={firstTab.favicon} alt="" className="w-4 h-4 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{firstTab.title}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
            {duplicate.normalizedUrl}
          </p>
        </div>
        <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-200 dark:bg-yellow-800 text-yellow-800 dark:text-yellow-200">
          {duplicate.tabs.length} 个重复
        </span>
        <svg
          className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </div>

      {/* 展开的详情 */}
      {isExpanded && (
        <div className="border-t border-yellow-200 dark:border-yellow-800 p-2 space-y-1">
          {duplicate.tabs.map(({ tab, groupId, groupName }, index) => (
            <div
              key={`${tab.id}-${groupId}`}
              className="flex items-center justify-between p-2 rounded hover:bg-yellow-100 dark:hover:bg-yellow-900/30"
            >
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <span className="text-xs text-gray-500 dark:text-gray-400 w-6">
                  #{index + 1}
                </span>
                <span className="text-sm truncate">
                  来自: <span className="font-medium">{groupName}</span>
                </span>
              </div>
              {index > 0 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveDuplicate(tab.id, groupId);
                  }}
                  className="p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400 transition-colors"
                  title="删除此重复项"
                >
                  <TrashIcon />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * 重复标签警告面板
 */
export const DuplicateWarningPanel: React.FC<DuplicateWarningProps> = ({
  groups,
  onClose,
  className = '',
}) => {
  const dispatch = useAppDispatch();
  const { showToast, showConfirm } = useToast();
  const [duplicates, setDuplicates] = useState<DuplicateInfo[]>([]);
  const [stats, setStats] = useState({ totalDuplicates: 0, affectedGroups: 0, duplicateUrls: 0 });

  useEffect(() => {
    const newDuplicates = smartGroupService.detectDuplicates(groups);
    const newStats = smartGroupService.getDuplicateStats(groups);
    setDuplicates(newDuplicates);
    setStats(newStats);
  }, [groups]);

  // 删除单个重复项
  const handleRemoveDuplicate = (tabId: string, groupId: string) => {
    const group = groups.find(g => g.id === groupId);
    if (!group) return;

    const updatedTabs = group.tabs.filter(t => t.id !== tabId);
    
    if (updatedTabs.length === 0) {
      dispatch(deleteGroup(groupId));
    } else {
      dispatch(updateGroup({
        ...group,
        tabs: updatedTabs,
        updatedAt: new Date().toISOString(),
      }));
    }

    showToast('已删除重复标签', 'success');
    logSanitizer.info(`删除重复标签: ${tabId} from ${group.name}`);
  };

  // 清理所有重复项
  const handleCleanAll = () => {
    showConfirm({
      title: '清理所有重复标签',
      message: `确定要删除所有 ${stats.totalDuplicates} 个重复标签吗？每个 URL 只保留第一个出现的标签。`,
      type: 'warning',
      confirmText: '清理',
      cancelText: '取消',
      onConfirm: () => {
        // 收集要删除的标签
        const tabsToRemove: Array<{ tabId: string; groupId: string }> = [];
        
        duplicates.forEach(dup => {
          // 跳过第一个，删除其余的
          dup.tabs.slice(1).forEach(({ tab, groupId }) => {
            tabsToRemove.push({ tabId: tab.id, groupId });
          });
        });

        // 按组分类
        const groupUpdates = new Map<string, Set<string>>();
        tabsToRemove.forEach(({ tabId, groupId }) => {
          if (!groupUpdates.has(groupId)) {
            groupUpdates.set(groupId, new Set());
          }
          groupUpdates.get(groupId)!.add(tabId);
        });

        // 执行删除
        groupUpdates.forEach((tabIds, groupId) => {
          const group = groups.find(g => g.id === groupId);
          if (!group) return;

          const remainingTabs = group.tabs.filter(t => !tabIds.has(t.id));
          
          if (remainingTabs.length === 0) {
            dispatch(deleteGroup(groupId));
          } else {
            dispatch(updateGroup({
              ...group,
              tabs: remainingTabs,
              updatedAt: new Date().toISOString(),
            }));
          }
        });

        showToast(`已清理 ${tabsToRemove.length} 个重复标签`, 'success');
        logSanitizer.info(`批量清理重复标签: ${tabsToRemove.length} 个`);
      },
      onCancel: () => {},
    });
  };

  if (duplicates.length === 0) {
    return null;
  }

  return (
    <div className={`duplicate-warning-panel bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 ${className}`}>
      {/* 头部 */}
      <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-2 text-yellow-600 dark:text-yellow-400">
          <WarningIcon />
          <span className="font-medium">发现重复标签</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCleanAll}
            className="px-3 py-1.5 text-sm bg-yellow-500 hover:bg-yellow-600 text-white rounded-lg transition-colors"
          >
            清理全部 ({stats.totalDuplicates})
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
              title="关闭"
            >
              <CloseIcon />
            </button>
          )}
        </div>
      </div>

      {/* 统计信息 */}
      <div className="px-4 py-2 bg-gray-50 dark:bg-gray-900/50 text-sm text-gray-600 dark:text-gray-400">
        发现 {stats.duplicateUrls} 个重复 URL，共 {stats.totalDuplicates} 个重复标签，
        涉及 {stats.affectedGroups} 个标签组
      </div>

      {/* 重复列表 */}
      <div className="p-4 space-y-2 max-h-96 overflow-y-auto">
        {duplicates.map((duplicate, index) => (
          <DuplicateCard
            key={`${duplicate.normalizedUrl}-${index}`}
            duplicate={duplicate}
            onRemoveDuplicate={handleRemoveDuplicate}
          />
        ))}
      </div>
    </div>
  );
};

export default DuplicateWarningPanel;
