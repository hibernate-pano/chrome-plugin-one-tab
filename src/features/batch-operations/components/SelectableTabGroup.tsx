/**
 * 可选择的标签组组件
 * 在原有TabGroup基础上添加多选功能
 */
import React from 'react';
import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import { toggleGroupSelection } from '../store/batchOperationsSlice';
import { TabGroup as TabGroupComponent } from '@/components/tabs/TabGroup';
import { TabGroup as TabGroupType } from '@/shared/types/tab';
import { cn } from '@/shared/utils/cn';

interface SelectableTabGroupProps {
  group: TabGroupType;
  onOpenAllTabs?: () => void;
  onDeleteGroup?: (groupId: string) => void;
  onUpdateGroup?: (group: TabGroupType) => void;
  onDeleteTab?: (tabId: string) => void;
  className?: string;
}

export const SelectableTabGroup: React.FC<SelectableTabGroupProps> = ({
  group,
  onOpenAllTabs,
  onDeleteGroup,
  onUpdateGroup,
  onDeleteTab,
  className,
}) => {
  const dispatch = useAppDispatch();
  const { selectionMode, selectedGroupIds } = useAppSelector(state => state.batchOperations);
  
  const isSelected = selectedGroupIds.includes(group.id);
  const isSelectionMode = selectionMode === 'groups';

  const handleSelectionToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch(toggleGroupSelection(group.id));
  };

  const handleGroupClick = (e: React.MouseEvent) => {
    if (isSelectionMode) {
      e.preventDefault();
      dispatch(toggleGroupSelection(group.id));
    }
  };

  return (
    <div 
      className={cn(
        "relative transition-all duration-200",
        isSelectionMode && "cursor-pointer",
        isSelected && "ring-2 ring-blue-500 ring-offset-2 dark:ring-offset-gray-900",
        className
      )}
      onClick={handleGroupClick}
    >
      {/* 选择模式下的选择框 */}
      {isSelectionMode && (
        <div className="absolute top-4 left-4 z-10">
          <button
            onClick={handleSelectionToggle}
            className={cn(
              "w-6 h-6 rounded-md border-2 flex items-center justify-center transition-all duration-200",
              "hover:scale-110 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2",
              isSelected
                ? "bg-blue-600 border-blue-600 text-white"
                : "bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 hover:border-blue-400"
            )}
            aria-label={isSelected ? '取消选择标签组' : '选择标签组'}
          >
            {isSelected && (
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
            )}
          </button>
        </div>
      )}

      {/* 选择状态指示器 */}
      {isSelected && (
        <div className="absolute top-0 right-0 w-0 h-0 border-l-[20px] border-l-transparent border-t-[20px] border-t-blue-500 z-10">
          <svg 
            className="absolute -top-[18px] -right-[2px] w-3 h-3 text-white" 
            fill="currentColor" 
            viewBox="0 0 20 20"
          >
            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
        </div>
      )}

      {/* 原有的TabGroup组件 */}
      <div className={cn(
        isSelectionMode && "pl-12", // 为选择框留出空间
        isSelected && "opacity-90"
      )}>
        <TabGroupComponent
          group={group}
          onOpenAllTabs={onOpenAllTabs}
          onDeleteGroup={onDeleteGroup}
          onUpdateGroup={onUpdateGroup}
          onDeleteTab={onDeleteTab}
        />
      </div>

      {/* 选择模式下的遮罩层 */}
      {isSelectionMode && (
        <div 
          className={cn(
            "absolute inset-0 bg-blue-500 bg-opacity-0 hover:bg-opacity-5 transition-all duration-200 rounded-xl",
            isSelected && "bg-opacity-10"
          )}
        />
      )}
    </div>
  );
};
