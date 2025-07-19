/**
 * 统一反馈工具类
 * 提供标准化的用户反馈接口
 */

import { toast, ToastOptions } from './toast';
import { mapError, createUserFriendlyError, getErrorAction } from './errorMapping';
import { startErrorRecovery, hasRecoverySteps } from './errorRecoveryManager';

export interface FeedbackOptions extends Omit<ToastOptions, 'type'> {
  showToast?: boolean;
  logToConsole?: boolean;
}

export interface ErrorFeedbackOptions extends FeedbackOptions {
  retryAction?: () => void;
  contactSupport?: boolean;
}

export interface SuccessFeedbackOptions extends FeedbackOptions {
  nextAction?: {
    label: string;
    onClick: () => void;
  };
}

/**
 * 统一反馈管理器
 */
class FeedbackManager {
  /**
   * 显示成功反馈
   */
  success(message: string, options: SuccessFeedbackOptions = {}) {
    const {
      showToast = true,
      logToConsole = true,
      nextAction,
      ...toastOptions
    } = options;

    if (logToConsole) {
      console.log('✅ Success:', message);
    }

    if (showToast) {
      toast.success(message, {
        ...toastOptions,
        action: nextAction,
      });
    }
  }

  /**
   * 显示错误反馈
   */
  error(message: string, options: ErrorFeedbackOptions = {}) {
    const {
      showToast = true,
      logToConsole = true,
      retryAction,
      contactSupport = false,
      ...toastOptions
    } = options;

    if (logToConsole) {
      console.error('❌ Error:', message);
    }

    if (showToast) {
      let action = undefined;

      if (retryAction) {
        action = {
          label: '重试',
          onClick: retryAction,
        };
      } else if (contactSupport) {
        action = {
          label: '联系支持',
          onClick: () => {
            // 这里可以打开支持页面或邮件客户端
            window.open('mailto:support@onetabplus.com?subject=错误报告&body=' + encodeURIComponent(message));
          },
        };
      }

      toast.error(message, {
        duration: 5000,
        ...toastOptions,
        action,
      });
    }
  }

  /**
   * 显示智能错误反馈（自动映射错误信息）
   */
  smartError(error: any, options: ErrorFeedbackOptions = {}) {
    const errorInfo = mapError(error);
    const userFriendlyMessage = createUserFriendlyError(error);
    const errorAction = getErrorAction(error);

    if (options.logToConsole !== false) {
      console.error('❌ Smart Error:', error);
    }

    // 检查是否有恢复步骤
    const hasRecovery = hasRecoverySteps(error);
    let finalAction = options.retryAction ? {
      label: '重试',
      onClick: options.retryAction,
    } : errorAction;

    // 如果有恢复步骤，优先显示恢复指南
    if (hasRecovery && !finalAction) {
      finalAction = {
        label: '解决方案',
        onClick: () => {
          const sessionId = startErrorRecovery(error);
          if (sessionId) {
            // 这里可以打开恢复指南界面
            console.log('Recovery session started:', sessionId);
            this.info('已为您准备了问题解决方案', {
              action: {
                label: '查看指南',
                onClick: () => {
                  // 打开恢复指南界面
                  console.log('Open recovery guide for session:', sessionId);
                },
              },
            });
          }
        },
      };
    }

    // 如果没有其他action且需要联系支持
    if (!finalAction && options.contactSupport) {
      finalAction = {
        label: '联系支持',
        onClick: () => {
          window.open('mailto:support@onetabplus.com?subject=错误报告&body=' + encodeURIComponent(userFriendlyMessage));
        },
      };
    }

    if (options.showToast !== false) {
      toast.error(userFriendlyMessage, {
        duration: hasRecovery ? 8000 : 5000, // 有恢复步骤时显示更长时间
        ...options,
        action: finalAction,
      });
    }
  }

  /**
   * 显示警告反馈
   */
  warning(message: string, options: FeedbackOptions = {}) {
    const {
      showToast = true,
      logToConsole = true,
      ...toastOptions
    } = options;

    if (logToConsole) {
      console.warn('⚠️ Warning:', message);
    }

    if (showToast) {
      toast.warning(message, {
        duration: 5000,
        ...toastOptions,
      });
    }
  }

