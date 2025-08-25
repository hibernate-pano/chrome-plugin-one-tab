/**
 * 代码去重工具集
 * 提供通用的重复代码模式和可复用的函数
 */

import { logger } from './logger';

/**
 * 通用确认对话框配置接口
 */
export interface ConfirmDialogConfig {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  confirmButtonClass?: string;
  cancelButtonClass?: string;
  onConfirm: () => void | Promise<void>;
  onCancel?: () => void;
  showCloseButton?: boolean;
  maxWidth?: string;
}

/**
 * 通用确认对话框组件属性
 */
export interface ConfirmDialogProps {
  isOpen: boolean;
  config: ConfirmDialogConfig;
  onClose: () => void;
}

/**
 * 通用错误处理配置
 */
export interface ErrorHandlingConfig {
  context: string;
  showToast?: boolean;
  logToConsole?: boolean;
  reportToService?: boolean;
  retryAction?: () => void;
  fallbackAction?: () => void;
}

/**
 * 通用加载状态配置
 */
export interface LoadingStateConfig {
  message: string;
  showSpinner?: boolean;
  showProgress?: boolean;
  progress?: number;
  cancelable?: boolean;
  onCancel?: () => void;
}

/**
 * 通用异步操作结果
 */
export interface AsyncOperationResult<T = any> {
  success: boolean;
  data?: T;
  error?: Error;
  message?: string;
  metadata?: Record<string, any>;
}

/**
 * 通用重试配置
 */
export interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
  retryCondition?: (error: Error) => boolean;
}

/**
 * 默认重试配置
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 10000,
  backoffMultiplier: 2,
  retryCondition: (error) => {
    // 默认重试网络错误和临时错误
    return error.name === 'NetworkError' || 
           error.message.includes('timeout') ||
           error.message.includes('fetch');
  }
};

/**
 * 通用异步操作包装器
 * 统一处理加载状态、错误处理和重试逻辑
 */
export class AsyncOperationWrapper {
  /**
   * 执行异步操作
   */
  static async execute<T>(
    operation: () => Promise<T>,
    config: {
      loading?: LoadingStateConfig;
      error?: ErrorHandlingConfig;
      retry?: Partial<RetryConfig>;
      timeout?: number;
    } = {}
  ): Promise<AsyncOperationResult<T>> {
    const {
      loading,
      error: errorConfig,
      retry: retryConfig,
      timeout = 30000
    } = config;

    const finalRetryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
    let lastError: Error;
    let loadingId: string | undefined;

    // 显示加载状态
    if (loading) {
      loadingId = this.showLoading(loading);
    }

    try {
      // 执行带重试的操作
      const result = await this.executeWithRetry(
        operation,
        finalRetryConfig,
        timeout
      );

      // 隐藏加载状态
      if (loadingId) {
        this.hideLoading(loadingId);
      }

      return {
        success: true,
        data: result,
        message: '操作成功完成'
      };

    } catch (error) {
      lastError = error as Error;

      // 隐藏加载状态
      if (loadingId) {
        this.hideLoading(loadingId);
      }

      // 处理错误
      if (errorConfig) {
        this.handleError(lastError, errorConfig);
      }

      return {
        success: false,
        error: lastError,
        message: lastError.message || '操作失败'
      };
    }
  }

