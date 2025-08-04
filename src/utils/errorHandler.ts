/**
 * 统一错误处理工具
 * 提供一致的错误处理和用户反馈机制
 */

export interface AppError {
  code: string;
  message: string;
  details?: any;
  timestamp: string;
  stack?: string;
}

export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface ErrorHandlerOptions {
  showToast?: boolean;
  logToConsole?: boolean;
  reportToService?: boolean;
  severity?: ErrorSeverity;
  fallbackMessage?: string;
}

/**
 * 错误类型枚举
 */
export const ErrorCodes = {
  // 网络错误
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT_ERROR: 'TIMEOUT_ERROR',

  // 认证错误
  AUTH_ERROR: 'AUTH_ERROR',
  PERMISSION_DENIED: 'PERMISSION_DENIED',

  // 数据错误
  DATA_VALIDATION_ERROR: 'DATA_VALIDATION_ERROR',
  DATA_NOT_FOUND: 'DATA_NOT_FOUND',
  DATA_CORRUPTION: 'DATA_CORRUPTION',

  // 存储错误
  STORAGE_ERROR: 'STORAGE_ERROR',
  STORAGE_QUOTA_EXCEEDED: 'STORAGE_QUOTA_EXCEEDED',

  // 同步错误
  SYNC_ERROR: 'SYNC_ERROR',
  SYNC_CONFLICT: 'SYNC_CONFLICT',

  // 加密错误
  ENCRYPTION_ERROR: 'ENCRYPTION_ERROR',
  DECRYPTION_ERROR: 'DECRYPTION_ERROR',

  // 通用错误
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  OPERATION_FAILED: 'OPERATION_FAILED'
} as const;

/**
 * 错误消息映射
 */
const ErrorMessages: Record<string, string> = {
  [ErrorCodes.NETWORK_ERROR]: '网络连接失败，请检查网络设置',
  [ErrorCodes.TIMEOUT_ERROR]: '操作超时，请重试',
  [ErrorCodes.AUTH_ERROR]: '认证失败，请重新登录',
  [ErrorCodes.PERMISSION_DENIED]: '权限不足，无法执行此操作',
  [ErrorCodes.DATA_VALIDATION_ERROR]: '数据格式错误',
  [ErrorCodes.DATA_NOT_FOUND]: '未找到相关数据',
  [ErrorCodes.DATA_CORRUPTION]: '数据已损坏',
  [ErrorCodes.STORAGE_ERROR]: '存储操作失败',
  [ErrorCodes.STORAGE_QUOTA_EXCEEDED]: '存储空间不足',
  [ErrorCodes.SYNC_ERROR]: '同步失败，请稍后重试',
  [ErrorCodes.SYNC_CONFLICT]: '数据冲突，请手动解决',
  [ErrorCodes.ENCRYPTION_ERROR]: '数据加密失败',
  [ErrorCodes.DECRYPTION_ERROR]: '数据解密失败',
  [ErrorCodes.UNKNOWN_ERROR]: '发生未知错误',
  [ErrorCodes.OPERATION_FAILED]: '操作失败，请重试'
};

/**
 * 创建应用错误对象
 */
export function createAppError(
  code: string,
  message?: string,
  details?: any
): AppError {
  return {
    code,
    message: message || ErrorMessages[code] || ErrorMessages[ErrorCodes.UNKNOWN_ERROR],
    details,
    timestamp: new Date().toISOString(),
    stack: new Error().stack
  };
}

/**
 * 错误处理器类
 */
export class ErrorHandler {
  private static instance: ErrorHandler;
  private toastCallback?: (message: string, type: 'error' | 'warning') => void;

  private constructor() { }

  static getInstance(): ErrorHandler {
    if (!ErrorHandler.instance) {
      ErrorHandler.instance = new ErrorHandler();
    }
    return ErrorHandler.instance;
  }

  /**
   * 设置Toast回调函数
   */
  setToastCallback(callback: (message: string, type: 'error' | 'warning') => void) {
    this.toastCallback = callback;
  }

  /**
   * 处理错误
   */
  handle(
    error: Error | AppError | string,
    options: ErrorHandlerOptions = {}
  ): AppError {
    const {
      showToast = true,
      logToConsole = true,
      reportToService = false,
      severity = 'medium',
      fallbackMessage = '操作失败，请重试'
    } = options;

    // 标准化错误对象
    let appError: AppError;

    if (typeof error === 'string') {
      appError = createAppError(ErrorCodes.UNKNOWN_ERROR, error);
    } else if (error instanceof Error) {
      appError = createAppError(
        ErrorCodes.UNKNOWN_ERROR,
        error.message || fallbackMessage,
        { originalError: error }
      );
      appError.stack = error.stack;
    } else {
      appError = error;
    }

    // 控制台日志
    if (logToConsole) {
      this.logError(appError, severity);
    }

    // 显示Toast通知
    if (showToast && this.toastCallback) {
      const toastType = severity === 'critical' || severity === 'high' ? 'error' : 'warning';
      this.toastCallback(appError.message, toastType);
    }

    // 上报错误服务（可选）
    if (reportToService) {
      this.reportError(appError, severity);
    }

    return appError;
  }

