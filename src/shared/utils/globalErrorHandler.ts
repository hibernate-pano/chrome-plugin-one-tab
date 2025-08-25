/**
 * 全局错误处理器
 * 捕获和处理应用中的未处理错误
 */

import { feedback } from './feedback';
import { mapError, createUserFriendlyError } from './errorMapping';

export interface ErrorReport {
  error: any;
  context?: string;
  timestamp: number;
  userAgent: string;
  url: string;
}

class GlobalErrorHandler {
  private errorReports: ErrorReport[] = [];
  private maxReports = 50; // 最多保存50个错误报告
  private isInitialized = false;

  /**
   * 初始化全局错误处理器
   */
  initialize() {
    if (this.isInitialized) {
      return;
    }

    // 捕获未处理的Promise拒绝
    window.addEventListener('unhandledrejection', (event) => {
      this.handleError(event.reason, 'unhandledrejection');
      event.preventDefault(); // 阻止默认的控制台错误输出
    });

    // 捕获JavaScript运行时错误
    window.addEventListener('error', (event) => {
      this.handleError(event.error || event.message, 'javascript-error');
    });

    // 捕获资源加载错误
    window.addEventListener('error', (event) => {
      if (event.target !== window) {
        this.handleError(
          new Error(`Resource failed to load: ${(event.target as any)?.src || (event.target as any)?.href}`),
          'resource-error'
        );
      }
    }, true);

    this.isInitialized = true;
    console.log('🛡️ Global error handler initialized');
  }

  /**
   * 处理错误
   */
  handleError(error: any, context?: string) {
    // 记录错误报告
    const errorReport: ErrorReport = {
      error,
      context,
      timestamp: Date.now(),
      userAgent: navigator.userAgent,
      url: window.location.href,
    };

    this.addErrorReport(errorReport);

    // 根据错误类型决定是否显示用户反馈
    if (this.shouldShowUserFeedback(error, context)) {
      this.showUserFeedback(error, context);
    }

    // 记录到控制台（开发环境）
    if (process.env.NODE_ENV === 'development') {
      console.error('🚨 Global error caught:', error, 'Context:', context);
    }
  }

  /**
   * 判断是否应该显示用户反馈
   */
  private shouldShowUserFeedback(error: any, context?: string): boolean {
    // 资源加载错误通常不需要显示给用户
    if (context === 'resource-error') {
      return false;
    }

    // 网络错误显示给用户
    if (this.isNetworkError(error)) {
      return true;
    }

    // 认证错误显示给用户
    if (this.isAuthError(error)) {
      return true;
    }

    // 业务逻辑错误显示给用户
    if (this.isBusinessError(error)) {
      return true;
    }

    // 其他错误根据严重程度决定
    return this.isUserFacingError(error);
  }

  /**
   * 显示用户反馈
   */
  private showUserFeedback(error: any, context?: string) {
    try {
      // 使用智能错误处理
      feedback.smartError(error, {
        showToast: true,
        logToConsole: false, // 避免重复日志
        contactSupport: this.isCriticalError(error),
      });
    } catch (feedbackError) {
      // 如果反馈系统也出错，使用最基本的提示
      console.error('Failed to show error feedback:', feedbackError);
      alert('应用出现错误，请刷新页面重试');
    }
  }

  /**
   * 添加错误报告
   */
  private addErrorReport(report: ErrorReport) {
    this.errorReports.unshift(report);
    
    // 保持报告数量在限制内
    if (this.errorReports.length > this.maxReports) {
      this.errorReports = this.errorReports.slice(0, this.maxReports);
    }
  }

  /**
   * 获取错误报告
   */
  getErrorReports(): ErrorReport[] {
    return [...this.errorReports];
  }

  /**
   * 清除错误报告
   */
  clearErrorReports() {
    this.errorReports = [];
  }

  /**
   * 判断是否为网络错误
   */
  private isNetworkError(error: any): boolean {
    const message = error?.message?.toLowerCase() || '';
    return message.includes('network') || 
           message.includes('fetch') || 
           message.includes('timeout') ||
           error?.code === 'NETWORK_ERROR';
  }

  /**
   * 判断是否为认证错误
   */
  private isAuthError(error: any): boolean {
    const code = error?.code?.toLowerCase() || '';
    const message = error?.message?.toLowerCase() || '';
    return code.includes('auth') || 
           code.includes('permission') ||
           message.includes('unauthorized') ||
           message.includes('forbidden') ||
           error?.status === 401 ||
           error?.status === 403;
  }

  /**
   * 判断是否为业务错误
   */
  private isBusinessError(error: any): boolean {
    // 业务错误通常有特定的错误代码或类型
    return error?.type === 'business-error' ||
           error?.code?.startsWith('BIZ_') ||
           error?.isBusiness === true;
  }

  /**
   * 判断是否为面向用户的错误
   */
  private isUserFacingError(error: any): boolean {
    // 排除一些技术性错误
    const message = error?.message?.toLowerCase() || '';
    
    // 排除脚本错误
    if (message.includes('script error')) {
      return false;
    }
    
    // 排除扩展相关错误
    if (message.includes('extension')) {
      return false;
    }
    
    // 排除非关键的控制台错误
    if (message.includes('console')) {
      return false;
    }
    
    return true;
  }

  /**
   * 判断是否为关键错误
   */
  private isCriticalError(error: any): boolean {
    // 数据丢失相关错误
    if (error?.message?.toLowerCase().includes('data loss')) {
      return true;
    }
    
    // 存储相关错误
    if (error?.message?.toLowerCase().includes('storage')) {
      return true;
    }
    
    // 同步相关错误
    if (error?.code?.includes('SYNC_')) {
      return true;
    }
    
    return false;
  }

  /**
   * 手动报告错误
   */
  reportError(error: any, context?: string) {
    this.handleError(error, context);
  }

  /**
   * 创建错误边界处理函数
   */
  createErrorBoundaryHandler() {
    return (error: Error, errorInfo: any) => {
      this.handleError(error, 'react-error-boundary');
      
      // 记录组件堆栈信息
      if (process.env.NODE_ENV === 'development') {
        console.error('React Error Boundary caught an error:', error, errorInfo);
      }
    };
  }

  /**
   * 获取错误统计
   */
  getErrorStats() {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    const oneDay = 24 * oneHour;

    const recentErrors = this.errorReports.filter(report => 
      now - report.timestamp < oneHour
    );

    const todayErrors = this.errorReports.filter(report => 
      now - report.timestamp < oneDay
    );

    const errorsByContext = this.errorReports.reduce((acc, report) => {
      const context = report.context || 'unknown';
      acc[context] = (acc[context] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    return {
      total: this.errorReports.length,
      recentCount: recentErrors.length,
      todayCount: todayErrors.length,
      byContext: errorsByContext,
    };
  }
}

// 创建全局实例
export const globalErrorHandler = new GlobalErrorHandler();

// 自动初始化（在浏览器环境中）
if (typeof window !== 'undefined') {
  // 延迟初始化，确保DOM已加载
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      globalErrorHandler.initialize();
    });
  } else {
    globalErrorHandler.initialize();
  }
}

// 默认导出
export default globalErrorHandler;