  /**
   * 带重试的执行
   */
  private static async executeWithRetry<T>(
    operation: () => Promise<T>,
    retryConfig: RetryConfig,
    timeout: number
  ): Promise<T> {
    let lastError: Error;

    for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
      try {
        // 添加超时控制
        const result = await Promise.race([
          operation(),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('操作超时')), timeout);
          })
        ]);

        return result;

      } catch (error) {
        lastError = error as Error;

        // 检查是否应该重试
        if (attempt < retryConfig.maxRetries && 
            retryConfig.retryCondition?.(lastError)) {
          
          // 计算延迟时间
          const delay = Math.min(
            retryConfig.baseDelay * Math.pow(retryConfig.backoffMultiplier, attempt),
            retryConfig.maxDelay
          );

          logger.warn(`操作失败，${delay}ms后重试 (${attempt + 1}/${retryConfig.maxRetries})`, lastError);
          
          // 等待后重试
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          throw lastError;
        }
      }
    }

    throw lastError!;
  }

  /**
   * 显示加载状态
   */
  private static showLoading(config: LoadingStateConfig): string {
    // 这里应该调用实际的加载显示逻辑
    // 为了避免循环依赖，这里返回一个模拟的ID
    logger.debug('显示加载状态:', config.message);
    return `loading_${Date.now()}`;
  }

  /**
   * 隐藏加载状态
   */
  private static hideLoading(id: string): void {
    logger.debug('隐藏加载状态:', { id });
  }

  /**
   * 处理错误
   */
  private static handleError(error: Error, config: ErrorHandlingConfig): void {
    if (config.logToConsole) {
      logger.error(`[${config.context}] 操作失败:`, error);
    }

    if (config.showToast) {
      // 这里应该调用实际的Toast显示逻辑
      logger.debug('显示错误Toast:', { message: error.message });
    }

    if (config.reportToService) {
      // 这里应该调用错误报告服务
      logger.debug('报告错误到服务:', error);
    }
  }
}

/**
 * 通用状态管理器
 * 用于管理组件的通用状态模式
 */
export class CommonStateManager {
  /**
   * 创建加载状态管理器
   */
  static createLoadingState() {
    return {
      loading: false,
      error: null as Error | null,
      data: null as any,
      
      setLoading: (loading: boolean) => ({ loading, error: null }),
      setError: (error: Error) => ({ loading: false, error, data: null }),
      setData: (data: any) => ({ loading: false, error: null, data }),
      reset: () => ({ loading: false, error: null, data: null })
    };
  }

  /**
   * 创建分页状态管理器
   */
  static createPaginationState(initialPageSize: number = 20) {
    return {
      page: 1,
      pageSize: initialPageSize,
      total: 0,
      hasMore: true,
      
      nextPage: (currentPage: number) => currentPage + 1,
      prevPage: (currentPage: number) => Math.max(1, currentPage - 1),
      setPage: (page: number) => page,
      setPageSize: (pageSize: number) => pageSize,
      setTotal: (total: number) => total,
      updateHasMore: (page: number, pageSize: number, total: number) => 
        page * pageSize < total
    };
  }

  /**
   * 创建选择状态管理器
   */
  static createSelectionState<T extends { id: string }>() {
    return {
      selectedItems: new Set<string>(),
      isSelectionMode: false,
      
      toggleSelection: (itemId: string, selected: Set<string>) => {
        const newSelected = new Set(selected);
        if (newSelected.has(itemId)) {
          newSelected.delete(itemId);
        } else {
          newSelected.add(itemId);
        }
        return newSelected;
      },
      
      selectAll: (items: T[]) => new Set(items.map(item => item.id)),
      clearSelection: () => new Set<string>(),
      
      isSelected: (itemId: string, selected: Set<string>) => selected.has(itemId),
      getSelectedCount: (selected: Set<string>) => selected.size,
      
      toggleSelectionMode: (isSelectionMode: boolean) => !isSelectionMode
    };
  }
}

/**
 * 通用验证器
 * 提供常用的数据验证逻辑
 */
export class CommonValidator {
  /**
   * 验证必填字段
   */
  static required(value: any, fieldName: string): string | null {
    if (value === null || value === undefined || value === '') {
      return `${fieldName}不能为空`;
    }
    return null;
  }

  /**
   * 验证字符串长度
   */
  static stringLength(
    value: string, 
    min: number, 
    max: number, 
    fieldName: string
  ): string | null {
    if (value.length < min) {
      return `${fieldName}长度不能少于${min}个字符`;
    }
    if (value.length > max) {
      return `${fieldName}长度不能超过${max}个字符`;
    }
    return null;
  }

  /**
   * 验证URL格式
   */
  static url(value: string, fieldName: string): string | null {
    try {
      new URL(value);
      return null;
    } catch {
      return `${fieldName}格式不正确`;
    }
  }

