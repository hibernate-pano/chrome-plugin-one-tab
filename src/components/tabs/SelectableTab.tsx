/**
 * 可选择的标签页组件
 * 
 * 在 DraggableTab 基础上添加选择功能：
 * - 显示选中状态的视觉反馈（复选框、高亮背景）
 * - 处理 Ctrl/Cmd + 点击切换选择
 * - 处理 Shift + 点击范围选择
 */

import React, { useRef, useCallback, useMemo } from 'react';
import { useDrag, useDrop } from 'react-dnd';
import { Tab } from '@/types/tab';
import { ItemTypes, TabDragItem } from '@/components/dnd/DndTypes';
import { throttle } from 'lodash';
import { SafeFavicon } from '@/components/common/SafeFavicon';
import { useSelection } from '@/contexts/SelectionContext';

interface SelectableTabProps {
  tab: Tab;
  groupId: string;
  index: number;
  allTabIds: string[];  // 当前组内所有标签ID，用于范围选择
  moveTab: (sourceGroupId: string, sourceIndex: number, targetGroupId: string, targetIndex: number) => void;
  handleOpenTab: (tab: Tab) => void;
  handleDeleteTab: (tabId: string) => void;
}

// 删除图标
const CloseIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
  </svg>
);

// 复选框图标
const CheckboxIcon = ({ checked }: { checked: boolean }) => (
  <div className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-colors ${
    checked 
      ? 'bg-blue-500 border-blue-500' 
      : 'border-gray-400 dark:border-gray-500 hover:border-blue-400'
  }`}>
    {checked && (
      <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    )}
  </div>
);

/**
 * 可选择的标签页组件
 */
export const SelectableTab: React.FC<SelectableTabProps> = ({
  tab,
  groupId,
  index,
  allTabIds,
  moveTab,
  handleOpenTab,
  handleDeleteTab
}) => {
  const ref = useRef<HTMLDivElement>(null);
  // 始终调用 hook，确保 hooks 调用顺序一致
  const selectionContext = useSelection();
  const selected = selectionContext.isSelected(tab.id);
  const handleSelectionClick = selectionContext.handleClick;

  const throttledMoveTab = useMemo(
    () => throttle((sourceGroupId, sourceIndex, targetGroupId, targetIndex) => {
      moveTab(sourceGroupId, sourceIndex, targetGroupId, targetIndex);
    }, 100),
    [moveTab]
  );

  const [{ isDragging }, drag] = useDrag({
    type: ItemTypes.TAB,
    item: { type: ItemTypes.TAB, id: tab.id, groupId, index } as TabDragItem,
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
    end: (_, monitor) => {
      if (!monitor.didDrop()) {
        const element = ref.current;
        if (element) {
          element.classList.add('tab-drag-return');
          setTimeout(() => {
            element.classList.remove('tab-drag-return');
          }, 300);
        }
      }
    }
  });

  const [{ isOver, canDrop }, drop] = useDrop({
    accept: ItemTypes.TAB,
    hover: (item: TabDragItem, monitor) => {
      if (!ref.current) return;

      const sourceGroupId = item.groupId;
      const sourceIndex = item.index;
      const targetGroupId = groupId;
      const targetIndex = index;

      if (sourceGroupId === targetGroupId && sourceIndex === targetIndex) return;

      const hoverBoundingRect = ref.current.getBoundingClientRect();
      const hoverMiddleY = (hoverBoundingRect.bottom - hoverBoundingRect.top) / 2;
      const clientOffset = monitor.getClientOffset();
      const hoverClientY = clientOffset!.y - hoverBoundingRect.top;
      const hoverPercentage = (hoverClientY - hoverMiddleY) / hoverMiddleY;
      const threshold = 0.2;

      if (sourceGroupId === targetGroupId && sourceIndex < targetIndex && hoverPercentage < -threshold) return;
      if (sourceGroupId === targetGroupId && sourceIndex > targetIndex && hoverPercentage > threshold) return;

      throttledMoveTab(sourceGroupId, sourceIndex, targetGroupId, targetIndex);
      item.index = targetIndex;
      item.groupId = targetGroupId;
    },
    collect: (monitor) => ({
      isOver: monitor.isOver(),
      canDrop: monitor.canDrop(),
    }),
  });

  drag(drop(ref));

  const tabTitle = useMemo(() => tab.title, [tab.title]);

  // 处理标签点击 - 打开标签页
  const handleTabClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    // 如果有修饰键，处理选择逻辑
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      handleSelectionClick(tab.id, e, allTabIds);
    } else {
      // 普通点击打开标签页
      handleOpenTab(tab);
    }
  }, [handleOpenTab, tab, handleSelectionClick, allTabIds]);

  // 处理复选框点击 - 切换选择
  const handleCheckboxClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    handleSelectionClick(tab.id, e, allTabIds);
  }, [handleSelectionClick, tab.id, allTabIds]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    handleDeleteTab(tab.id);
  }, [handleDeleteTab, tab.id]);

  // 提取域名显示
  const displayUrl = useMemo(() => {
    try {
      const url = new URL(tab.url);
      return url.hostname.replace('www.', '');
    } catch {
      return tab.url;
    }
  }, [tab.url]);

  return (
    <div
      ref={ref}
      className={`tab-item group/tab ${isDragging ? 'dragging' : ''} ${isOver && canDrop ? 'drag-over' : ''} ${selected ? 'tab-item-selected' : ''}`}
      style={{ cursor: 'grab' }}
    >
      {/* 选择复选框 */}
      <button
        onClick={handleCheckboxClick}
        className="flex-shrink-0 p-0.5 -ml-1 mr-1 hover:bg-gray-200 dark:hover:bg-gray-600 rounded transition-colors"
        title={selected ? '取消选择' : '选择'}
      >
        <CheckboxIcon checked={selected} />
      </button>

      {/* Favicon */}
      <SafeFavicon src={tab.favicon} alt="" className="tab-item-favicon" />

      {/* 标题和 URL */}
      <div className="flex-1 min-w-0 flex items-center gap-3">
        <a
          href="#"
          className="tab-item-title tab-item-title-hover transition-colors"
          onClick={handleTabClick}
          title={`${tabTitle}\n\nCtrl/Cmd+点击: 切换选择\nShift+点击: 范围选择`}
        >
          {tabTitle}
        </a>
        <span className="tab-item-url hidden sm:block">
          {displayUrl}
        </span>
      </div>

      {/* 操作按钮 */}
      <div className="tab-item-actions">
        <button
          onClick={handleDelete}
          className="btn-icon p-1 tab-item-delete-btn"
          title="删除标签页"
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
};

export default SelectableTab;
