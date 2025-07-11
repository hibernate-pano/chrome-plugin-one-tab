/**
 * 错误边界组件
 * 捕获React组件中的错误并提供用户友好的回退UI
 */
import React, { Component, ErrorInfo, ReactNode } from 'react';
import { errorHandler, ErrorContext } from '@/shared/utils/errorHandler';
import { logger } from '@/shared/utils/logger';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  context?: Partial<ErrorContext>;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorId: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorId: null,
    };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
      errorId: `error_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const context: ErrorContext = {
      component: 'ErrorBoundary',
      action: 'componentDidCatch',
      ...this.props.context,
      extra: {
        componentStack: errorInfo.componentStack,
        errorBoundary: true,
      },
    };

    // 使用统一错误处理器
    const friendlyError = errorHandler.handleAsyncError(error, context);
    
    // 调用自定义错误处理函数
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }

    // 记录错误详情
    logger.error('ErrorBoundary捕获到错误', error, {
      errorId: this.state.errorId,
      friendlyError,
      context,
    });
  }

  private handleRetry = () => {
    this.setState({
      hasError: false,
      error: null,
      errorId: null,
    });
  };

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      // 如果提供了自定义fallback，使用它
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // 默认错误UI
      return (
        <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center px-4">
          <div className="max-w-md w-full bg-white dark:bg-gray-800 rounded-lg shadow-lg p-6">
            <div className="flex items-center justify-center w-12 h-12 mx-auto bg-red-100 dark:bg-red-900 rounded-full mb-4">
              <svg
                className="w-6 h-6 text-red-600 dark:text-red-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
                />
              </svg>
            </div>
            
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 text-center mb-2">
              出现了一些问题
            </h2>
            
            <p className="text-gray-600 dark:text-gray-400 text-center mb-6">
              应用遇到了错误，但您的数据是安全的。您可以尝试刷新页面或重试操作。
            </p>

            {process.env.NODE_ENV === 'development' && this.state.error && (
              <details className="mb-4 p-3 bg-gray-100 dark:bg-gray-700 rounded">
                <summary className="text-sm font-medium text-gray-700 dark:text-gray-300 cursor-pointer">
                  错误详情 (开发模式)
                </summary>
                <pre className="mt-2 text-xs text-gray-600 dark:text-gray-400 overflow-auto">
                  {this.state.error.stack}
                </pre>
              </details>
            )}

            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={this.handleRetry}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-md transition-colors"
              >
                重试
              </button>
              <button
                onClick={this.handleReload}
                className="flex-1 bg-gray-600 hover:bg-gray-700 text-white font-medium py-2 px-4 rounded-md transition-colors"
              >
                刷新页面
              </button>
            </div>

            {this.state.errorId && (
              <p className="text-xs text-gray-500 dark:text-gray-500 text-center mt-4">
                错误ID: {this.state.errorId}
              </p>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

/**
 * 高阶组件：为组件添加错误边界
 */
export function withErrorBoundary<P extends object>(
  Component: React.ComponentType<P>,
  errorBoundaryProps?: Omit<Props, 'children'>
) {
  const WrappedComponent = (props: P) => (
    <ErrorBoundary {...errorBoundaryProps}>
      <Component {...props} />
    </ErrorBoundary>
  );

  WrappedComponent.displayName = `withErrorBoundary(${Component.displayName || Component.name})`;
  
  return WrappedComponent;
}

/**
 * Hook：在函数组件中使用错误边界
 */
export function useErrorHandler() {
  const [error, setError] = React.useState<Error | null>(null);

  const resetError = React.useCallback(() => {
    setError(null);
  }, []);

  const captureError = React.useCallback((error: Error, context?: Partial<ErrorContext>) => {
    const fullContext: ErrorContext = {
      component: 'useErrorHandler',
      ...context,
    };
    
    errorHandler.handleAsyncError(error, fullContext);
    setError(error);
  }, []);

  // 如果有错误，抛出它以被ErrorBoundary捕获
  if (error) {
    throw error;
  }

  return { captureError, resetError };
}