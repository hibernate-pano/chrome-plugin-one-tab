/**
 * 专用错误处理函数集合
 * 为不同业务场景提供专门的错误处理逻辑
 */

import { feedback } from './feedback';
import { globalErrorHandler } from './globalErrorHandler';
import { FEEDBACK_MESSAGES } from '../constants/feedbackMessages';

/**
 * 网络错误处理器
 */
export class NetworkErrorHandler {
  static handle(error: any, retryFn?: () => void) {
    const isOffline = !navigator.onLine;
    
    if (isOffline) {
      feedback.warning(FEEDBACK_MESSAGES.NETWORK.OFFLINE, {
        duration: 0,
        action: retryFn ? {
          label: '重试',
          onClick: retryFn,
        } : undefined,
      });
    } else {
      feedback.smartError(error, {
        retryAction: retryFn,
      });
    }
    
    globalErrorHandler.reportError(error, 'network-error');
  }

  static handleTimeout(retryFn?: () => void) {
    feedback.warning(FEEDBACK_MESSAGES.NETWORK.TIMEOUT, {
      action: retryFn ? {
        label: '重试',
        onClick: retryFn,
      } : undefined,
    });
  }

  static handleServerError(status: number, retryFn?: () => void) {
    let message = FEEDBACK_MESSAGES.NETWORK.SERVER_ERROR;
    
    switch (status) {
      case 500:
        message = '服务器内部错误，请稍后重试';
        break;
      case 502:
        message = '服务器网关错误，请稍后重试';
        break;
      case 503:
        message = '服务暂时不可用，请稍后重试';
        break;
      case 504:
        message = '服务器响应超时，请稍后重试';
        break;
    }
    
    feedback.error(message, {
      retryAction: retryFn,
    });
  }
}

/**
 * 认证错误处理器
 */
export class AuthErrorHandler {
  static handle(error: any) {
    const errorCode = error?.code || error?.message;
    
    switch (errorCode) {
      case 'auth/user-not-found':
      case 'user-not-found':
        feedback.error(FEEDBACK_MESSAGES.AUTH.LOGIN_ERROR);
        break;
        
      case 'auth/wrong-password':
      case 'wrong-password':
        feedback.error('密码错误，请重新输入');
        break;
        
      case 'auth/email-already-in-use':
      case 'email-already-in-use':
        feedback.error(FEEDBACK_MESSAGES.AUTH.EMAIL_ALREADY_EXISTS);
        break;
        
      case 'auth/weak-password':
      case 'weak-password':
        feedback.error(FEEDBACK_MESSAGES.AUTH.PASSWORD_TOO_SHORT);
        break;
        
      case 'auth/invalid-email':
      case 'invalid-email':
        feedback.error(FEEDBACK_MESSAGES.AUTH.EMAIL_INVALID);
        break;
        
      case 'auth/too-many-requests':
      case 'too-many-requests':
        feedback.error('登录尝试次数过多，请稍后再试');
        break;
        
      case 'auth/requires-recent-login':
      case 'requires-recent-login':
        feedback.authError();
        break;
        
      default:
        feedback.smartError(error);
    }
    
    globalErrorHandler.reportError(error, 'auth-error');
  }

  static handleSessionExpired() {
    feedback.authError();
  }

  static handlePermissionDenied() {
    feedback.permissionError();
  }
}

/**
 * 同步错误处理器
 */
export class SyncErrorHandler {
  static handle(error: any, retryFn?: () => void) {
    const errorCode = error?.code || error?.type;
    
    switch (errorCode) {
      case 'sync-conflict':
        feedback.conflictError(() => {
          // 这里可以打开冲突解决界面
          console.log('Open conflict resolution UI');
        });
        break;
        
      case 'quota-exceeded':
        feedback.error('存储空间不足，请清理部分数据', {
          action: {
            label: '管理存储',
            onClick: () => {
              // 打开存储管理界面
              console.log('Open storage management');
            },
          },
        });
        break;
        
      case 'version-mismatch':
        feedback.error('版本不匹配，请更新应用', {
          action: {
            label: '刷新页面',
            onClick: () => window.location.reload(),
          },
        });
        break;
        
      case 'invalid-data':
        feedback.error('数据格式错误，请重新同步', {
          retryAction: retryFn,
        });
        break;
        
      default:
        feedback.smartError(error, {
          retryAction: retryFn,
        });
    }
    
    globalErrorHandler.reportError(error, 'sync-error');
  }

  static handleUploadError(error: any, retryFn?: () => void) {
    feedback.error(FEEDBACK_MESSAGES.SYNC.UPLOAD_ERROR, {
      retryAction: retryFn,
    });
    globalErrorHandler.reportError(error, 'sync-upload-error');
  }

  static handleDownloadError(error: any, retryFn?: () => void) {
    feedback.error(FEEDBACK_MESSAGES.SYNC.DOWNLOAD_ERROR, {
      retryAction: retryFn,
    });
    globalErrorHandler.reportError(error, 'sync-download-error');
  }
}

/**
 * 文件操作错误处理器
 */
