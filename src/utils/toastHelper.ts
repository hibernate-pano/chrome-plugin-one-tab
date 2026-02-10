/**
 * Toast通知助手
 * 提供更丰富、更有意义的通知消息
 */

import { useToast } from '@/contexts/ToastContext';

/**
 * 通知消息类型
 */
export type NotificationType = 
  | 'save-success' 
  | 'save-error' 
  | 'restore-success' 
  | 'restore-error'
  | 'delete-success'
  | 'delete-error'
  | 'sync-success'
  | 'sync-error'
  | 'pinned-info';

/**
 * 通知参数类型
 */
export type NotificationParams = {
  count?: number;
  error?: string;
  message?: string;
};

/**
 * 通知消息配置
 */
interface NotificationConfig {
  title: string;
  message: string;
  type: 'success' | 'error' | 'info' | 'warning';
  duration?: number;
}

/**
 * 获取通知配置
 */
export const getNotificationConfig = (
  type: NotificationType, 
  params?: NotificationParams
): NotificationConfig => {
  switch (type) {
    // 保存操作
    case 'save-success':
      return {
        title: '保存成功',
        message: `已成功保存 ${params?.count || 0} 个标签页`,
        type: 'success',
        duration: 3000
      };
    case 'save-error':
      return {
        title: '保存失败',
        message: params?.error || '保存标签页时发生错误',
        type: 'error',
        duration: 5000
      };

    // 恢复操作
    case 'restore-success':
      return {
        title: '恢复成功',
        message: `已成功恢复 ${params?.count || 0} 个标签页`,
        type: 'success',
        duration: 3000
      };
    case 'restore-error':
      return {
        title: '恢复失败',
        message: params?.error || '恢复标签页时发生错误',
        type: 'error',
        duration: 5000
      };

    // 删除操作
    case 'delete-success':
      return {
        title: '删除成功',
        message: params?.message || '已成功删除',
        type: 'success',
        duration: 3000
      };
    case 'delete-error':
      return {
        title: '删除失败',
        message: params?.error || '删除操作失败',
        type: 'error',
        duration: 5000
      };

    // 同步操作
    case 'sync-success':
      return {
        title: '同步成功',
        message: params?.message || '数据已同步到云端',
        type: 'success',
        duration: 3000
      };
    case 'sync-error':
      return {
        title: '同步失败',
        message: params?.error || '数据同步失败',
        type: 'error',
        duration: 5000
      };

    // 固定标签页信息
    case 'pinned-info':
      return {
        title: '固定标签页',
        message: params?.message || '当前标签页是固定标签页',
        type: 'info',
        duration: 4000
      };

    default:
      return {
        title: '提示',
        message: '操作完成',
        type: 'success',
        duration: 3000
      };
  }
};

/**
 * 显示增强的通知
 */
export const showEnhancedNotification = (
  type: NotificationType, 
  params?: NotificationParams,
  customMessage?: string
) => {
  const config = getNotificationConfig(type, params);
  const message = customMessage || config.message;
  
  // 这里我们简单地返回配置，实际使用时需要结合 useToast
  return { ...config, message };
};

/**
 * Hook for enhanced toast notifications
 */
export const useEnhancedToast = () => {
  const toastContext = useToast();
  
  // 如果 ToastContext 未提供，返回空操作函数
  if (!toastContext) {
    console.error('useEnhancedToast must be used within ToastProvider');
    const noop = () => {};
    return {
      showSaveSuccess: noop,
      showSaveError: noop,
      showRestoreSuccess: noop,
      showRestoreError: noop,
      showDeleteSuccess: noop,
      showDeleteError: noop,
      showSyncSuccess: noop,
      showSyncError: noop,
      showPinnedInfo: noop,
    };
  }
  
  const { showToast } = toastContext;
  
  const showNotification = (
    type: NotificationType, 
    params?: NotificationParams, 
    customMessage?: string
  ) => {
    const config = showEnhancedNotification(type, params, customMessage);
    showToast(config.message, config.type, config.duration);
  };
  
  return {
    showSaveSuccess: (count: number) => showNotification('save-success', { count }),
    showSaveError: (error: string) => showNotification('save-error', { error }),
    showRestoreSuccess: (count: number) => showNotification('restore-success', { count }),
    showRestoreError: (error: string) => showNotification('restore-error', { error }),
    showDeleteSuccess: (message: string) => showNotification('delete-success', { message }),
    showDeleteError: (error: string) => showNotification('delete-error', { error }),
    showSyncSuccess: (message: string) => showNotification('sync-success', { message }),
    showSyncError: (error: string) => showNotification('sync-error', { error }),
    showPinnedInfo: (message: string) => showNotification('pinned-info', { message }),
  };
};