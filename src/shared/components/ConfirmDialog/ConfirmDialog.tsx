import React, { memo, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/shared/utils/cn';
import { createMemoComparison } from '@/shared/utils/performanceOptimizer';
import { ConfirmDialogConfig } from '@/shared/utils/codeDeduplication';

/**
 * 确认对话框属性接口
 */
export interface ConfirmDialogProps {
  isOpen: boolean;
  config: ConfirmDialogConfig;
  onClose: () => void;
}

/**
 * 通用确认对话框组件
 * 用于替换项目中重复的确认对话框代码
 */
const ConfirmDialogComponent: React.FC<ConfirmDialogProps> = ({
  isOpen,
  config,
  onClose
}) => {
  const {
    title,
    message,
    confirmText = '确认',
    cancelText = '取消',
    confirmButtonClass = 'bg-blue-600 hover:bg-blue-700 text-white',
    cancelButtonClass = 'border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700',
    onConfirm,
    onCancel,
    showCloseButton = true,
    maxWidth = 'max-w-md'
  } = config;

  // 处理确认操作
  const handleConfirm = useCallback(async () => {
    try {
      await onConfirm();
      onClose();
    } catch (error) {
      console.error('确认操作失败:', error);
      // 不关闭对话框，让用户看到错误
    }
  }, [onConfirm, onClose]);

  // 处理取消操作
  const handleCancel = useCallback(() => {
    onCancel?.();
    onClose();
  }, [onCancel, onClose]);

  // 处理ESC键
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handleCancel();
      } else if (event.key === 'Enter' && event.ctrlKey) {
        handleConfirm();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleCancel, handleConfirm]);

  // 阻止背景滚动
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = '';
      };
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const dialogContent = (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* 背景遮罩 */}
      <div 
        className="absolute inset-0 bg-black bg-opacity-30 transition-opacity"
        onClick={handleCancel}
        aria-hidden="true"
      />
      
      {/* 对话框内容 */}
      <div 
        className={cn(
          'relative bg-white dark:bg-gray-800 rounded-lg shadow-xl',
          'transform transition-all duration-200 ease-out',
          'animate-in fade-in-0 zoom-in-95',
          maxWidth,
          'w-full mx-4'
        )}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-description"
      >
        {/* 关闭按钮 */}
        {showCloseButton && (
          <button
            onClick={handleCancel}
            className="absolute top-4 right-4 p-1 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            aria-label="关闭对话框"
          >
            <svg 
              className="w-5 h-5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" 
              fill="none" 
              stroke="currentColor" 
              viewBox="0 0 24 24"
            >
              <path 
                strokeLinecap="round" 
                strokeLinejoin="round" 
                strokeWidth={2} 
                d="M6 18L18 6M6 6l12 12" 
              />
            </svg>
          </button>
        )}

        {/* 对话框内容 */}
        <div className="p-6">
          {/* 标题 */}
          <h3 
            id="confirm-dialog-title"
            className="text-lg font-medium mb-4 text-gray-900 dark:text-gray-100 pr-8"
          >
            {title}
          </h3>

          {/* 消息内容 */}
          <div 
            id="confirm-dialog-description"
            className="mb-6 text-gray-700 dark:text-gray-300 leading-relaxed"
          >
            {typeof message === 'string' ? (
              <p>{message}</p>
            ) : (
              message
            )}
          </div>

          {/* 操作按钮 */}
          <div className="flex justify-end space-x-3">
            <button
              onClick={handleCancel}
              className={cn(
                'px-4 py-2 rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500',
                cancelButtonClass
              )}
            >
              {cancelText}
            </button>
            <button
              onClick={handleConfirm}
              className={cn(
                'px-4 py-2 rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500',
                confirmButtonClass
              )}
            >
              {confirmText}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  // 使用Portal渲染到body
  return createPortal(dialogContent, document.body);
};

// 使用memo优化性能
export const ConfirmDialog = memo(
  ConfirmDialogComponent,
  createMemoComparison(['isOpen', 'config', 'onClose'])
);

/**
 * 确认对话框Hook
 * 提供更简单的使用方式
 */
