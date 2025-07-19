/**
 * 批量移动对话框组件
 * 允许用户选择批量移动的目标位置
 */
import React, { useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import { batchMoveGroups } from '../store/batchOperationsSlice';
import { cn } from '@/shared/utils/cn';
import { showToast } from '@/shared/components/Toast/Toast';

interface BatchMoveDialogProps {
  isOpen: boolean;
  onClose: () => void;
  selectedGroupIds: string[];
}

export const BatchMoveDialog: React.FC<BatchMoveDialogProps> = ({
  isOpen,
  onClose,
  selectedGroupIds,
}) => {
  const dispatch = useAppDispatch();
  const { groups } = useAppSelector(state => state.tabGroups);
  const { isProcessing } = useAppSelector(state => state.batchOperations);
  
  const [targetPosition, setTargetPosition] = useState<'top' | 'bottom' | 'custom'>('bottom');
  const [customIndex, setCustomIndex] = useState(0);

  // 过滤掉选中的标签组，显示可用的插入位置
  const availableGroups = groups.filter(group => !selectedGroupIds.includes(group.id));
  const selectedCount = selectedGroupIds.length;

  const handleMove = () => {
    let targetIndex = 0;
    
    switch (targetPosition) {
      case 'top':
        targetIndex = 0;
        break;
      case 'bottom':
        targetIndex = availableGroups.length;
        break;
      case 'custom':
        targetIndex = Math.max(0, Math.min(customIndex, availableGroups.length));
        break;
    }

    dispatch(batchMoveGroups({ groupIds: selectedGroupIds, targetIndex }));
    showToast(`正在移动 ${selectedCount} 个标签组...`, 'info');
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4 max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            批量移动标签组
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="mb-6">
          <p className="text-gray-600 dark:text-gray-400 mb-4">
            选择 {selectedCount} 个标签组的移动位置：
          </p>

          <div className="space-y-3">
            {/* 移动到顶部 */}
            <label className="flex items-center space-x-3 cursor-pointer">
              <input
                type="radio"
                name="position"
                value="top"
                checked={targetPosition === 'top'}
                onChange={(e) => setTargetPosition(e.target.value as 'top')}
                className="w-4 h-4 text-blue-600 border-gray-300 focus:ring-blue-500"
              />
              <div className="flex-1">
                <div className="font-medium text-gray-900 dark:text-gray-100">
                  移动到顶部
                </div>
                <div className="text-sm text-gray-500 dark:text-gray-400">
                  将选中的标签组移动到列表最前面
                </div>
              </div>
            </label>

            {/* 移动到底部 */}
            <label className="flex items-center space-x-3 cursor-pointer">
              <input
                type="radio"
                name="position"
                value="bottom"
                checked={targetPosition === 'bottom'}
                onChange={(e) => setTargetPosition(e.target.value as 'bottom')}
                className="w-4 h-4 text-blue-600 border-gray-300 focus:ring-blue-500"
              />
              <div className="flex-1">
                <div className="font-medium text-gray-900 dark:text-gray-100">
                  移动到底部
                </div>
                <div className="text-sm text-gray-500 dark:text-gray-400">
                  将选中的标签组移动到列表最后面
                </div>
              </div>
            </label>

            {/* 自定义位置 */}
            <label className="flex items-center space-x-3 cursor-pointer">
              <input
                type="radio"
                name="position"
                value="custom"
                checked={targetPosition === 'custom'}
                onChange={(e) => setTargetPosition(e.target.value as 'custom')}
                className="w-4 h-4 text-blue-600 border-gray-300 focus:ring-blue-500"
              />
              <div className="flex-1">
                <div className="font-medium text-gray-900 dark:text-gray-100">
                  自定义位置
                </div>
                <div className="text-sm text-gray-500 dark:text-gray-400 mb-2">
                  选择具体的插入位置
                </div>
                {targetPosition === 'custom' && (
                  <div className="mt-2">
                    <input
                      type="range"
                      min="0"
                      max={availableGroups.length}
                      value={customIndex}
                      onChange={(e) => setCustomIndex(parseInt(e.target.value))}
                      className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700"
                    />
                    <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mt-1">
                      <span>位置 0 (顶部)</span>
                      <span>位置 {customIndex}</span>
                      <span>位置 {availableGroups.length} (底部)</span>
                    </div>
                  </div>
                )}
              </div>
            </label>
          </div>
        </div>

        {/* 预览区域 */}
        {availableGroups.length > 0 && (
          <div className="mb-6">
            <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3">
              移动后的顺序预览：
            </h4>
            <div className="max-h-32 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-lg p-3 bg-gray-50 dark:bg-gray-900">
              {(() => {
                let insertIndex = 0;
                switch (targetPosition) {
                  case 'top':
                    insertIndex = 0;
                    break;
                  case 'bottom':
                    insertIndex = availableGroups.length;
                    break;
                  case 'custom':
                    insertIndex = customIndex;
                    break;
                }

                const previewGroups = [...availableGroups];
                const selectedGroups = groups.filter(g => selectedGroupIds.includes(g.id));
                previewGroups.splice(insertIndex, 0, ...selectedGroups);

                return previewGroups.map((group, index) => (
                  <div
                    key={group.id}
                    className={cn(
                      "text-sm py-1 px-2 rounded mb-1",
                      selectedGroupIds.includes(group.id)
                        ? "bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200 font-medium"
                        : "text-gray-600 dark:text-gray-400"
                    )}
                  >
                    {index + 1}. {group.name}
                  </div>
                ));
              })()}
            </div>
          </div>
        )}

        {/* 操作按钮 */}
        <div className="flex justify-end space-x-3">
          <button
            onClick={onClose}
            disabled={isProcessing}
            className="px-4 py-2 text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={handleMove}
            disabled={isProcessing || selectedCount === 0}
            className={cn(
              "px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              "flex items-center space-x-2"
            )}
          >
            {isProcessing ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                <span>移动中...</span>
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
                <span>确认移动</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
