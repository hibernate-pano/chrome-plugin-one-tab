/**
 * Toast工具函数
 * 提供全局的toast通知功能，支持多种类型和配置选项
 */

import { ToastType, ToastAction } from '@/components/common/Toast';

export interface ToastOptions {
  type?: ToastType;
  duration?: number;
  action?: ToastAction;
  id?: string;
  closable?: boolean;
}

// 全局toast管理器
class ToastManager {
  private listeners: Set<(message: string, options?: ToastOptions) => void> = new Set();
  private dismissListeners: Set<(id?: string) => void> = new Set();

  // 注册toast显示监听器
  addListener(listener: (message: string, options?: ToastOptions) => void) {
    this.listeners.add(listener);
  }

  // 移除toast显示监听器
  removeListener(listener: (message: string, options?: ToastOptions) => void) {
    this.listeners.delete(listener);
  }

  // 注册toast关闭监听器
  addDismissListener(listener: (id?: string) => void) {
    this.dismissListeners.add(listener);
  }

  // 移除toast关闭监听器
  removeDismissListener(listener: (id?: string) => void) {
    this.dismissListeners.delete(listener);
  }

  // 显示toast
  show(message: string, options?: ToastOptions) {
    this.listeners.forEach(listener => listener(message, options));
  }

  // 关闭toast
  dismiss(id?: string) {
    this.dismissListeners.forEach(listener => listener(id));
  }

  // 便捷方法
  success(message: string, options?: Omit<ToastOptions, 'type'>) {
    this.show(message, { ...options, type: 'success' });
  }

  error(message: string, options?: Omit<ToastOptions, 'type'>) {
    this.show(message, { ...options, type: 'error' });
  }

  info(message: string, options?: Omit<ToastOptions, 'type'>) {
    this.show(message, { ...options, type: 'info' });
  }

  warning(message: string, options?: Omit<ToastOptions, 'type'>) {
    this.show(message, { ...options, type: 'warning' });
  }

  loading(message: string, options?: Omit<ToastOptions, 'type'>) {
    this.show(message, { 
      ...options, 
      type: 'loading',
      duration: 0, // loading toast默认不自动关闭
      closable: false // loading toast默认不可手动关闭
    });
  }
}

// 创建全局实例
const toastManager = new ToastManager();

// 导出toast API
export const toast = {
  // 基础方法
  show: (message: string, options?: ToastOptions) => toastManager.show(message, options),
  dismiss: (id?: string) => toastManager.dismiss(id),

  // 便捷方法
  success: (message: string, options?: Omit<ToastOptions, 'type'>) => toastManager.success(message, options),
  error: (message: string, options?: Omit<ToastOptions, 'type'>) => toastManager.error(message, options),
  info: (message: string, options?: Omit<ToastOptions, 'type'>) => toastManager.info(message, options),
  warning: (message: string, options?: Omit<ToastOptions, 'type'>) => toastManager.warning(message, options),
  loading: (message: string, options?: Omit<ToastOptions, 'type'>) => toastManager.loading(message, options),

  // 管理器方法（供ToastProvider使用）
  _addListener: (listener: (message: string, options?: ToastOptions) => void) => toastManager.addListener(listener),
  _removeListener: (listener: (message: string, options?: ToastOptions) => void) => toastManager.removeListener(listener),
  _addDismissListener: (listener: (id?: string) => void) => toastManager.addDismissListener(listener),
  _removeDismissListener: (listener: (id?: string) => void) => toastManager.removeDismissListener(listener),
};

// 默认导出
export default toast;
