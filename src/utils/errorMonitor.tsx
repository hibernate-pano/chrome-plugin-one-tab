/**
 * 增强的错误监控系统
 * 提供全局错误捕获、上报和分析功能
 */

import React from 'react';

// 错误级别
export type ErrorLevel = 'debug' | 'info' | 'warning' | 'error' | 'critical';

// 错误上下文
export interface ErrorContext {
  userId?: string;
  sessionId?: string;
  component?: string;
  action?: string;
  metadata?: Record<string, unknown>;
}

// 错误记录
export interface ErrorRecord {
  id: string;
  timestamp: string;
  level: ErrorLevel;
  message: string;
  stack?: string;
  context: ErrorContext;
  userAgent: string;
  url: string;
}

// 错误监控配置
export interface ErrorMonitorConfig {
  enabled: boolean;
  maxErrors: number; // 最大存储错误数
  sampleRate: number; // 采样率 (0-1)
  ignorePatterns: RegExp[]; // 忽略的错误模式
  onError?: (error: ErrorRecord) => void; // 错误回调
}

// 默认配置
const defaultConfig: ErrorMonitorConfig = {
  enabled: true,
  maxErrors: 100,
  sampleRate: 1.0,
  ignorePatterns: [
    /ResizeObserver loop/i,
    /Script error/i,
    /Extension context invalidated/i,
  ],
};

class ErrorMonitor {
  private config: ErrorMonitorConfig;
  private errors: ErrorRecord[] = [];
  private sessionId: string;
  private context: ErrorContext = {};

  constructor(config: Partial<ErrorMonitorConfig> = {}) {
    this.config = { ...defaultConfig, ...config };
    this.sessionId = this.generateSessionId();
    this.setupGlobalHandlers();
  }

  // 生成会话 ID
  private generateSessionId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  // 设置全局错误处理器
  private setupGlobalHandlers(): void {
    if (!this.config.enabled) return;

    // 捕获未处理的错误
    window.onerror = (message, source, lineno, colno, error) => {
      this.captureError(error || new Error(String(message)), {
        component: 'window.onerror',
        metadata: { source, lineno, colno },
      });
    };

    // 捕获未处理的 Promise 拒绝
    window.onunhandledrejection = (event) => {
      const error = event.reason instanceof Error
        ? event.reason
        : new Error(String(event.reason));
      this.captureError(error, {
        component: 'unhandledrejection',
      });
    };

    // 捕获 console.error
    const originalConsoleError = console.error;
    console.error = (...args) => {
      this.captureMessage('error', args.map(String).join(' '), {
        component: 'console.error',
      });
      originalConsoleError.apply(console, args);
    };
  }

  // 设置上下文
  setContext(context: Partial<ErrorContext>): void {
    this.context = { ...this.context, ...context };
  }

  // 清除上下文
  clearContext(): void {
    this.context = {};
  }

  // 捕获错误
  captureError(error: Error, context: ErrorContext = {}): void {
    if (!this.config.enabled) return;

    // 检查是否应该忽略
    if (this.shouldIgnore(error.message)) return;

    // 采样检查
    if (Math.random() > this.config.sampleRate) return;

    const record = this.createErrorRecord('error', error.message, error.stack, context);
    this.addError(record);
  }

  // 捕获消息
  captureMessage(level: ErrorLevel, message: string, context: ErrorContext = {}): void {
    if (!this.config.enabled) return;
    if (this.shouldIgnore(message)) return;
    if (Math.random() > this.config.sampleRate) return;

    const record = this.createErrorRecord(level, message, undefined, context);
    this.addError(record);
  }

  // 创建错误记录
  private createErrorRecord(
    level: ErrorLevel,
    message: string,
    stack?: string,
    context: ErrorContext = {}
  ): ErrorRecord {
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: new Date().toISOString(),
      level,
      message,
      stack,
      context: { ...this.context, ...context, sessionId: this.sessionId },
      userAgent: navigator.userAgent,
      url: window.location.href,
    };
  }

  // 添加错误到列表
  private addError(record: ErrorRecord): void {
    this.errors.push(record);

    // 限制存储数量
    if (this.errors.length > this.config.maxErrors) {
      this.errors = this.errors.slice(-this.config.maxErrors);
    }

    // 触发回调
    this.config.onError?.(record);

    // 在开发环境下输出到控制台
    if (process.env.NODE_ENV === 'development') {
      console.warn('[ErrorMonitor]', record);
    }
  }

  // 检查是否应该忽略
  private shouldIgnore(message: string): boolean {
    return this.config.ignorePatterns.some(pattern => pattern.test(message));
  }

  // 获取所有错误
  getErrors(): ErrorRecord[] {
    return [...this.errors];
  }

  // 获取错误统计
  getStats(): {
    total: number;
    byLevel: Record<ErrorLevel, number>;
    byComponent: Record<string, number>;
    recentErrors: ErrorRecord[];
  } {
    const byLevel: Record<ErrorLevel, number> = {
      debug: 0,
      info: 0,
      warning: 0,
      error: 0,
      critical: 0,
    };

    const byComponent: Record<string, number> = {};

    this.errors.forEach(error => {
      byLevel[error.level]++;
      const component = error.context.component || 'unknown';
      byComponent[component] = (byComponent[component] || 0) + 1;
    });

    return {
      total: this.errors.length,
      byLevel,
      byComponent,
      recentErrors: this.errors.slice(-10),
    };
  }

  // 清除错误
  clearErrors(): void {
    this.errors = [];
  }

  // 导出错误日志
  exportErrors(): string {
    return JSON.stringify(this.errors, null, 2);
  }
}

// 单例实例
export const errorMonitor = new ErrorMonitor();

// React 错误边界 HOC
export function withErrorBoundary<P extends object>(
  WrappedComponent: React.ComponentType<P>,
  componentName: string
): React.ComponentType<P> {
  return class ErrorBoundaryWrapper extends React.Component<P, { hasError: boolean }> {
    constructor(props: P) {
      super(props);
      this.state = { hasError: false };
    }

    static getDerivedStateFromError(): { hasError: boolean } {
      return { hasError: true };
    }

    componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
      errorMonitor.captureError(error, {
        component: componentName,
        metadata: { componentStack: errorInfo.componentStack },
      });
    }

    render(): React.ReactNode {
      if (this.state.hasError) {
        return (
          <div className="p-4 bg-red-50 dark:bg-red-900/20 rounded-lg">
            <p className="text-red-600 dark:text-red-400">组件加载出错</p>
            <button
              onClick={() => this.setState({ hasError: false })}
              className="mt-2 text-sm text-blue-600 hover:underline"
            >
              重试
            </button>
          </div>
        );
      }

      return <WrappedComponent {...this.props} />;
    }
  };
}
