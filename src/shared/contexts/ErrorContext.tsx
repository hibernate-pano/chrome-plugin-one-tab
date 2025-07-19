/**
 * 错误处理Context
 * 提供全局的错误处理状态和方法
 */

import React, { createContext, useContext, useState, useCallback, ReactNode, useEffect } from 'react';
import { globalErrorHandler, ErrorReport } from '@/shared/utils/globalErrorHandler';
import { feedback } from '@/shared/utils/feedback';

interface ErrorContextType {
  // 错误状态
  hasGlobalError: boolean;
  errorReports: ErrorReport[];
  errorStats: {
    total: number;
    recentCount: number;
    todayCount: number;
    byContext: Record<string, number>;
  };

  // 错误处理方法
  reportError: (error: any, context?: string) => void;
  clearErrors: () => void;
  dismissGlobalError: () => void;
  
  // 错误恢复方法
  retryLastOperation: () => void;
  setRetryHandler: (handler: () => void) => void;
}

const ErrorContext = createContext<ErrorContextType | undefined>(undefined);

export const useError = () => {
  const context = useContext(ErrorContext);
  if (context === undefined) {
    throw new Error('useError must be used within an ErrorProvider');
  }
  return context;
};

interface ErrorProviderProps {
  children: ReactNode;
}

export const ErrorProvider: React.FC<ErrorProviderProps> = ({ children }) => {
  const [hasGlobalError, setHasGlobalError] = useState(false);
  const [errorReports, setErrorReports] = useState<ErrorReport[]>([]);
  const [retryHandler, setRetryHandler] = useState<(() => void) | null>(null);

  // 获取错误统计
  const [errorStats, setErrorStats] = useState({
    total: 0,
    recentCount: 0,
    todayCount: 0,
    byContext: {} as Record<string, number>,
  });

  // 更新错误报告和统计
  const updateErrorData = useCallback(() => {
    const reports = globalErrorHandler.getErrorReports();
    const stats = globalErrorHandler.getErrorStats();
    
    setErrorReports(reports);
    setErrorStats(stats);
    
    // 如果有新的严重错误，设置全局错误状态
    const recentCriticalErrors = reports.filter(report => {
      const isRecent = Date.now() - report.timestamp < 5000; // 5秒内
      const isCritical = report.context === 'react-error-boundary' || 
                        report.error?.severity === 'critical';
      return isRecent && isCritical;
    });
    
    if (recentCriticalErrors.length > 0 && !hasGlobalError) {
      setHasGlobalError(true);
    }
  }, [hasGlobalError]);

  // 定期更新错误数据
  useEffect(() => {
    updateErrorData();
    
    const interval = setInterval(updateErrorData, 10000); // 每10秒更新一次
    
    return () => clearInterval(interval);
  }, [updateErrorData]);

  // 报告错误
  const reportError = useCallback((error: any, context?: string) => {
    globalErrorHandler.reportError(error, context);
    updateErrorData();
  }, [updateErrorData]);

  // 清除所有错误
  const clearErrors = useCallback(() => {
    globalErrorHandler.clearErrorReports();
    setHasGlobalError(false);
    updateErrorData();
  }, [updateErrorData]);

  // 关闭全局错误提示
  const dismissGlobalError = useCallback(() => {
    setHasGlobalError(false);
  }, []);

  // 重试最后一次操作
  const retryLastOperation = useCallback(() => {
    if (retryHandler) {
      try {
        retryHandler();
        setHasGlobalError(false);
        feedback.info('正在重试操作...');
      } catch (error) {
        reportError(error, 'retry-failed');
      }
    } else {
      feedback.warning('没有可重试的操作');
    }
  }, [retryHandler, reportError]);

  // 设置重试处理函数
  const setRetryHandlerCallback = useCallback((handler: () => void) => {
    setRetryHandler(() => handler);
  }, []);

  const value: ErrorContextType = {
    hasGlobalError,
    errorReports,
    errorStats,
    reportError,
    clearErrors,
    dismissGlobalError,
    retryLastOperation,
    setRetryHandler: setRetryHandlerCallback,
  };

  return (
    <ErrorContext.Provider value={value}>
      {children}
      {/* 全局错误提示 */}
      {hasGlobalError && <GlobalErrorNotification />}
    </ErrorContext.Provider>
  );
};

// 全局错误通知组件
const GlobalErrorNotification: React.FC = () => {
  const { dismissGlobalError, retryLastOperation, errorReports } = useError();
  
  const latestError = errorReports[0];
  
  if (!latestError) {
    return null;
  }

  return (
    <div className="fixed top-4 left-1/2 transform -translate-x-1/2 z-50 max-w-md w-full mx-4">
      <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 shadow-lg">
        <div className="flex items-start">
          <div className="flex-shrink-0">
            <svg
              className="h-5 w-5 text-red-400"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                clipRule="evenodd"
              />
            </svg>
          </div>
          <div className="ml-3 flex-1">
            <h3 className="text-sm font-medium text-red-800 dark:text-red-200">
              应用遇到错误
            </h3>
            <p className="mt-1 text-sm text-red-700 dark:text-red-300">
              页面可能无法正常工作，建议刷新页面或重试操作。
            </p>
            <div className="mt-3 flex space-x-2">
              <button
                onClick={retryLastOperation}
                className="bg-red-100 dark:bg-red-800/50 text-red-800 dark:text-red-200 px-3 py-1 rounded text-sm hover:bg-red-200 dark:hover:bg-red-800/70 transition-colors"
              >
                重试
              </button>
              <button
                onClick={() => window.location.reload()}
                className="bg-red-100 dark:bg-red-800/50 text-red-800 dark:text-red-200 px-3 py-1 rounded text-sm hover:bg-red-200 dark:hover:bg-red-800/70 transition-colors"
              >
                刷新页面
              </button>
            </div>
          </div>
          <div className="ml-3 flex-shrink-0">
            <button
              onClick={dismissGlobalError}
              className="text-red-400 hover:text-red-600 dark:hover:text-red-300"
            >
              <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// Hook：在组件中使用错误处理
export const useErrorHandler = () => {
  const { reportError, setRetryHandler } = useError();
  
  return {
    reportError,
    setRetryHandler,
    handleAsyncError: (error: any, retryFn?: () => void) => {
      reportError(error, 'async-operation');
      if (retryFn) {
        setRetryHandler(retryFn);
      }
    },
  };
};

export default ErrorProvider;
