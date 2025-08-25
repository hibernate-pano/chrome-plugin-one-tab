/**
 * React错误边界组件
 * 捕获React组件树中的JavaScript错误并显示友好的错误界面
 */

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { globalErrorHandler } from '@/shared/utils/globalErrorHandler';
import { feedback } from '@/shared/utils/feedback';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  showErrorDetails?: boolean;
}

interface State {
  hasError: boolean;
  error?: Error;
  errorInfo?: ErrorInfo;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    // 更新state以显示错误UI
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // 记录错误信息
    this.setState({ errorInfo });

    // 调用全局错误处理器
    globalErrorHandler.reportError(error, 'react-error-boundary');

    // 调用自定义错误处理函数
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }

    // 在开发环境中输出详细错误信息
    if (process.env.NODE_ENV === 'development') {
      console.error('ErrorBoundary caught an error:', error, errorInfo);
    }
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: undefined, errorInfo: undefined });
  };

  handleReload = () => {
    window.location.reload();
  };

  handleReportError = () => {
    const { error } = this.state;
    if (error) {
      const errorReport = {
        message: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString(),
        url: window.location.href,
        userAgent: navigator.userAgent,
      };

      // 这里可以发送错误报告到服务器
      console.log('Error report:', errorReport);
      
      feedback.success('错误报告已发送，感谢您的反馈');
    }
  };

  render() {
    if (this.state.hasError) {
      // 如果提供了自定义fallback，使用它
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // 默认错误UI
      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
          <div className="max-w-md w-full bg-white dark:bg-gray-800 rounded-lg shadow-lg p-6">
            <div className="flex items-center justify-center w-12 h-12 mx-auto bg-red-100 dark:bg-red-900/20 rounded-full mb-4">
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
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z"
                />
              </svg>
            </div>

            <div className="text-center">
              <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">
                页面出现错误
              </h1>
              <p className="text-gray-600 dark:text-gray-400 mb-6">
                抱歉，页面遇到了一个意外错误。您可以尝试刷新页面或重新开始。
              </p>

              {this.props.showErrorDetails && this.state.error && (
                <div className="mb-6 p-4 bg-gray-100 dark:bg-gray-700 rounded-lg text-left">
                  <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">
                    错误详情：
                  </h3>
                  <p className="text-xs text-gray-600 dark:text-gray-400 font-mono break-all">
                    {this.state.error.message}
                  </p>
                  {process.env.NODE_ENV === 'development' && this.state.error.stack && (
                    <details className="mt-2">
                      <summary className="text-xs text-gray-500 cursor-pointer">
                        查看堆栈跟踪
                      </summary>
                      <pre className="text-xs text-gray-600 dark:text-gray-400 mt-2 whitespace-pre-wrap">
                        {this.state.error.stack}
                      </pre>
                    </details>
                  )}
                </div>
              )}

              <div className="flex flex-col sm:flex-row gap-3">
                <button
                  onClick={this.handleRetry}
                  className="flex-1 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors"
                >
                  重试
                </button>
                <button
                  onClick={this.handleReload}
                  className="flex-1 bg-gray-600 text-white px-4 py-2 rounded-lg hover:bg-gray-700 transition-colors"
                >
                  刷新页面
                </button>
              </div>

              <button
                onClick={this.handleReportError}
                className="mt-3 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 underline"
              >
                报告此错误
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// 高阶组件：为组件添加错误边界
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

// Hook：在函数组件中使用错误边界
export function useErrorHandler() {
  return (error: Error, errorInfo?: any) => {
    globalErrorHandler.reportError(error, 'manual-report');
  };
}

// 轻量级错误边界组件
export const SimpleErrorBoundary: React.FC<{ children: ReactNode; fallback?: ReactNode }> = ({
  children,
  fallback,
}) => (
  <ErrorBoundary
    fallback={
      fallback || (
        <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <div className="flex items-center">
            <svg
              className="w-5 h-5 text-red-600 dark:text-red-400 mr-2"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z"
              />
            </svg>
            <span className="text-sm text-red-800 dark:text-red-200">
              此部分内容暂时无法显示
            </span>
          </div>
        </div>
      )
    }
  >
    {children}
  </ErrorBoundary>
);

export default ErrorBoundary;
