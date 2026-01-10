/**
 * 批量操作工具栏
 * 
 * 当有选中的标签页时显示，提供批量删除、移动、导出等操作
 */

import React, { useState, useCallback } from 'react';
import { useSelection } from '@/contexts/SelectionContext';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { selectSortedGroups, deleteGroup, updateGroup } from '@/store/slices/tabSlice';
import { useToast } from '@/contexts/ToastContext';
import { Tab, TabGroup } from '@/types/tab';
import { logSanitizer } from '@/utils/logSanitizer';

// 图标组件
const CloseIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
  </svg>
);

const DeleteIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
  </svg>
);

const MoveIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 7.5L7.5 3m0 0L12 7.5M7.5 3v13.5m13.5 0L16.5 21m0 0L12 16.5m4.5 4.5V7.5" />
  </svg>
);

const ExportIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
  </svg>
);

const SelectAllIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);

interface BatchOperationToolbarProps {
  className?: string;
}

export const BatchOperationToolbar: React.FC<BatchOperationToolbarProps> = ({ className = '' }) => {
  const dispatch = useAppDispatch();
  const { showConfirm, showToast } = useToast();
  const { selectedIds, selectedCount, clearSelection, selectAll } = useSelection();
  const groups = useAppSelector(selectSortedGroups);
  
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [targetGroupId, setTargetGroupId] = useState<string>('');

  // 获取所有标签页ID列表
  const allTabIds = React.useMemo(() => {
    return groups.flatMap(group => group.tabs.map(tab => tab.id));
  }, [groups]);

  // 获取选中的标签页详情
  const getSelectedTabs = useCallback((): Array<{ tab: Tab; group: TabGroup }> => {
    const result: Array<{ tab: Tab; group: TabGroup }> = [];
    groups.forEach(group => {
      group.tabs.forEach(tab => {
        if (selectedIds.has(tab.id)) {
          result.push({ tab, group });
        }
      });
    });
    return result;
  }, [groups, selectedIds]);

  // 批量删除
  const handleBatchDelete = useCallback(() => {
    const selectedTabs = getSelectedTabs();
    if (selectedTabs.length === 0) return;

    showConfirm({
      title: '批量删除确认',
      message: `确定要删除选中的 ${selectedTabs.length} 个标签页吗？此操作不可撤销。`,
      type: 'danger',
      confirmText: '删除',
      cancelText: '取消',
      onConfirm: () => {
        // 按组分类要删除的标签
        const groupUpdates = new Map<string, Set<string>>();
        selectedTabs.forEach(({ tab, group }) => {
          if (!groupUpdates.has(group.id)) {
            groupUpdates.set(group.id, new Set());
          }
          groupUpdates.get(group.id)!.add(tab.id);
        });

        // 执行删除
        groupUpdates.forEach((tabIdsToDelete, groupId) => {
          const group = groups.find(g => g.id === groupId);
          if (!group) return;

          const remainingTabs = group.tabs.filter(t => !tabIdsToDelete.has(t.id));
          
          if (remainingTabs.length === 0) {
            // 删除整个组
            dispatch(deleteGroup(groupId));
            logSanitizer.info(`批量删除：删除空标签组 ${group.name}`);
          } else {
            // 更新组
            const updatedGroup = {
              ...group,
              tabs: remainingTabs,
              updatedAt: new Date().toISOString()
            };
            dispatch(updateGroup(updatedGroup));
            logSanitizer.info(`批量删除：从 ${group.name} 删除 ${tabIdsToDelete.size} 个标签页`);
          }
        });

        clearSelection();
        showToast(`已删除 ${selectedTabs.length} 个标签页`, 'success');
      },
      onCancel: () => {}
    });
  }, [getSelectedTabs, groups, dispatch, clearSelection, showConfirm, showToast]);

  // 批量移动
  const handleBatchMove = useCallback(() => {
    if (!targetGroupId) {
      showToast('请选择目标标签组', 'error');
      return;
    }

    const selectedTabs = getSelectedTabs();
    const targetGroup = groups.find(g => g.id === targetGroupId);
    
    if (!targetGroup) {
      showToast('目标标签组不存在', 'error');
      return;
    }

    // 收集要移动的标签
    const tabsToMove: Tab[] = [];
    const groupUpdates = new Map<string, Set<string>>();

    selectedTabs.forEach(({ tab, group }) => {
      if (group.id !== targetGroupId) {
        tabsToMove.push(tab);
        if (!groupUpdates.has(group.id)) {
          groupUpdates.set(group.id, new Set());
        }
        groupUpdates.get(group.id)!.add(tab.id);
      }
    });

    if (tabsToMove.length === 0) {
      showToast('没有可移动的标签页', 'error');
      return;
    }

    // 从源组移除标签
    groupUpdates.forEach((tabIdsToRemove, groupId) => {
      const group = groups.find(g => g.id === groupId);
      if (!group) return;

      const remainingTabs = group.tabs.filter(t => !tabIdsToRemove.has(t.id));
      
      if (remainingTabs.length === 0) {
        dispatch(deleteGroup(groupId));
      } else {
        dispatch(updateGroup({
          ...group,
          tabs: remainingTabs,
          updatedAt: new Date().toISOString()
        }));
      }
    });

    // 添加到目标组
    dispatch(updateGroup({
      ...targetGroup,
      tabs: [...targetGroup.tabs, ...tabsToMove],
      updatedAt: new Date().toISOString()
    }));

    setShowMoveModal(false);
    setTargetGroupId('');
    clearSelection();
    showToast(`已移动 ${tabsToMove.length} 个标签页到 "${targetGroup.name}"`, 'success');
    logSanitizer.info(`批量移动：${tabsToMove.length} 个标签页到 ${targetGroup.name}`);
  }, [targetGroupId, getSelectedTabs, groups, dispatch, clearSelection, showToast]);

  // 批量导出
  const handleBatchExport = useCallback((format: 'json' | 'text' | 'markdown') => {
    const selectedTabs = getSelectedTabs();
    if (selectedTabs.length === 0) return;

    let content: string;
    let filename: string;
    let mimeType: string;

    const timestamp = new Date().toISOString().slice(0, 10);

    switch (format) {
      case 'json':
        content = JSON.stringify(
          selectedTabs.map(({ tab }) => ({
            title: tab.title,
            url: tab.url,
            favicon: tab.favicon,
            createdAt: tab.createdAt
          })),
          null,
          2
        );
        filename = `tabs-export-${timestamp}.json`;
        mimeType = 'application/json';
        break;

      case 'markdown':
        content = `# 导出的标签页\n\n导出时间: ${new Date().toLocaleString('zh-CN')}\n\n`;
        content += selectedTabs.map(({ tab }) => `- [${tab.title}](${tab.url})`).join('\n');
        filename = `tabs-export-${timestamp}.md`;
        mimeType = 'text/markdown';
        break;

      case 'text':
      default:
        content = selectedTabs.map(({ tab }) => `${tab.title}\n${tab.url}`).join('\n\n');
        filename = `tabs-export-${timestamp}.txt`;
        mimeType = 'text/plain';
        break;
    }

    // 创建下载
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast(`已导出 ${selectedTabs.length} 个标签页`, 'success');
    logSanitizer.info(`批量导出：${selectedTabs.length} 个标签页，格式: ${format}`);
  }, [getSelectedTabs, showToast]);

  // 全选
  const handleSelectAll = useCallback(() => {
    selectAll(allTabIds);
  }, [selectAll, allTabIds]);

  // 如果没有选中项，不显示工具栏
  if (selectedCount === 0) {
    return null;
  }

  return (
    <>
      <div className={`batch-toolbar ${className}`}>
        <div className="flex items-center gap-3">
          {/* 选中数量 */}
          <span className="text-sm font-medium batch-toolbar-count">
            已选择 {selectedCount} 项
          </span>

          {/* 分隔线 */}
          <div className="h-4 w-px bg-gray-300 dark:bg-gray-600" />

          {/* 操作按钮 */}
          <div className="flex items-center gap-1">
            {/* 全选 */}
            <button
              onClick={handleSelectAll}
              className="btn-icon p-1.5 batch-toolbar-btn"
              title="全选"
            >
              <SelectAllIcon />
            </button>

            {/* 批量删除 */}
            <button
              onClick={handleBatchDelete}
              className="btn-icon p-1.5 batch-toolbar-btn-danger"
              title="删除选中"
            >
              <DeleteIcon />
            </button>

            {/* 批量移动 */}
            <button
              onClick={() => setShowMoveModal(true)}
              className="btn-icon p-1.5 batch-toolbar-btn"
              title="移动到..."
            >
              <MoveIcon />
            </button>

            {/* 导出下拉菜单 */}
            <div className="relative group">
              <button
                className="btn-icon p-1.5 batch-toolbar-btn"
                title="导出选中"
              >
                <ExportIcon />
              </button>
              <div className="absolute right-0 top-full mt-1 py-1 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50 min-w-[120px]">
                <button
                  onClick={() => handleBatchExport('json')}
                  className="w-full px-3 py-1.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  导出为 JSON
                </button>
                <button
                  onClick={() => handleBatchExport('markdown')}
                  className="w-full px-3 py-1.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  导出为 Markdown
                </button>
                <button
                  onClick={() => handleBatchExport('text')}
                  className="w-full px-3 py-1.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  导出为文本
                </button>
              </div>
            </div>
          </div>

          {/* 分隔线 */}
          <div className="h-4 w-px bg-gray-300 dark:bg-gray-600" />

          {/* 取消选择 */}
          <button
            onClick={clearSelection}
            className="btn-icon p-1.5 batch-toolbar-btn"
            title="取消选择"
          >
            <CloseIcon />
          </button>
        </div>
      </div>

      {/* 移动目标选择模态框 */}
      {showMoveModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
            <h3 className="text-lg font-medium mb-4">移动到标签组</h3>
            
            <div className="mb-4">
              <label className="block text-sm font-medium mb-2">选择目标标签组</label>
              <select
                value={targetGroupId}
                onChange={(e) => setTargetGroupId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="">请选择...</option>
                {groups.map(group => (
                  <option key={group.id} value={group.id}>
                    {group.name} ({group.tabs.length} 个标签)
                  </option>
                ))}
              </select>
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setShowMoveModal(false);
                  setTargetGroupId('');
                }}
                className="px-4 py-2 rounded-lg bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleBatchMove}
                disabled={!targetGroupId}
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                移动
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default BatchOperationToolbar;
