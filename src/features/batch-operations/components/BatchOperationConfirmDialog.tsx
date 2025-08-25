/**
 * 批量操作确认对话框组件
 * 为各种批量操作提供统一的确认界面和预览
 */
import React from 'react';
import { useAppSelector } from '@/app/store/hooks';
import { BatchOperationType } from '../store/batchOperationsSlice';
import { cn } from '@/shared/utils/cn';

interface BatchOperationConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  operation: BatchOperationType;
  selectedGroupIds: string[];
  isProcessing?: boolean;
}

export const BatchOperationConfirmDialog: React.FC<BatchOperationConfirmDialogProps> = ({
  isOpen,
  onClose,
  onConfirm,
  operation,
  selectedGroupIds,
  isProcessing = false,
}) => {
  const { groups } = useAppSelector(state => state.tabGroups);
  
  const selectedGroups = groups.filter(group => selectedGroupIds.includes(group.id));
  const selectedCount = selectedGroups.length;
  const totalTabs = selectedGroups.reduce((sum, group) => sum + group.tabs.length, 0);

  // 获取操作相关的配置
  const getOperationConfig = () => {
    switch (operation) {
      case 'delete':
        return {
          title: '确认批量删除',
          description: `您确定要删除选中的 ${selectedCount} 个标签组吗？这将同时删除其中的 ${totalTabs} 个标签页。`,
          warning: '此操作无法撤销，请谨慎操作。',
          confirmText: '确认删除',
          confirmClass: 'bg-red-600 hover:bg-red-700',
          icon: (
            <svg className="w-12 h-12 text-red-500 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          ),
        };
      case 'lock':
        return {
          title: '确认批量锁定',
          description: `您确定要锁定选中的 ${selectedCount} 个标签组吗？`,
          warning: '锁定后的标签组将无法编辑或删除，直到解锁为止。',
          confirmText: '确认锁定',
          confirmClass: 'bg-yellow-600 hover:bg-yellow-700',
          icon: (
            <svg className="w-12 h-12 text-yellow-500 mx-auto mb-4" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
            </svg>
          ),
        };
      case 'unlock':
        return {
          title: '确认批量解锁',
          description: `您确定要解锁选中的 ${selectedCount} 个标签组吗？`,
          warning: '解锁后的标签组将可以被编辑和删除。',
          confirmText: '确认解锁',
          confirmClass: 'bg-gray-600 hover:bg-gray-700',
          icon: (
            <svg className="w-12 h-12 text-gray-500 mx-auto mb-4" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M3 7a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7zm2 0v8h10V7H5z" clipRule="evenodd" />
            </svg>
          ),
        };
      case 'export':
        return {
          title: '确认批量导出',
          description: `您确定要导出选中的 ${selectedCount} 个标签组吗？这将包含 ${totalTabs} 个标签页的数据。`,
          warning: '导出的文件将包含标签页的URL和标题信息。',
          confirmText: '确认导出',
          confirmClass: 'bg-green-600 hover:bg-green-700',
          icon: (
            <svg className="w-12 h-12 text-green-500 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          ),
        };
      default:
        return {
          title: '确认操作',
          description: `您确定要对选中的 ${selectedCount} 个标签组执行此操作吗？`,
          warning: '',
          confirmText: '确认',
          confirmClass: 'bg-blue-600 hover:bg-blue-700',
          icon: (
            <svg className="w-12 h-12 text-blue-500 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          ),
        };
    }
  };

  const config = getOperationConfig();

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-lg w-full mx-4 max-h-[80vh] overflow-y-auto">
        <div className="text-center">
          {config.icon}
          
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            {config.title}
          </h3>
          
          <p className="text-gray-600 dark:text-gray-400 mb-4">
            {config.description}
          </p>
          
          {config.warning && (
            <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-3 mb-6">
              <div className="flex items-start">
                <svg className="w-5 h-5 text-yellow-600 dark:text-yellow-400 mt-0.5 mr-2 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                <p className="text-sm text-yellow-800 dark:text-yellow-200">
                  {config.warning}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* 选中项目预览 */}
        <div className="mb-6">
          <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3">
            将要操作的标签组：
          </h4>
          <div className="max-h-32 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-lg">
            {selectedGroups.map((group, index) => (
              <div
                key={group.id}
                className={cn(
                  "flex items-center justify-between p-3 border-b border-gray-100 dark:border-gray-700 last:border-b-0",
                  index % 2 === 0 ? "bg-gray-50 dark:bg-gray-900/50" : "bg-white dark:bg-gray-800"
                )}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                    {group.name}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {group.tabs.length} 个标签页
                  </div>
                </div>
                {group.isLocked && (
                  <svg className="w-4 h-4 text-yellow-500 ml-2 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                  </svg>
                )}
              </div>
            ))}
          </div>
        </div>

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
            onClick={onConfirm}
            disabled={isProcessing}
            className={cn(
              "px-4 py-2 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
              "flex items-center space-x-2",
              config.confirmClass
            )}
          >
            {isProcessing ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                <span>处理中...</span>
              </>
            ) : (
              <span>{config.confirmText}</span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
