import { useCallback, useRef, useState } from 'react';
import { logger } from '@/shared/utils/logger';
import { AsyncOperationWrapper, ErrorHandlingConfig, RetryConfig } from '@/shared/utils/codeDeduplication';

/**
 * 错误类型枚举
 */
export enum ErrorType {
  NETWORK = 'network',
  AUTH = 'auth',
  VALIDATION = 'validation',
  PERMISSION = 'permission',
  NOT_FOUND = 'not_found',
  SERVER = 'server',
  CLIENT = 'client',
  UNKNOWN = 'unknown'
}

/**
 * 错误处理状态接口
 */
export interface ErrorHandlingState {
  error: Error | null;
  errorType: ErrorType | null;
  isRetrying: boolean;
  retryCount: number;
  canRetry: boolean;
  lastErrorTime: number | null;
}

/**
 * 错误处理配置接口
 */
export interface UseErrorHandlingConfig {
  // 基础配置
  context: string;
  showToast?: boolean;
  logToConsole?: boolean;
  reportToService?: boolean;
  
  // 重试配置
  enableRetry?: boolean;
  maxRetries?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  
  // 错误分类
  errorClassifier?: (error: Error) => ErrorType;
  
  // 自定义处理器
  customHandlers?: Partial<Record<ErrorType, (error: Error) => void>>;
  
  // 回调函数
  onError?: (error: Error, errorType: ErrorType) => void;
  onRetry?: (retryCount: number) => void;
  onMaxRetriesReached?: (error: Error) => void;
}

/**
 * 默认错误分类器
 */
const defaultErrorClassifier = (error: Error): ErrorType => {
  const message = error.message.toLowerCase();
  
  if (message.includes('network') || message.includes('fetch') || message.includes('timeout')) {
    return ErrorType.NETWORK;
  }
  
  if (message.includes('unauthorized') || message.includes('authentication') || message.includes('token')) {
    return ErrorType.AUTH;
  }
  
  if (message.includes('validation') || message.includes('invalid') || message.includes('required')) {
    return ErrorType.VALIDATION;
  }
  
  if (message.includes('permission') || message.includes('forbidden') || message.includes('access denied')) {
    return ErrorType.PERMISSION;
  }
  
  if (message.includes('not found') || message.includes('404')) {
    return ErrorType.NOT_FOUND;
  }
  
  if (message.includes('server') || message.includes('500') || message.includes('503')) {
    return ErrorType.SERVER;
  }
  
  return ErrorType.UNKNOWN;
};

/**
 * 错误处理Hook
 * 提供统一的错误处理、重试和状态管理功能
 */
