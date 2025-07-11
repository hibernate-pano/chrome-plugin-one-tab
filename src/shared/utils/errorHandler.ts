/**
 * 统一错误处理工具
 * 提供用户友好的错误提示和错误上报机制
 */
import { logger } from './logger';

export interface ErrorContext {
  component?: string;
  action?: string;
  userId?: string;
  extra?: Record<string, any>;
}

export interface UserFriendlyError {
  title: string;
  message: string;
  action?: string;
  recoverable: boolean;
}

class ErrorHandler {
  private readonly errorMappings = new Map<string, UserFriendlyError>([
    ['NETWORK_ERROR', {
      title: '网络连接错误',
      message: '无法连接到服务器，请检查您的网络连接',
      action: '重试',
      recoverable: true,
    }],
    ['AUTH_ERROR', {
      title: '身份验证失败',
      message: '您的登录状态已过期，请重新登录',
      action: '重新登录',
      recoverable: true,
    }],
    ['STORAGE_ERROR', {
      title: '存储空间不足',
      message: '浏览器存储空间不足，请清理一些数据',
      action: '清理数据',
      recoverable: true,
    }],
    ['SYNC_ERROR', {
      title: '同步失败',
      message: '数据同步遇到问题，您的本地数据仍然安全',
      action: '手动同步',
      recoverable: true,
    }],
    ['UNKNOWN_ERROR', {
      title: '出现了一些问题',
      message: '遇到了未知错误，请重试或联系支持',
      action: '重试',
      recoverable: true,
    }],
  ]);

  /**
   * 处理异步操作错误
   */
  handleAsyncError(error: Error, context: ErrorContext): UserFriendlyError {
    const errorType = this.categorizeError(error);
    const friendlyError = this.errorMappings.get(errorType) || this.errorMappings.get('UNKNOWN_ERROR')!;
    
    // 记录错误日志
    logger.error(`异步操作错误 [${context.component || 'Unknown'}]`, error, context);
    
    // 上报错误（仅在生产环境）
    if (process.env.NODE_ENV === 'production') {
      this.reportError(error, context);
    }
    
    return friendlyError;
  }

  /**
   * 处理同步操作错误
   */
  handleSyncError(error: Error, context: ErrorContext): UserFriendlyError {
    const errorType = this.categorizeError(error);
    let friendlyError = this.errorMappings.get(errorType);
    
    // 同步错误的特殊处理
    if (errorType === 'NETWORK_ERROR') {
      friendlyError = {
        title: '同步失败',
        message: '网络连接不稳定，数据已保存到本地',
        action: '稍后重试',
        recoverable: true,
      };
    }
    
    friendlyError = friendlyError || this.errorMappings.get('UNKNOWN_ERROR')!;
    
    logger.error(`同步错误 [${context.component || 'Unknown'}]`, error, context);
    
    return friendlyError;
  }

  /**
   * 处理用户操作错误
   */
  handleUserActionError(error: Error, context: ErrorContext): UserFriendlyError {
    const errorType = this.categorizeError(error);
    const friendlyError = this.errorMappings.get(errorType) || this.errorMappings.get('UNKNOWN_ERROR')!;
    
    logger.warn(`用户操作错误 [${context.action || 'Unknown'}]: ${error.message}`, context);
    
    return friendlyError;
  }

  /**
   * 错误分类
   */
  private categorizeError(error: Error): string {
    const message = error.message.toLowerCase();
    
    if (message.includes('network') || message.includes('fetch') || message.includes('timeout')) {
      return 'NETWORK_ERROR';
    }
    
    if (message.includes('unauthorized') || message.includes('authentication') || message.includes('token')) {
      return 'AUTH_ERROR';
    }
    
    if (message.includes('storage') || message.includes('quota') || message.includes('space')) {
      return 'STORAGE_ERROR';
    }
    
    if (message.includes('sync') || message.includes('conflict') || message.includes('merge')) {
      return 'SYNC_ERROR';
    }
    
    return 'UNKNOWN_ERROR';
  }

  /**
   * 错误上报
   */
  private reportError(error: Error, context: ErrorContext): void {
    try {
      // 这里可以集成错误监控服务，如 Sentry
      const errorReport = {
        message: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString(),
        userAgent: navigator.userAgent,
        url: window.location.href,
        context,
      };
      
      // 暂时只记录到控制台，生产环境应该发送到错误监控服务
      console.error('Error Report:', errorReport);
      
    } catch (reportError) {
      logger.error('错误上报失败', reportError);
    }
  }

  /**
   * 创建错误边界处理函数
   */
  createErrorBoundaryHandler(componentName: string) {
    return (error: Error, errorInfo: any) => {
      const context: ErrorContext = {
        component: componentName,
        extra: errorInfo,
      };
      
      this.handleAsyncError(error, context);
    };
  }

  /**
   * 包装异步函数以自动处理错误
   */
  wrapAsyncFunction<T extends (...args: any[]) => Promise<any>>(
    fn: T,
    context: ErrorContext
  ): T {
    return (async (...args: any[]) => {
      try {
        return await fn(...args);
      } catch (error) {
        const friendlyError = this.handleAsyncError(error as Error, context);
        
        // 抛出用户友好的错误
        const enhancedError = new Error(friendlyError.message);
        (enhancedError as any).userFriendly = friendlyError;
        throw enhancedError;
      }
    }) as T;
  }
}

// 导出单例实例
export const errorHandler = new ErrorHandler();

// 为了向后兼容，也导出类
export { ErrorHandler };