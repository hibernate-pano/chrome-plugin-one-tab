/**
 * 安全错误类 - 不暴露内部实现细节
 * 
 * 所有错误类都：
 * 1. 使用用户友好的错误消息
 * 2. 不包含堆栈跟踪或内部函数名
 * 3. 提供错误代码便于调试
 */

/**
 * 错误代码枚举
 */
export enum ErrorCode {
  // 加密相关
  ENCRYPTION_FAILED = 'E001',
  DECRYPTION_FAILED = 'E002',
  KEY_DERIVATION_FAILED = 'E003',
  
  // 同步相关
  SYNC_FAILED = 'E101',
  SYNC_TIMEOUT = 'E102',
  SYNC_CANCELLED = 'E103',
  SYNC_CONFLICT = 'E104',
  
  // 存储相关
  STORAGE_READ_FAILED = 'E201',
  STORAGE_WRITE_FAILED = 'E202',
  STORAGE_QUOTA_EXCEEDED = 'E203',
  
  // 网络相关
  NETWORK_ERROR = 'E301',
  AUTH_FAILED = 'E302',
  
  // 通用
  UNKNOWN_ERROR = 'E999',
}

/**
 * 基础安全错误类
 */
export class SafeError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly timestamp: string;

  constructor(
    message: string,
    code: ErrorCode = ErrorCode.UNKNOWN_ERROR,
    retryable: boolean = false
  ) {
    super(message);
    this.name = 'SafeError';
    this.code = code;
    this.retryable = retryable;
    this.timestamp = new Date().toISOString();
    
    // 清除堆栈跟踪以避免泄露内部信息
    this.stack = undefined;
  }

  /**
   * 转换为用户友好的对象
   */
  toUserFriendly(): { message: string; code: string; retryable: boolean } {
    return {
      message: this.message,
      code: this.code,
      retryable: this.retryable,
    };
  }
}

/**
 * 加密错误
 */
export class EncryptionError extends SafeError {
  constructor(message: string = '数据加密失败，请重试') {
    super(message, ErrorCode.ENCRYPTION_FAILED, true);
    this.name = 'EncryptionError';
  }
}

/**
 * 解密错误
 */
export class DecryptionError extends SafeError {
  constructor(message: string = '数据解密失败，数据可能已损坏') {
    super(message, ErrorCode.DECRYPTION_FAILED, false);
    this.name = 'DecryptionError';
  }
}

/**
 * 同步错误
 */
export class SyncError extends SafeError {
  readonly progress?: {
    total: number;
    completed: number;
    failed: number;
  };

  constructor(
    message: string = '同步失败，请检查网络连接',
    code: ErrorCode = ErrorCode.SYNC_FAILED,
    retryable: boolean = true,
    progress?: { total: number; completed: number; failed: number }
  ) {
    super(message, code, retryable);
    this.name = 'SyncError';
    this.progress = progress;
  }

  /**
   * 创建超时错误
   */
  static timeout(): SyncError {
    return new SyncError(
      '同步操作超时，请稍后重试',
      ErrorCode.SYNC_TIMEOUT,
      true
    );
  }

  /**
   * 创建取消错误
   */
  static cancelled(): SyncError {
    return new SyncError(
      '同步操作已取消',
      ErrorCode.SYNC_CANCELLED,
      false
    );
  }

  /**
   * 创建冲突错误
   */
  static conflict(): SyncError {
    return new SyncError(
      '数据存在冲突，请选择保留哪个版本',
      ErrorCode.SYNC_CONFLICT,
      false
    );
  }
}

/**
 * 存储错误
 */
export class StorageError extends SafeError {
  constructor(
    message: string = '存储操作失败',
    code: ErrorCode = ErrorCode.STORAGE_WRITE_FAILED,
    retryable: boolean = true
  ) {
    super(message, code, retryable);
    this.name = 'StorageError';
  }

  /**
   * 创建配额超出错误
   */
  static quotaExceeded(): StorageError {
    return new StorageError(
      '存储空间不足，请清理一些数据',
      ErrorCode.STORAGE_QUOTA_EXCEEDED,
      false
    );
  }
}

/**
 * 网络错误
 */
export class NetworkError extends SafeError {
  constructor(message: string = '网络连接失败，请检查网络') {
    super(message, ErrorCode.NETWORK_ERROR, true);
    this.name = 'NetworkError';
  }
}

/**
 * 认证错误
 */
export class AuthError extends SafeError {
  constructor(message: string = '认证失败，请重新登录') {
    super(message, ErrorCode.AUTH_FAILED, false);
    this.name = 'AuthError';
  }
}

/**
 * 将任意错误转换为安全错误
 */
export function toSafeError(error: unknown): SafeError {
  if (error instanceof SafeError) {
    return error;
  }
  
  if (error instanceof Error) {
    // 检查是否是已知的错误类型
    const message = error.message.toLowerCase();
    
    if (message.includes('network') || message.includes('fetch')) {
      return new NetworkError();
    }
    if (message.includes('quota')) {
      return StorageError.quotaExceeded();
    }
    if (message.includes('encrypt')) {
      return new EncryptionError();
    }
    if (message.includes('decrypt')) {
      return new DecryptionError();
    }
    if (message.includes('auth') || message.includes('unauthorized')) {
      return new AuthError();
    }
  }
  
  // 返回通用错误，不暴露原始错误信息
  return new SafeError('操作失败，请重试', ErrorCode.UNKNOWN_ERROR, true);
}