export function useErrorHandling(config: UseErrorHandlingConfig) {
  const {
    context,
    showToast = true,
    logToConsole = true,
    reportToService = false,
    enableRetry = true,
    maxRetries = 3,
    retryDelay = 1000,
    retryBackoff = true,
    errorClassifier = defaultErrorClassifier,
    customHandlers = {},
    onError,
    onRetry,
    onMaxRetriesReached
  } = config;

  // 状态管理
  const [state, setState] = useState<ErrorHandlingState>({
    error: null,
    errorType: null,
    isRetrying: false,
    retryCount: 0,
    canRetry: false,
    lastErrorTime: null
  });

  // 重试定时器引用
  const retryTimeoutRef = useRef<NodeJS.Timeout>();
  const lastOperationRef = useRef<() => Promise<any>>();

  /**
   * 处理错误
   */
  const handleError = useCallback((error: Error, operation?: () => Promise<any>) => {
    const errorType = errorClassifier(error);
    const now = Date.now();
    
    // 更新状态
    setState(prev => ({
      ...prev,
      error,
      errorType,
      isRetrying: false,
      canRetry: enableRetry && prev.retryCount < maxRetries && isRetryableError(errorType),
      lastErrorTime: now
    }));

    // 保存操作引用用于重试
    if (operation) {
      lastOperationRef.current = operation;
    }

    // 记录日志
    if (logToConsole) {
      logger.error(`[${context}] 错误处理:`, {
        error: error.message,
        type: errorType,
        retryCount: state.retryCount,
        canRetry: enableRetry && state.retryCount < maxRetries
      });
    }

    // 显示用户反馈
    if (showToast) {
      showErrorFeedback(error, errorType);
    }

    // 错误报告
    if (reportToService) {
      reportError(error, errorType, context);
    }

    // 自定义处理器
    const customHandler = customHandlers[errorType];
    if (customHandler) {
      customHandler(error);
    }

    // 回调函数
    onError?.(error, errorType);

    // 检查是否达到最大重试次数
    if (state.retryCount >= maxRetries) {
      onMaxRetriesReached?.(error);
    }

  }, [
    context,
    errorClassifier,
    enableRetry,
    maxRetries,
    logToConsole,
    showToast,
    reportToService,
    customHandlers,
    onError,
    onMaxRetriesReached,
    state.retryCount
  ]);

  /**
   * 重试操作
   */
  const retry = useCallback(async () => {
    if (!state.canRetry || !lastOperationRef.current || state.isRetrying) {
      return;
    }

    const newRetryCount = state.retryCount + 1;
    
    setState(prev => ({
      ...prev,
      isRetrying: true,
      retryCount: newRetryCount,
      error: null,
      errorType: null
    }));

    // 计算延迟时间
    const delay = retryBackoff 
      ? retryDelay * Math.pow(2, newRetryCount - 1)
      : retryDelay;

    // 回调函数
    onRetry?.(newRetryCount);

    try {
      // 延迟后重试
      await new Promise(resolve => {
        retryTimeoutRef.current = setTimeout(resolve, delay);
      });

      // 执行重试
      await lastOperationRef.current();

      // 重试成功，清除错误状态
      setState(prev => ({
        ...prev,
        error: null,
        errorType: null,
        isRetrying: false,
        canRetry: false
      }));

    } catch (error) {
      // 重试失败，递归处理错误
      handleError(error as Error, lastOperationRef.current);
    }
  }, [state.canRetry, state.isRetrying, state.retryCount, retryDelay, retryBackoff, onRetry, handleError]);

  /**
   * 清除错误状态
   */
  const clearError = useCallback(() => {
    // 清除重试定时器
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
    }

    setState({
      error: null,
      errorType: null,
      isRetrying: false,
      retryCount: 0,
      canRetry: false,
      lastErrorTime: null
    });

    lastOperationRef.current = undefined;
  }, []);

  /**
   * 包装异步操作
   */
  const wrapAsyncOperation = useCallback(<T>(
    operation: () => Promise<T>,
    operationConfig?: Partial<ErrorHandlingConfig & RetryConfig>
  ) => {
    return AsyncOperationWrapper.execute(operation, {
      error: {
        context,
        showToast,
        logToConsole,
        reportToService,
        ...operationConfig
      },
      retry: {
        maxRetries,
        baseDelay: retryDelay,
        backoffMultiplier: retryBackoff ? 2 : 1,
        ...operationConfig
      }
    });
  }, [context, showToast, logToConsole, reportToService, maxRetries, retryDelay, retryBackoff]);

  /**
   * 安全执行异步操作
   */
  const safeExecute = useCallback(async <T>(
    operation: () => Promise<T>,
    fallbackValue?: T
  ): Promise<T | undefined> => {
    try {
      clearError();
      return await operation();
    } catch (error) {
      handleError(error as Error, operation);
      return fallbackValue;
    }
  }, [clearError, handleError]);

  // 清理定时器
  React.useEffect(() => {
    return () => {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
    };
  }, []);

  return {
    // 状态
    ...state,
    
    // 操作
    handleError,
    retry,
    clearError,
    wrapAsyncOperation,
    safeExecute,
    
    // 工具函数
    isNetworkError: () => state.errorType === ErrorType.NETWORK,
    isAuthError: () => state.errorType === ErrorType.AUTH,
    isValidationError: () => state.errorType === ErrorType.VALIDATION,
    hasError: () => state.error !== null,
    
    // 状态查询
    getErrorMessage: () => state.error?.message || '',
    getRetryDelay: () => retryBackoff 
      ? retryDelay * Math.pow(2, state.retryCount)
      : retryDelay
  };
}

/**
 * 判断错误是否可重试
 */
function isRetryableError(errorType: ErrorType): boolean {
  return [
    ErrorType.NETWORK,
    ErrorType.SERVER,
    ErrorType.UNKNOWN
  ].includes(errorType);
}

/**
 * 显示错误反馈
 */
function showErrorFeedback(error: Error, errorType: ErrorType): void {
  // 这里应该调用实际的反馈系统
  // 为了避免循环依赖，这里只是记录日志
  logger.debug('显示错误反馈:', { message: error.message, type: errorType });
}

/**
 * 报告错误
 */
function reportError(error: Error, errorType: ErrorType, context: string): void {
  // 这里应该调用实际的错误报告服务
  logger.debug('报告错误:', { error: error.message, type: errorType, context });
}

/**
 * 错误边界Hook
 * 用于React错误边界
 */
export function useErrorBoundary() {
  const [error, setError] = useState<Error | null>(null);

  const resetError = useCallback(() => {
    setError(null);
  }, []);

  const captureError = useCallback((error: Error) => {
    setError(error);
    logger.error('错误边界捕获错误:', error);
  }, []);

  return {
    error,
    hasError: error !== null,
    resetError,
    captureError
  };
}