  /**
   * 显示信息反馈
   */
  info(message: string, options: FeedbackOptions = {}) {
    const {
      showToast = true,
      logToConsole = true,
      ...toastOptions
    } = options;

    if (logToConsole) {
      console.info('ℹ️ Info:', message);
    }

    if (showToast) {
      toast.info(message, {
        ...toastOptions,
      });
    }
  }

  /**
   * 显示加载反馈
   */
  loading(message: string, options: FeedbackOptions & { id?: string } = {}) {
    const {
      showToast = true,
      logToConsole = true,
      id,
      ...toastOptions
    } = options;

    if (logToConsole) {
      console.log('⏳ Loading:', message);
    }

    if (showToast) {
      toast.loading(message, {
        ...toastOptions,
        id,
      });
    }

    return id;
  }

  /**
   * 关闭加载反馈
   */
  dismissLoading(id?: string) {
    toast.dismiss(id);
  }

  /**
   * 网络错误反馈
   */
  networkError(retryAction?: () => void) {
    this.error('网络连接不稳定，数据已保存到本地', {
      retryAction,
      duration: 5000,
    });
  }

  /**
   * 认证错误反馈
   */
  authError() {
    this.error('登录状态已过期，请重新登录', {
      duration: 0,
      action: {
        label: '重新登录',
        onClick: () => {
          // 触发重新认证流程
          window.location.hash = '#auth';
        },
      },
    });
  }

  /**
   * 权限错误反馈
   */
  permissionError() {
    this.error('您没有执行此操作的权限', {
      contactSupport: true,
    });
  }

  /**
   * 数据冲突反馈
   */
  conflictError(resolveAction?: () => void) {
    this.warning('检测到数据冲突，需要手动解决', {
      duration: 0,
      action: resolveAction ? {
        label: '查看冲突',
        onClick: resolveAction,
      } : undefined,
    });
  }

  /**
   * 操作成功反馈（带下一步操作）
   */
  operationSuccess(message: string, nextAction?: { label: string; onClick: () => void }) {
    this.success(message, {
      nextAction,
    });
  }

  /**
   * 批量操作反馈
   */
  batchOperation(total: number, success: number, failed: number) {
    if (failed === 0) {
      this.success(`成功处理 ${success} 项操作`);
    } else if (success === 0) {
      this.error(`${failed} 项操作失败`);
    } else {
      this.warning(`${success} 项操作成功，${failed} 项操作失败`);
    }
  }

  /**
   * 同步操作反馈
   */
  sync = {
    start: (id = 'sync-operation') => {
      return this.loading('正在同步数据...', { id });
    },
    
    success: (id = 'sync-operation') => {
      this.dismissLoading(id);
      this.success('数据同步完成');
    },
    
    error: (error: string, retryAction?: () => void, id = 'sync-operation') => {
      this.dismissLoading(id);
      this.error(`同步失败: ${error}`, { retryAction });
    },
    
    conflict: (resolveAction?: () => void, id = 'sync-operation') => {
      this.dismissLoading(id);
      this.conflictError(resolveAction);
    },
  };

  /**
   * 认证操作反馈
   */
  auth = {
    loginSuccess: () => {
      this.success('登录成功');
    },
    
    loginError: (error: string) => {
      this.error(`登录失败: ${error}`);
    },
    
    registerSuccess: () => {
      this.success('注册成功，正在自动登录...');
    },
    
    registerError: (error: string) => {
      this.error(`注册失败: ${error}`);
    },
    
    logoutSuccess: () => {
      this.info('已安全退出登录');
    },
  };

  /**
   * 文件操作反馈
   */
  file = {
    uploadSuccess: (filename: string) => {
      this.success(`文件 "${filename}" 上传成功`);
    },
    
    uploadError: (filename: string, error: string) => {
      this.error(`文件 "${filename}" 上传失败: ${error}`);
    },
    
    downloadSuccess: (filename: string) => {
      this.success(`文件 "${filename}" 下载完成`);
    },
    
    downloadError: (filename: string, error: string) => {
      this.error(`文件 "${filename}" 下载失败: ${error}`);
    },
  };
}

// 创建全局实例
export const feedback = new FeedbackManager();

// 默认导出
export default feedback;