  /**
   * 过滤敏感信息
   */
  private sanitizeErrorData(data: any): any {
    if (typeof data === 'string') {
      return this.sanitizeString(data);
    }

    if (Array.isArray(data)) {
      return data.map(item => this.sanitizeErrorData(item));
    }

    if (data && typeof data === 'object') {
      const sanitized: any = {};
      for (const [key, value] of Object.entries(data)) {
        // 过滤敏感字段
        if (this.isSensitiveField(key)) {
          sanitized[key] = '[REDACTED]';
        } else {
          sanitized[key] = this.sanitizeErrorData(value);
        }
      }
      return sanitized;
    }

    return data;
  }

  /**
   * 检查是否为敏感字段
   */
  private isSensitiveField(fieldName: string): boolean {
    const sensitiveFields = [
      'password', 'token', 'key', 'secret', 'auth', 'credential',
      'email', 'phone', 'address', 'ssn', 'credit', 'card',
      'api_key', 'access_token', 'refresh_token', 'session_id',
      'user_id', 'device_id', 'supabase', 'anon_key'
    ];

    const lowerFieldName = fieldName.toLowerCase();
    return sensitiveFields.some(sensitive =>
      lowerFieldName.includes(sensitive)
    );
  }

  /**
   * 清理字符串中的敏感信息
   */
  private sanitizeString(str: string): string {
    // 移除可能的JWT token
    str = str.replace(/eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*/g, '[JWT_TOKEN]');

    // 移除可能的API密钥
    str = str.replace(/[a-zA-Z0-9]{32,}/g, '[API_KEY]');

    // 移除chrome-extension:// URLs
    str = str.replace(/chrome-extension:\/\/[a-z]+/g, '[EXTENSION_URL]');

    // 移除邮箱地址
    str = str.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]');

    return str;
  }

  /**
   * 记录错误日志（安全版本）
   */
  private logError(error: AppError, severity: ErrorSeverity) {
    const logMethod = severity === 'critical' || severity === 'high' ? 'error' : 'warn';

    // 在生产环境中过滤敏感信息
    const isProduction = !import.meta.env.DEV;

    const logData = {
      message: isProduction ? this.sanitizeString(error.message) : error.message,
      timestamp: error.timestamp,
      details: isProduction ? this.sanitizeErrorData(error.details) : error.details,
      stack: isProduction ? '[STACK_TRACE_REDACTED]' : error.stack
    };

    console[logMethod](`[${severity.toUpperCase()}] ${error.code}:`, logData);
  }

  /**
   * 上报错误到服务端（占位实现）
   */
  private reportError(error: AppError, severity: ErrorSeverity) {
    // 这里可以实现错误上报逻辑
    // 例如发送到错误监控服务
    console.log('Error reported:', { error, severity });
  }

  /**
   * 处理异步操作错误
   */
  async handleAsync<T>(
    operation: () => Promise<T>,
    options: ErrorHandlerOptions = {}
  ): Promise<T | null> {
    try {
      return await operation();
    } catch (error) {
      this.handle(error as Error, options);
      return null;
    }
  }

  /**
   * 创建错误处理装饰器
   */
  withErrorHandling<T extends (...args: any[]) => any>(
    fn: T,
    options: ErrorHandlerOptions = {}
  ): T {
    return ((...args: Parameters<T>) => {
      try {
        const result = fn(...args);

        // 如果返回Promise，处理异步错误
        if (result instanceof Promise) {
          return result.catch(error => {
            this.handle(error, options);
            throw error;
          });
        }

        return result;
      } catch (error) {
        this.handle(error as Error, options);
        throw error;
      }
    }) as T;
  }
}

// 导出单例实例
export const errorHandler = ErrorHandler.getInstance();

/**
 * 便捷的错误处理函数
 */
export function handleError(
  error: Error | AppError | string,
  options?: ErrorHandlerOptions
): AppError {
  return errorHandler.handle(error, options);
}

/**
 * 异步错误处理函数
 */
export async function handleAsyncError<T>(
  operation: () => Promise<T>,
  options?: ErrorHandlerOptions
): Promise<T | null> {
  return errorHandler.handleAsync(operation, options);
}
