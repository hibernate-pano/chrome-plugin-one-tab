/**
 * 功能级错误边界组件
 * 
 * 用于包裹应用中的独立功能区域，提供：
 * 1. 错误捕获和隔离
 * 2. 自定义回退 UI
 * 3. 错误恢复（重试）功能
 * 4. 错误日志记录
 */

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { logSanitizer } from '@/utils/logSanitizer';

interface FeatureErrorBoundaryProps {
  children: ReactNode;
  // 功能名称，用于日志和显示
  featureName?: string;
  // 自定义回退 UI
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  // 错误回调
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  // 是否显示重试按钮
  showRetry?: boolean;
  // 重试回调
  onRetry?: () => void;
}

interface FeatureErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

/**
 * 默认的错误回退 UI
 */
const DefaultFallback: React.FC<{
  featureName?: string;
  error: Error;
  onRetry?: () => void;
  showRetry?: boolean;
}> = ({ featureName, error, onRetry, showRetry = true }) => (
  <div className="feature-error-boundary p-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
    <div className="flex items-start gap-3">
      {/* 错误图标 */}
      <div className="flex-shrink-0">
        <svg
          className="w-5 h-5 text-red-500"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
      </div>

      <div className="flex-1 min-w-0">
        {/* 标题 */}
        <h3 className="text-sm font-medium text-red-800 dark:text-red-200">
          {featureName ? `${featureName}加载失败` : '组件加载失败'}
        </h3>

        {/* 错误信息 */}
        <p className="mt-1 text-sm text-red-700 dark:text-red-300">
          {error.message || '发生了未知错误'}
        </p>

        {/* 重试按钮 */}
        {showRetry && onRetry && (
          <button
            onClick={onRetry}
            className="mt-3 px-3 py-1.5 text-sm font-medium text-red-700 dark:text-red-200 bg-red-100 dark:bg-red-800/50 hover:bg-red-200 dark:hover:bg-red-800 rounded-md transition-colors"
          >
            重试
          </button>
        )}
      </div>
    </div>
  </div>
);

/**
 * 紧凑型错误回退 UI
 */
export const CompactErrorFallback: React.FC<{
  message?: string;
  onRetry?: () => void;
}> = ({ message = '加载失败', onRetry }) => (
  <div className="flex items-center gap-2 p-2 text-sm text-red-600 dark:text-red-400">
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
    <span>{message}</span>
    {onRetry && (
      <button
        onClick={onRetry}
        className="ml-2 text-red-700 dark:text-red-300 hover:underline"
      >
        重试
      </button>
    )}
  </div>
);

/**
 * 功能级错误边界
 */
export class FeatureErrorBoundary extends Component<
  FeatureErrorBoundaryProps,
  FeatureErrorBoundaryState
> {
  constructor(props: FeatureErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<FeatureErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const { featureName, onError } = this.props;

    // 记录错误日志
    logSanitizer.error(
      `[ErrorBoundary] ${featureName || '组件'}发生错误:`,
      error.message
    );
    logSanitizer.debug('[ErrorBoundary] 组件堆栈:', errorInfo.componentStack);

    // 更新状态
    this.setState({ errorInfo });

    // 调用错误回调
    if (onError) {
      onError(error, errorInfo);
    }
  }

  /**
   * 重置错误状态，允许重试
   */
  handleReset = (): void => {
    const { onRetry } = this.props;

    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });

    if (onRetry) {
      onRetry();
    }
  };

  render(): ReactNode {
    const { hasError, error } = this.state;
    const { children, featureName, fallback, showRetry = true } = this.props;

    if (hasError && error) {
      // 使用自定义回退 UI
      if (fallback) {
        if (typeof fallback === 'function') {
          return fallback(error, this.handleReset);
        }
        return fallback;
      }

      // 使用默认回退 UI
      return (
        <DefaultFallback
          featureName={featureName}
          error={error}
          onRetry={this.handleReset}
          showRetry={showRetry}
        />
      );
    }

    return children;
  }
}

/**
 * 高阶组件：为组件添加错误边界
 */
export function withErrorBoundary<P extends object>(
  WrappedComponent: React.ComponentType<P>,
  options: Omit<FeatureErrorBoundaryProps, 'children'> = {}
): React.FC<P> {
  const WithErrorBoundary: React.FC<P> = (props) => (
    <FeatureErrorBoundary {...options}>
      <WrappedComponent {...props} />
    </FeatureErrorBoundary>
  );

  WithErrorBoundary.displayName = `WithErrorBoundary(${
    WrappedComponent.displayName || WrappedComponent.name || 'Component'
  })`;

  return WithErrorBoundary;
}

export default FeatureErrorBoundary;