export function useConfirmDialog() {
  const [dialogState, setDialogState] = React.useState<{
    isOpen: boolean;
    config: ConfirmDialogConfig | null;
  }>({
    isOpen: false,
    config: null
  });

  const showConfirm = useCallback((config: ConfirmDialogConfig) => {
    setDialogState({
      isOpen: true,
      config
    });
  }, []);

  const hideConfirm = useCallback(() => {
    setDialogState({
      isOpen: false,
      config: null
    });
  }, []);

  const confirmDialog = dialogState.config ? (
    <ConfirmDialog
      isOpen={dialogState.isOpen}
      config={dialogState.config}
      onClose={hideConfirm}
    />
  ) : null;

  return {
    showConfirm,
    hideConfirm,
    confirmDialog,
    isOpen: dialogState.isOpen
  };
}

/**
 * 快速确认函数
 * 提供Promise风格的确认对话框
 */
export function quickConfirm(config: Omit<ConfirmDialogConfig, 'onConfirm' | 'onCancel'>): Promise<boolean> {
  return new Promise((resolve) => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    const cleanup = () => {
      document.body.removeChild(container);
    };

    const handleConfirm = () => {
      cleanup();
      resolve(true);
    };

    const handleCancel = () => {
      cleanup();
      resolve(false);
    };

    const dialogConfig: ConfirmDialogConfig = {
      ...config,
      onConfirm: handleConfirm,
      onCancel: handleCancel
    };

    const root = (window as any).ReactDOM?.createRoot?.(container) || 
                  (window as any).ReactDOM?.render;

    if (root) {
      if (typeof root === 'function') {
        // React 17及以下
        root(
          <ConfirmDialog
            isOpen={true}
            config={dialogConfig}
            onClose={handleCancel}
          />,
          container
        );
      } else {
        // React 18+
        root.render(
          <ConfirmDialog
            isOpen={true}
            config={dialogConfig}
            onClose={handleCancel}
          />
        );
      }
    }
  });
}

/**
 * 预定义的确认对话框配置
 */
export const ConfirmDialogPresets = {
  /**
   * 删除确认
   */
  delete: (itemName: string = '此项'): Omit<ConfirmDialogConfig, 'onConfirm'> => ({
    title: '确认删除',
    message: `确定要删除${itemName}吗？此操作不可撤销。`,
    confirmText: '删除',
    cancelText: '取消',
    confirmButtonClass: 'bg-red-600 hover:bg-red-700 text-white'
  }),

  /**
   * 清理确认
   */
  cleanup: (description: string): Omit<ConfirmDialogConfig, 'onConfirm'> => ({
    title: '确认清理',
    message: description,
    confirmText: '确认清理',
    cancelText: '取消',
    confirmButtonClass: 'bg-orange-600 hover:bg-orange-700 text-white'
  }),

  /**
   * 保存确认
   */
  save: (hasUnsavedChanges: boolean = true): Omit<ConfirmDialogConfig, 'onConfirm'> => ({
    title: '保存更改',
    message: hasUnsavedChanges 
      ? '您有未保存的更改，是否要保存？' 
      : '确定要保存当前设置吗？',
    confirmText: '保存',
    cancelText: '取消',
    confirmButtonClass: 'bg-green-600 hover:bg-green-700 text-white'
  }),

  /**
   * 重置确认
   */
  reset: (targetName: string = '设置'): Omit<ConfirmDialogConfig, 'onConfirm'> => ({
    title: '重置确认',
    message: `确定要重置${targetName}吗？所有自定义配置将丢失。`,
    confirmText: '重置',
    cancelText: '取消',
    confirmButtonClass: 'bg-yellow-600 hover:bg-yellow-700 text-white'
  }),

  /**
   * 退出确认
   */
  exit: (hasUnsavedChanges: boolean = false): Omit<ConfirmDialogConfig, 'onConfirm'> => ({
    title: '确认退出',
    message: hasUnsavedChanges 
      ? '您有未保存的更改，确定要退出吗？' 
      : '确定要退出吗？',
    confirmText: '退出',
    cancelText: '取消',
    confirmButtonClass: 'bg-gray-600 hover:bg-gray-700 text-white'
  })
};
