/**
 * 批量操作工具栏组件
 * 提供批量操作的控制界面
 */
import React, { useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import {
  setSelectionMode,
  clearAllSelections,
  selectAllGroups,
  batchDeleteGroups,
  batchToggleGroupLock,
  batchExportGroups,
} from '../store/batchOperationsSlice';
import { BatchMoveDialog } from './BatchMoveDialog';
// import { BatchOperationConfirmDialog } from './BatchOperationConfirmDialog';
import { cn } from '@/shared/utils/cn';

interface BatchOperationToolbarProps {
  className?: string;
}

export const BatchOperationToolbar: React.FC<BatchOperationToolbarProps> = ({
  className,
}) => {
  const dispatch = useAppDispatch();
  const { 
    selectionMode, 
    selectedGroupIds, 
    isProcessing, 
    currentOperation,
    progress 
  } = useAppSelector(state => state.batchOperations);
  const { groups } = useAppSelector(state => state.tabGroups);
  
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [pendingOperation, setPendingOperation] = useState<string | null>(null);

  const selectedCount = selectedGroupIds.length;
  const totalCount = groups.length;
  const isAllSelected = selectedCount === totalCount && totalCount > 0;

  // 进入/退出选择模式
  const handleToggleSelectionMode = () => {
    if (selectionMode === 'none') {
      dispatch(setSelectionMode('groups'));
    } else {
      dispatch(setSelectionMode('none'));
      dispatch(clearAllSelections());
    }
  };

  // 全选/取消全选
  const handleToggleSelectAll = () => {
    if (isAllSelected) {
      dispatch(clearAllSelections());
    } else {
      dispatch(selectAllGroups(groups.map(g => g.id)));
    }
  };

  // 批量删除
  const handleBatchDelete = () => {
    if (selectedCount === 0) return;
    
    setPendingOperation('delete');
    setShowConfirmDialog(true);
  };

  // 批量锁定/解锁
  const handleBatchToggleLock = (lock: boolean) => {
    if (selectedCount === 0) return;

    dispatch(batchToggleGroupLock({ groupIds: selectedGroupIds, lock }));
  };

  // 批量移动
  const handleBatchMove = () => {
    if (selectedCount === 0) return;
    setShowMoveDialog(true);
  };

  // 批量导出
  const handleBatchExport = () => {
    if (selectedCount === 0) return;

    dispatch(batchExportGroups(selectedGroupIds));
    // showToast(`正在导出 ${selectedCount} 个标签组...`, 'info');
  };

  // 确认操作
  const handleConfirmOperation = () => {
    if (pendingOperation === 'delete') {
      dispatch(batchDeleteGroups(selectedGroupIds));
    }

    setShowConfirmDialog(false);
    setPendingOperation(null);
  };

  // 取消操作
  const handleCancelOperation = () => {
    setShowConfirmDialog(false);
    setPendingOperation(null);
  };

  if (selectionMode === 'none') {
    return (
      <div className={cn("flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700", className)}>
        <div className="flex items-center space-x-3">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            标签组管理
          </h2>
          <span className="text-sm text-gray-500 dark:text-gray-400">
            共 {totalCount} 个标签组
          </span>
        </div>
        
        <button
          onClick={handleToggleSelectionMode}
          className={cn(
            "px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg",
            "transition-colors duration-200 flex items-center space-x-2"
          )}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>多选模式</span>
        </button>
      </div>
    );
  }

  return (
    <>
      <div className={cn("flex items-center justify-between p-4 bg-blue-50 dark:bg-blue-900/20 border-b border-blue-200 dark:border-blue-700", className)}>
        {/* 左侧：选择状态和控制 */}
        <div className="flex items-center space-x-4">
          <button
            onClick={handleToggleSelectionMode}
            className="p-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
            title="退出多选模式"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          
          <div className="flex items-center space-x-3">
            <button
              onClick={handleToggleSelectAll}
              className={cn(
                "flex items-center space-x-2 px-3 py-1 rounded-md text-sm font-medium transition-colors",
                isAllSelected
                  ? "bg-blue-600 text-white"
                  : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
              )}
            >
              <div className={cn(
                "w-4 h-4 rounded border-2 flex items-center justify-center",
                isAllSelected 
                  ? "bg-white border-white" 
                  : "border-gray-400 dark:border-gray-500"
              )}>
                {isAllSelected && (
                  <svg className="w-3 h-3 text-blue-600" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                )}
              </div>
              <span>全选</span>
            </button>
            
            <span className="text-sm text-gray-600 dark:text-gray-400">
              已选择 {selectedCount} / {totalCount} 个标签组
            </span>
          </div>
        </div>

        {/* 右侧：批量操作按钮 */}
        <div className="flex items-center space-x-2">
          {isProcessing && (
            <div className="flex items-center space-x-2 px-3 py-2 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
              <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
              <span className="text-sm text-gray-600 dark:text-gray-400">
                {currentOperation === 'delete' && '删除中...'}
                {currentOperation === 'lock' && '处理中...'}
                {currentOperation === 'export' && '导出中...'}
              </span>
              <span className="text-xs text-gray-500">{progress}%</span>
            </div>
          )}
          
          {!isProcessing && selectedCount > 0 && (
            <>
              <button
                onClick={handleBatchMove}
                className="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors flex items-center space-x-1"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
                <span>移动</span>
              </button>

              <button
                onClick={handleBatchExport}
                className="px-3 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg transition-colors flex items-center space-x-1"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span>导出</span>
              </button>
              
              <button
                onClick={() => handleBatchToggleLock(true)}
                className="px-3 py-2 bg-yellow-600 hover:bg-yellow-700 text-white text-sm font-medium rounded-lg transition-colors flex items-center space-x-1"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                </svg>
                <span>锁定</span>
              </button>
              
              <button
                onClick={() => handleBatchToggleLock(false)}
                className="px-3 py-2 bg-gray-600 hover:bg-gray-700 text-white text-sm font-medium rounded-lg transition-colors flex items-center space-x-1"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M3 7a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7zm2 0v8h10V7H5z" clipRule="evenodd" />
                </svg>
                <span>解锁</span>
              </button>
              
              <button
                onClick={handleBatchDelete}
                className="px-3 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg transition-colors flex items-center space-x-1"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                <span>删除</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* 确认对话框 */}
      {showConfirmDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
              确认批量删除
            </h3>
            <p className="text-gray-600 dark:text-gray-400 mb-6">
              您确定要删除选中的 {selectedCount} 个标签组吗？此操作无法撤销。
            </p>
            <div className="flex justify-end space-x-3">
              <button
                onClick={handleCancelOperation}
                className="px-4 py-2 text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleConfirmOperation}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 批量移动对话框 */}
      <BatchMoveDialog
        isOpen={showMoveDialog}
        onClose={() => setShowMoveDialog(false)}
        selectedGroupIds={selectedGroupIds}
      />
    </>
  );
};