export class FileErrorHandler {
  static handle(error: any, filename?: string) {
    const errorCode = error?.code || error?.type;
    
    switch (errorCode) {
      case 'file-too-large':
        feedback.error(`文件 "${filename}" 过大，请选择小于10MB的文件`);
        break;
        
      case 'invalid-file-type':
        feedback.error(`文件 "${filename}" 格式不支持`);
        break;
        
      case 'file-corrupted':
        feedback.error(`文件 "${filename}" 已损坏，请选择其他文件`);
        break;
        
      case 'permission-denied':
        feedback.error('文件访问权限不足');
        break;
        
      case 'disk-full':
        feedback.error('存储空间不足，请清理磁盘空间');
        break;
        
      default:
        feedback.smartError(error);
    }
    
    globalErrorHandler.reportError(error, 'file-error');
  }

  static handleUploadError(filename: string, error: any, retryFn?: () => void) {
    feedback.file.uploadError(filename, error?.message || '上传失败');
    if (retryFn) {
      setTimeout(() => {
        feedback.info('您可以重新尝试上传文件', {
          action: {
            label: '重试',
            onClick: retryFn,
          },
        });
      }, 2000);
    }
  }

  static handleDownloadError(filename: string, error: any, retryFn?: () => void) {
    feedback.file.downloadError(filename, error?.message || '下载失败');
    if (retryFn) {
      setTimeout(() => {
        feedback.info('您可以重新尝试下载文件', {
          action: {
            label: '重试',
            onClick: retryFn,
          },
        });
      }, 2000);
    }
  }
}

/**
 * 浏览器API错误处理器
 */
export class BrowserErrorHandler {
  static handle(error: any) {
    const errorMessage = error?.message?.toLowerCase() || '';
    
    if (errorMessage.includes('quota') || errorMessage.includes('storage')) {
      feedback.error('浏览器存储空间不足，请清理浏览器数据', {
        action: {
          label: '清理指南',
          onClick: () => {
            // 打开清理指南
            window.open('https://support.google.com/chrome/answer/2392709', '_blank');
          },
        },
      });
    } else if (errorMessage.includes('permission')) {
      feedback.error('浏览器权限被拒绝，请在设置中允许相关权限');
    } else if (errorMessage.includes('not supported')) {
      feedback.error('浏览器不支持此功能，请更新到最新版本');
    } else {
      feedback.smartError(error);
    }
    
    globalErrorHandler.reportError(error, 'browser-error');
  }

  static handleStorageQuotaExceeded() {
    feedback.error('本地存储空间不足', {
      action: {
        label: '清理数据',
        onClick: () => {
          // 打开数据清理界面
          console.log('Open data cleanup UI');
        },
      },
    });
  }

  static handlePermissionDenied(permission: string) {
    feedback.error(`浏览器${permission}权限被拒绝`, {
      action: {
        label: '设置权限',
        onClick: () => {
          feedback.info('请在浏览器地址栏左侧的锁图标中允许相关权限');
        },
      },
    });
  }
}

/**
 * 通用错误处理器
 */
export class GenericErrorHandler {
  static handle(error: any, context?: string, retryFn?: () => void) {
    // 根据错误类型选择合适的处理器
    if (this.isNetworkError(error)) {
      NetworkErrorHandler.handle(error, retryFn);
    } else if (this.isAuthError(error)) {
      AuthErrorHandler.handle(error);
    } else if (this.isSyncError(error)) {
      SyncErrorHandler.handle(error, retryFn);
    } else if (this.isFileError(error)) {
      FileErrorHandler.handle(error);
    } else if (this.isBrowserError(error)) {
      BrowserErrorHandler.handle(error);
    } else {
      // 使用智能错误处理作为后备
      feedback.smartError(error, {
        retryAction: retryFn,
      });
      globalErrorHandler.reportError(error, context || 'generic-error');
    }
  }

  private static isNetworkError(error: any): boolean {
    const message = error?.message?.toLowerCase() || '';
    return message.includes('network') || 
           message.includes('fetch') || 
           message.includes('timeout') ||
           error?.code === 'NETWORK_ERROR';
  }

  private static isAuthError(error: any): boolean {
    const code = error?.code?.toLowerCase() || '';
    return code.includes('auth') || 
           code.includes('permission') ||
           error?.status === 401 ||
           error?.status === 403;
  }

  private static isSyncError(error: any): boolean {
    const code = error?.code || error?.type || '';
    return code.includes('sync') || 
           code.includes('conflict') ||
           code.includes('quota');
  }

  private static isFileError(error: any): boolean {
    const code = error?.code || error?.type || '';
    return code.includes('file') || 
           code.includes('upload') ||
           code.includes('download');
  }

  private static isBrowserError(error: any): boolean {
    const message = error?.message?.toLowerCase() || '';
    return message.includes('quota') || 
           message.includes('storage') ||
           message.includes('permission') ||
           message.includes('not supported');
  }
}

// 导出便捷函数
export const handleError = GenericErrorHandler.handle.bind(GenericErrorHandler);
export const handleNetworkError = NetworkErrorHandler.handle.bind(NetworkErrorHandler);
export const handleAuthError = AuthErrorHandler.handle.bind(AuthErrorHandler);
export const handleSyncError = SyncErrorHandler.handle.bind(SyncErrorHandler);
export const handleFileError = FileErrorHandler.handle.bind(FileErrorHandler);
export const handleBrowserError = BrowserErrorHandler.handle.bind(BrowserErrorHandler);
