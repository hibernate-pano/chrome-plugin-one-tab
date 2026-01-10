import React, { Component, ReactNode } from 'react';

/**
 * 全局错误边界组件
 * 捕获并处理React组件树中的未捕获错误
 */

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
  errorId: string | null;
}

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: React.ComponentType<ErrorFallbackProps>;
  onError?: (error: Error, errorInfo: React.ErrorInfo, errorId: string) => void;
  enableReporting?: boolean;
  maxRetries?: number;
}

export interface ErrorFallbackProps {
  error: Error;
  errorId: string;
  retry: () => void;
  report: () => void;
  reset: () => void;
}

/**
 * 默认错误回退组件
 */
const DefaultErrorFallback: React.FC<ErrorFallbackProps> = ({ errorId, retry, report, reset }) => (
  <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 p-4">
    <div className="max-w-md w-full bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6">
      <div className="flex items-center justify-center w-12 h-12 mx-auto mb-4 bg-red-100 dark:bg-red-900/20 rounded-full">
        <svg
          className="w-6 h-6 text-red-600 dark:text-red-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.5 0L4.268 18.5c-.77.833.192 2.5 1.732 2.5z"
          />
        </svg>
      </div>

      <h1 className="text-xl font-semibold text-center text-gray-900 dark:text-white mb-2">
        出现错误
      </h1>

      <p className="text-sm text-center text-gray-600 dark:text-gray-400 mb-4">
        应用程序遇到意外错误，已自动恢复。请重试操作。
      </p>

      <div className="text-xs text-gray-500 dark:text-gray-400 mb-4 p-3 bg-gray-50 dark:bg-gray-700 rounded font-mono break-all">
        错误ID: {errorId}
      </div>

      <div className="flex gap-3">
        <button
          onClick={retry}
          className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          重试
        </button>
        <button
          onClick={reset}
          className="px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-900 dark:text-white text-sm font-medium rounded-lg transition-colors"
        >
          重置
        </button>
      </div>

      <button
        onClick={report}
        className="w-full mt-3 px-4 py-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 text-xs rounded-lg transition-colors"
      >
        报告问题
      </button>
    </div>
  </div>
);

/**
 * 全局错误边界
 */
