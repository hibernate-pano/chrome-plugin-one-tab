/**
 * 异步操作状态管理Hook
 * 提供统一的loading状态、错误处理和成功反馈
 */

import { useState, useCallback } from 'react';
import { feedback } from '@/shared/utils/feedback';

export interface AsyncOperationOptions {
  loadingMessage?: string;
  successMessage?: string;
  errorMessage?: string;
  showLoadingToast?: boolean;
  showSuccessToast?: boolean;
  showErrorToast?: boolean;
  useSmartError?: boolean; // 是否使用智能错误处理
  onSuccess?: () => void;
  onError?: (error: Error) => void;
}

export interface AsyncOperationState {
  isLoading: boolean;
  error: Error | null;
  data: any;
}

export function useAsyncOperation<T = any>(
  defaultOptions: AsyncOperationOptions = {}
) {
  const [state, setState] = useState<AsyncOperationState>({
    isLoading: false,
    error: null,
    data: null,
  });

  const execute = useCallback(
    async (
      operation: () => Promise<T>,
      options: AsyncOperationOptions = {}
    ): Promise<T | null> => {
      const mergedOptions = { ...defaultOptions, ...options };
      const {
        loadingMessage = '正在处理...',
        successMessage,
        errorMessage,
        showLoadingToast = true,
        showSuccessToast = true,
        showErrorToast = true,
        useSmartError = true,
        onSuccess,
        onError,
      } = mergedOptions;

      let loadingToastId: string | undefined;

      try {
        // 设置loading状态
        setState(prev => ({ ...prev, isLoading: true, error: null }));

        // 显示loading toast
        if (showLoadingToast && loadingMessage) {
          loadingToastId = `loading-${Date.now()}`;
          feedback.loading(loadingMessage, { id: loadingToastId });
        }

        // 执行异步操作
        const result = await operation();

        // 关闭loading toast
        if (loadingToastId) {
          feedback.dismissLoading(loadingToastId);
        }

        // 设置成功状态
        setState(prev => ({ ...prev, isLoading: false, data: result }));

        // 显示成功toast
        if (showSuccessToast && successMessage) {
          feedback.success(successMessage);
        }

        // 调用成功回调
        if (onSuccess) {
          onSuccess();
        }

        return result;
      } catch (error) {
        // 关闭loading toast
        if (loadingToastId) {
          feedback.dismissLoading(loadingToastId);
        }

        const errorObj = error instanceof Error ? error : new Error(String(error));

        // 设置错误状态
        setState(prev => ({ ...prev, isLoading: false, error: errorObj }));

        // 显示错误toast
        if (showErrorToast) {
          if (useSmartError) {
            // 使用智能错误处理
            feedback.smartError(error, {
              showToast: true,
              logToConsole: true,
            });
          } else {
            // 使用传统错误处理
            const message = errorMessage || errorObj.message || '操作失败';
            feedback.error(message);
          }
        }

        // 调用错误回调
        if (onError) {
          onError(errorObj);
        }

        return null;
      }
    },
    [defaultOptions]
  );

  const reset = useCallback(() => {
    setState({ isLoading: false, error: null, data: null });
  }, []);

  return {
    ...state,
    execute,
    reset,
  };
}

// 便捷的预配置hooks
export function useSyncOperation() {
  return useAsyncOperation({
    loadingMessage: '正在同步数据...',
    successMessage: '同步完成',
    useSmartError: true, // 同步操作使用智能错误处理
  });
}

export function useAuthOperation() {
  return useAsyncOperation({
    loadingMessage: '正在处理...',
    showSuccessToast: false, // 认证操作通常不需要成功提示
    useSmartError: true, // 认证操作使用智能错误处理
  });
}

export function useTabOperation() {
  return useAsyncOperation({
    showLoadingToast: false, // 标签操作通常很快，不需要loading提示
    showSuccessToast: false, // 标签操作通常不需要成功提示
    showErrorToast: true,
    useSmartError: true, // 标签操作使用智能错误处理
  });
}

export function useFileOperation() {
  return useAsyncOperation({
    loadingMessage: '正在处理文件...',
    useSmartError: true, // 文件操作使用智能错误处理
  });
}

export function useNetworkOperation() {
  return useAsyncOperation({
    loadingMessage: '正在连接...',
    useSmartError: true, // 网络操作使用智能错误处理
  });
}