  /**
   * 验证邮箱格式
   */
  static email(value: string, fieldName: string): string | null {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(value)) {
      return `${fieldName}格式不正确`;
    }
    return null;
  }

  /**
   * 组合验证器
   */
  static combine(
    value: any,
    validators: Array<(value: any) => string | null>
  ): string[] {
    const errors: string[] = [];
    
    for (const validator of validators) {
      const error = validator(value);
      if (error) {
        errors.push(error);
      }
    }
    
    return errors;
  }
}

/**
 * 通用格式化器
 * 提供常用的数据格式化功能
 */
export class CommonFormatter {
  /**
   * 格式化文件大小
   */
  static fileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * 格式化时间差
   */
  static timeAgo(date: Date | string): string {
    const now = new Date();
    const target = typeof date === 'string' ? new Date(date) : date;
    const diffMs = now.getTime() - target.getTime();
    
    const diffSeconds = Math.floor(diffMs / 1000);
    const diffMinutes = Math.floor(diffSeconds / 60);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);
    
    if (diffSeconds < 60) return '刚刚';
    if (diffMinutes < 60) return `${diffMinutes}分钟前`;
    if (diffHours < 24) return `${diffHours}小时前`;
    if (diffDays < 7) return `${diffDays}天前`;
    
    return target.toLocaleDateString('zh-CN');
  }

  /**
   * 格式化数字
   */
  static number(value: number, options: {
    decimals?: number;
    separator?: string;
    prefix?: string;
    suffix?: string;
  } = {}): string {
    const {
      decimals = 0,
      separator = ',',
      prefix = '',
      suffix = ''
    } = options;

    const formatted = value.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, separator);
    return `${prefix}${formatted}${suffix}`;
  }

  /**
   * 截断文本
   */
  static truncate(text: string, maxLength: number, suffix: string = '...'): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - suffix.length) + suffix;
  }
}

/**
 * 通用工具函数
 */
export class CommonUtils {
  /**
   * 防抖函数
   */
  static debounce<T extends (...args: any[]) => any>(
    func: T,
    delay: number
  ): (...args: Parameters<T>) => void {
    let timeoutId: NodeJS.Timeout;
    
    return (...args: Parameters<T>) => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => func(...args), delay);
    };
  }

  /**
   * 节流函数
   */
  static throttle<T extends (...args: any[]) => any>(
    func: T,
    delay: number
  ): (...args: Parameters<T>) => void {
    let lastCall = 0;
    
    return (...args: Parameters<T>) => {
      const now = Date.now();
      if (now - lastCall >= delay) {
        lastCall = now;
        func(...args);
      }
    };
  }

  /**
   * 深拷贝
   */
  static deepClone<T>(obj: T): T {
    if (obj === null || typeof obj !== 'object') return obj;
    if (obj instanceof Date) return new Date(obj.getTime()) as any;
    if (obj instanceof Array) return obj.map(item => this.deepClone(item)) as any;
    if (typeof obj === 'object') {
      const cloned = {} as any;
      for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
          cloned[key] = this.deepClone(obj[key]);
        }
      }
      return cloned;
    }
    return obj;
  }

  /**
   * 生成唯一ID
   */
  static generateId(prefix: string = ''): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2);
    return `${prefix}${timestamp}${random}`;
  }

  /**
   * 安全的JSON解析
   */
  static safeJsonParse<T>(json: string, defaultValue: T): T {
    try {
      return JSON.parse(json);
    } catch {
      return defaultValue;
    }
  }

  /**
   * 检查对象是否为空
   */
  static isEmpty(obj: any): boolean {
    if (obj === null || obj === undefined) return true;
    if (typeof obj === 'string') return obj.trim() === '';
    if (Array.isArray(obj)) return obj.length === 0;
    if (typeof obj === 'object') return Object.keys(obj).length === 0;
    return false;
  }

  /**
   * 数组去重
   */
  static unique<T>(array: T[], keyFn?: (item: T) => any): T[] {
    if (!keyFn) {
      return Array.from(new Set(array));
    }
    
    const seen = new Set();
    return array.filter(item => {
      const key = keyFn(item);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  /**
   * 数组分组
   */
  static groupBy<T>(array: T[], keyFn: (item: T) => string): Record<string, T[]> {
    return array.reduce((groups, item) => {
      const key = keyFn(item);
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(item);
      return groups;
    }, {} as Record<string, T[]>);
  }
}