export class GlobalErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  private retryCount = 0;
  private maxRetries: number;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.maxRetries = props.maxRetries || 3;
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      errorId: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    const errorId = `error_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    return {
      hasError: true,
      error,
      errorId,
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    const errorId = this.state.errorId!;

    // 记录错误信息
    this.setState({ errorInfo });

    // 报告错误
    this.reportError(error, errorInfo, errorId);

    // 调用外部错误处理函数
    this.props.onError?.(error, errorInfo, errorId);

    // 自动重试（如果启用了）
    if (this.retryCount < this.maxRetries) {
      setTimeout(
        () => {
          this.retry();
        },
        1000 * (this.retryCount + 1)
      ); // 递增延迟
    }
  }

  private retry = () => {
    this.retryCount += 1;
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      errorId: null,
    });
  };

  private reset = () => {
    this.retryCount = 0;
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      errorId: null,
    });
  };

  private report = () => {
    if (!this.state.error || !this.state.errorId) return;

    const errorReport = {
      errorId: this.state.errorId,
      message: this.state.error.message,
      stack: this.state.error.stack,
      componentStack: this.state.errorInfo?.componentStack,
      userAgent: navigator.userAgent,
      url: window.location.href,
      timestamp: new Date().toISOString(),
      retryCount: this.retryCount,
    };

    // 发送错误报告（可以集成到错误报告服务）
    console.error('Error Report:', errorReport);

    // 这里可以添加实际的错误报告逻辑
    // 例如发送到错误监控服务
    this.sendErrorReport(errorReport);
  };

  private sendErrorReport(report: any) {
    // 模拟发送错误报告
    // 在实际应用中，这里应该调用错误监控服务的API
    try {
      // 示例：发送到本地存储或外部服务
      const reports = JSON.parse(localStorage.getItem('error_reports') || '[]');
      reports.push(report);

      // 只保留最近的50个错误报告
      if (reports.length > 50) {
        reports.splice(0, reports.length - 50);
      }

      localStorage.setItem('error_reports', JSON.stringify(reports));

      console.log('Error report saved locally');
    } catch (error) {
      console.error('Failed to save error report:', error);
    }
  }

  private reportError(error: Error, errorInfo: React.ErrorInfo, errorId: string) {
    // 记录到控制台
    console.group(`🚨 应用错误 [${errorId}]`);
    console.error('错误信息:', error);
    console.error('错误详情:', errorInfo);
    console.error('组件栈:', errorInfo.componentStack);
    console.groupEnd();

    // 发送到错误监控系统（如果启用了）
    if (this.props.enableReporting) {
      // 这里可以集成第三方错误监控服务
      // 例如 Sentry, LogRocket, Bugsnag 等
    }
  }

  render() {
    if (this.state.hasError && this.state.error && this.state.errorId) {
      const FallbackComponent = this.props.fallback || DefaultErrorFallback;

      return (
        <FallbackComponent
          error={this.state.error}
          errorId={this.state.errorId}
          retry={this.retry}
          report={this.report}
          reset={this.reset}
        />
      );
    }

    return this.props.children;
  }
}

/**
 * Hook版本的错误边界
 */
export const useErrorHandler = () => {
  return (error: Error, errorInfo?: { componentStack?: string }) => {
    // 记录错误
    console.error('Caught error:', error, errorInfo);

    // 可以在这里添加错误处理逻辑
    // 例如发送到错误监控服务
  };
};

/**
 * 异步操作重试工具
 */
export class RetryManager {
  static async withRetry<T>(
    operation: () => Promise<T>,
    options: {
      maxRetries?: number;
      baseDelay?: number;
      maxDelay?: number;
      backoffFactor?: number;
      retryCondition?: (error: any) => boolean;
    } = {}
  ): Promise<T> {
    const {
      maxRetries = 3,
      baseDelay = 1000,
      maxDelay = 30000,
      backoffFactor = 2,
      retryCondition = () => true,
    } = options;

    let lastError: any;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        // 检查是否应该重试
        if (attempt === maxRetries || !retryCondition(error)) {
          throw error;
        }

        // 计算延迟时间
        const delay = Math.min(baseDelay * Math.pow(backoffFactor, attempt), maxDelay);

        console.warn(
          `Operation failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms:`,
          error
        );

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  /**
   * 网络请求重试
   */
  static async fetchWithRetry(
    url: string,
    options: RequestInit & {
      maxRetries?: number;
      retryDelay?: number;
      retryOn?: number[];
    } = {}
  ): Promise<Response> {
    const {
      maxRetries = 3,
      retryDelay = 1000,
      retryOn = [408, 429, 500, 502, 503, 504],
      ...fetchOptions
    } = options;

    return this.withRetry(() => fetch(url, fetchOptions), {
      maxRetries,
      baseDelay: retryDelay,
      retryCondition: error => {
        // 如果是Response对象，检查状态码
        if (error instanceof Response) {
          return retryOn.includes(error.status);
        }
        // 如果是网络错误，重试
        return error.name === 'TypeError' || error.name === 'NetworkError';
      },
    });
  }
}

/**
 * 数据恢复管理器
 */
export class RecoveryManager {
  private static backups: Map<string, any> = new Map();

  /**
   * 创建数据备份
   */
  static createBackup(key: string, data: any): void {
    this.backups.set(key, {
      data: JSON.parse(JSON.stringify(data)), // 深拷贝
      timestamp: Date.now(),
    });
  }

  /**
   * 从备份恢复数据
   */
  static restoreBackup<T>(key: string): T | null {
    const backup = this.backups.get(key);
    if (!backup) return null;

    // 检查备份是否过期（24小时）
    if (Date.now() - backup.timestamp > 24 * 60 * 60 * 1000) {
      this.backups.delete(key);
      return null;
    }

    return backup.data;
  }

  /**
   * 清理过期备份
   */
  static cleanupExpiredBackups(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;

    for (const [key, backup] of this.backups.entries()) {
      if (backup.timestamp < cutoff) {
        this.backups.delete(key);
      }
    }
  }

  /**
   * 获取所有备份键
   */
  static getBackupKeys(): string[] {
    return Array.from(this.backups.keys());
  }

  /**
   * 清除所有备份
   */
  static clearAllBackups(): void {
    this.backups.clear();
  }
}

/**
 * 错误恢复装饰器
 */
export function withErrorRecovery<T extends any[], R>(
  fn: (...args: T) => R,
  recoveryFn?: (...args: T) => R
) {
  return (...args: T): R => {
    try {
      return fn(...args);
    } catch (error) {
      console.error('Function execution failed, attempting recovery:', error);

      if (recoveryFn) {
        try {
          return recoveryFn(...args);
        } catch (recoveryError) {
          console.error('Recovery function also failed:', recoveryError);
        }
      }

      throw error;
    }
  };
}

/**
 * 异步错误恢复装饰器
 */
export function withAsyncErrorRecovery<T extends any[], R>(
  fn: (...args: T) => Promise<R>,
  recoveryFn?: (...args: T) => Promise<R>
) {
  return async (...args: T): Promise<R> => {
    try {
      return await fn(...args);
    } catch (error) {
      console.error('Async function execution failed, attempting recovery:', error);

      if (recoveryFn) {
        try {
          return await recoveryFn(...args);
        } catch (recoveryError) {
          console.error('Recovery function also failed:', recoveryError);
        }
      }

      throw error;
    }
  };
}
