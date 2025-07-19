/**
 * 错误信息本地化映射
 * 将技术错误信息转换为用户友好的中文描述
 */

export interface RecoveryStep {
  id: string;
  title: string;
  description: string;
  action?: {
    label: string;
    handler: () => void | Promise<void>;
  };
}

export interface ErrorInfo {
  message: string;
  suggestion?: string;
  action?: {
    label: string;
    handler: () => void;
  };
  recoverySteps?: RecoveryStep[];
}

export type ErrorMappingFunction = (error: any) => ErrorInfo;

/**
 * 网络错误映射
 */
export const networkErrorMapping: Record<string, ErrorInfo> = {
  'Network Error': {
    message: '网络连接失败',
    suggestion: '请检查网络连接后重试',
    recoverySteps: [
      {
        id: 'check-connection',
        title: '检查网络连接',
        description: '确认您的设备已连接到互联网',
        action: {
          label: '测试连接',
          handler: async () => {
            try {
              await fetch('https://www.google.com/favicon.ico', { mode: 'no-cors' });
              return Promise.resolve();
            } catch {
              throw new Error('网络连接测试失败');
            }
          },
        },
      },
      {
        id: 'refresh-page',
        title: '刷新页面',
        description: '重新加载页面以重新建立连接',
        action: {
          label: '刷新',
          handler: () => window.location.reload(),
        },
      },
      {
        id: 'clear-cache',
        title: '清除缓存',
        description: '清除浏览器缓存可能解决连接问题',
        action: {
          label: '清除缓存',
          handler: () => {
            if ('caches' in window) {
              caches.keys().then(names => {
                names.forEach(name => caches.delete(name));
              });
            }
          },
        },
      },
    ],
  },
  'timeout': {
    message: '请求超时',
    suggestion: '网络较慢，请稍后重试',
    recoverySteps: [
      {
        id: 'wait-retry',
        title: '等待后重试',
        description: '等待几秒钟后重新尝试操作',
      },
      {
        id: 'check-speed',
        title: '检查网络速度',
        description: '确认网络连接速度是否正常',
        action: {
          label: '测速',
          handler: () => window.open('https://fast.com', '_blank'),
        },
      },
    ],
  },
  'ECONNREFUSED': {
    message: '无法连接到服务器',
    suggestion: '服务器可能暂时不可用，请稍后重试',
    recoverySteps: [
      {
        id: 'check-status',
        title: '检查服务状态',
        description: '查看服务器是否正在维护',
      },
      {
        id: 'try-later',
        title: '稍后重试',
        description: '等待5-10分钟后重新尝试',
      },
    ],
  },
  'ENOTFOUND': {
    message: '无法找到服务器',
    suggestion: '请检查网络连接或联系技术支持',
    recoverySteps: [
      {
        id: 'check-dns',
        title: '检查DNS设置',
        description: '确认DNS设置正确',
        action: {
          label: '使用公共DNS',
          handler: () => {
            alert('请在网络设置中将DNS改为8.8.8.8或1.1.1.1');
          },
        },
      },
    ],
  },
  'ETIMEDOUT': {
    message: '连接超时',
    suggestion: '网络连接不稳定，请重试',
    recoverySteps: [
      {
        id: 'check-firewall',
        title: '检查防火墙',
        description: '确认防火墙没有阻止连接',
      },
      {
        id: 'restart-router',
        title: '重启路由器',
        description: '重启网络设备可能解决连接问题',
      },
    ],
  },
};

/**
 * HTTP状态码错误映射
 */
export const httpStatusErrorMapping: Record<number, ErrorInfo> = {
  400: {
    message: '请求参数错误',
    suggestion: '请检查输入信息是否正确',
  },
  401: {
    message: '登录状态已过期',
    suggestion: '请重新登录',
  },
  403: {
    message: '权限不足',
    suggestion: '您没有执行此操作的权限',
  },
  404: {
    message: '请求的资源不存在',
    suggestion: '请刷新页面或联系技术支持',
  },
  409: {
    message: '数据冲突',
    suggestion: '检测到数据冲突，请手动解决',
  },
  429: {
    message: '请求过于频繁',
    suggestion: '请稍后再试',
  },
  500: {
    message: '服务器内部错误',
    suggestion: '服务器出现问题，请稍后重试',
  },
  502: {
    message: '服务器网关错误',
    suggestion: '服务器暂时不可用，请稍后重试',
  },
  503: {
    message: '服务暂时不可用',
    suggestion: '服务器正在维护，请稍后重试',
  },
  504: {
    message: '服务器响应超时',
    suggestion: '服务器响应较慢，请稍后重试',
  },
};

/**
 * 认证错误映射
 */
export const authErrorMapping: Record<string, ErrorInfo> = {
  'invalid-email': {
    message: '邮箱格式不正确',
    suggestion: '请输入有效的邮箱地址',
  },
  'user-disabled': {
    message: '账户已被禁用',
    suggestion: '请联系管理员解除账户限制',
  },
  'user-not-found': {
    message: '用户不存在',
    suggestion: '请检查邮箱地址或注册新账户',
  },
  'wrong-password': {
    message: '密码错误',
    suggestion: '请检查密码或使用忘记密码功能',
  },
  'email-already-in-use': {
    message: '邮箱已被注册',
    suggestion: '请使用其他邮箱或直接登录',
  },
  'weak-password': {
    message: '密码强度不足',
    suggestion: '密码至少需要8位字符，建议包含字母和数字',
  },
  'too-many-requests': {
    message: '登录尝试次数过多',
    suggestion: '请稍后再试或重置密码',
  },
  'operation-not-allowed': {
    message: '操作不被允许',
    suggestion: '此登录方式暂时不可用',
  },
  'requires-recent-login': {
    message: '需要重新验证身份',
    suggestion: '请重新登录后再试',
  },
};

/**
 * 同步错误映射
 */
export const syncErrorMapping: Record<string, ErrorInfo> = {
  'sync-conflict': {
    message: '数据同步冲突',
    suggestion: '本地和云端数据存在差异，需要手动解决',
    recoverySteps: [
      {
        id: 'view-conflicts',
        title: '查看冲突详情',
        description: '了解具体的数据冲突内容',
        action: {
          label: '查看冲突',
          handler: () => {
            // 打开冲突解决界面
            console.log('Open conflict resolution UI');
          },
        },
      },
      {
        id: 'backup-local',
        title: '备份本地数据',
        description: '在解决冲突前备份当前本地数据',
        action: {
          label: '导出备份',
          handler: async () => {
            // 导出本地数据
            console.log('Export local data');
          },
        },
      },
      {
        id: 'resolve-conflict',
        title: '解决冲突',
        description: '选择保留本地数据、云端数据或手动合并',
      },
    ],
  },
  'sync-failed': {
    message: '数据同步失败',
    suggestion: '请检查网络连接后重试',
    recoverySteps: [
      {
        id: 'check-auth',
        title: '检查登录状态',
        description: '确认您仍处于登录状态',
        action: {
          label: '重新登录',
          handler: () => {
            // 触发重新登录
            window.location.hash = '#auth';
          },
        },
      },
      {
        id: 'retry-sync',
        title: '重试同步',
        description: '重新尝试同步操作',
      },
    ],
  },
  'upload-failed': {
    message: '数据上传失败',
    suggestion: '请检查网络连接和存储空间',
    recoverySteps: [
      {
        id: 'check-size',
        title: '检查数据大小',
        description: '确认数据大小没有超出限制',
      },
      {
        id: 'compress-data',
        title: '压缩数据',
        description: '尝试压缩数据后重新上传',
        action: {
          label: '压缩上传',
          handler: async () => {
            // 压缩数据逻辑
            console.log('Compress and upload data');
          },
        },
      },
    ],
  },
  'download-failed': {
    message: '数据下载失败',
    suggestion: '请检查网络连接后重试',
    recoverySteps: [
      {
        id: 'clear-cache',
        title: '清除缓存',
        description: '清除本地缓存后重新下载',
        action: {
          label: '清除缓存',
          handler: () => {
            localStorage.clear();
            sessionStorage.clear();
          },
        },
      },
      {
        id: 'partial-download',
        title: '分批下载',
        description: '尝试分批下载数据',
      },
    ],
  },
  'quota-exceeded': {
    message: '存储空间不足',
    suggestion: '请清理部分数据或升级存储空间',
    recoverySteps: [
      {
        id: 'check-usage',
        title: '查看存储使用情况',
        description: '了解当前存储空间使用详情',
        action: {
          label: '查看详情',
          handler: () => {
            // 打开存储管理界面
            console.log('Open storage management');
          },
        },
      },
      {
        id: 'clean-data',
        title: '清理旧数据',
        description: '删除不需要的旧标签组和数据',
        action: {
          label: '开始清理',
          handler: () => {
            // 打开数据清理界面
            console.log('Open data cleanup');
          },
        },
      },
      {
        id: 'upgrade-storage',
        title: '升级存储空间',
        description: '购买更多存储空间',
        action: {
          label: '升级',
          handler: () => {
            // 打开升级页面
            window.open('/upgrade', '_blank');
          },
        },
      },
    ],
  },
  'invalid-data': {
    message: '数据格式错误',
    suggestion: '数据可能已损坏，请尝试重新同步',
    recoverySteps: [
      {
        id: 'validate-data',
        title: '验证数据完整性',
        description: '检查本地数据是否完整',
      },
      {
        id: 'restore-backup',
        title: '恢复备份',
        description: '从最近的备份恢复数据',
        action: {
          label: '恢复备份',
          handler: () => {
            // 打开备份恢复界面
            console.log('Open backup restore');
          },
        },
      },
      {
        id: 'reset-sync',
        title: '重置同步',
        description: '清除本地数据并重新从云端下载',
      },
    ],
  },
  'version-mismatch': {
    message: '版本不匹配',
    suggestion: '请更新到最新版本后重试',
    recoverySteps: [
      {
        id: 'check-version',
        title: '检查当前版本',
        description: '确认当前应用版本',
      },
      {
        id: 'update-app',
        title: '更新应用',
        description: '下载并安装最新版本',
        action: {
          label: '检查更新',
          handler: () => {
            window.location.reload();
          },
        },
      },
    ],
  },
};

/**
 * 文件操作错误映射
 */
export const fileErrorMapping: Record<string, ErrorInfo> = {
  'file-not-found': {
    message: '文件不存在',
    suggestion: '文件可能已被删除或移动',
  },
  'file-too-large': {
    message: '文件过大',
    suggestion: '请选择小于10MB的文件',
  },
  'invalid-file-type': {
    message: '文件格式不支持',
    suggestion: '请选择支持的文件格式',
  },
  'file-corrupted': {
    message: '文件已损坏',
    suggestion: '请选择其他文件或重新下载',
  },
  'permission-denied': {
    message: '文件访问权限不足',
    suggestion: '请检查文件权限设置',
  },
  'disk-full': {
    message: '存储空间不足',
    suggestion: '请清理磁盘空间后重试',
  },
};

/**
 * 浏览器API错误映射
 */
export const browserErrorMapping: Record<string, ErrorInfo> = {
  'storage-quota-exceeded': {
    message: '本地存储空间不足',
    suggestion: '请清理浏览器数据或扩展存储空间',
  },
  'permission-denied': {
    message: '浏览器权限被拒绝',
    suggestion: '请在浏览器设置中允许相关权限',
  },
  'not-supported': {
    message: '浏览器不支持此功能',
    suggestion: '请更新浏览器到最新版本',
  },
  'security-error': {
    message: '安全限制',
    suggestion: '浏览器安全策略阻止了此操作',
  },
};

/**
 * 通用错误映射函数
 */
export function mapError(error: any): ErrorInfo {
  // 如果已经是ErrorInfo格式，直接返回
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    if ('suggestion' in error || 'action' in error) {
      return error as ErrorInfo;
    }
  }

  const errorMessage = error?.message || error?.toString() || '未知错误';
  const errorCode = error?.code;
  const statusCode = error?.status || error?.statusCode;

  // 优先匹配错误代码
  if (errorCode) {
    // 认证错误
    if (authErrorMapping[errorCode]) {
      return authErrorMapping[errorCode];
    }
    
    // 同步错误
    if (syncErrorMapping[errorCode]) {
      return syncErrorMapping[errorCode];
    }
    
    // 文件错误
    if (fileErrorMapping[errorCode]) {
      return fileErrorMapping[errorCode];
    }
    
    // 浏览器错误
    if (browserErrorMapping[errorCode]) {
      return browserErrorMapping[errorCode];
    }
  }

  // HTTP状态码匹配
  if (statusCode && httpStatusErrorMapping[statusCode]) {
    return httpStatusErrorMapping[statusCode];
  }

  // 网络错误匹配
  for (const [key, errorInfo] of Object.entries(networkErrorMapping)) {
    if (errorMessage.toLowerCase().includes(key.toLowerCase())) {
      return errorInfo;
    }
  }

  // 特殊错误模式匹配
  const lowerMessage = errorMessage.toLowerCase();
  
  if (lowerMessage.includes('network') || lowerMessage.includes('fetch')) {
    return {
      message: '网络连接失败',
      suggestion: '请检查网络连接后重试',
    };
  }
  
  if (lowerMessage.includes('timeout')) {
    return {
      message: '操作超时',
      suggestion: '请稍后重试',
    };
  }
  
  if (lowerMessage.includes('permission') || lowerMessage.includes('unauthorized')) {
    return {
      message: '权限不足',
      suggestion: '您没有执行此操作的权限',
    };
  }
  
  if (lowerMessage.includes('quota') || lowerMessage.includes('storage')) {
    return {
      message: '存储空间不足',
      suggestion: '请清理数据后重试',
    };
  }

  // 默认错误信息
  return {
    message: '操作失败',
    suggestion: '请重试或联系技术支持',
  };
}

/**
 * 创建用户友好的错误消息
 */
export function createUserFriendlyError(error: any): string {
  const errorInfo = mapError(error);
  
  if (errorInfo.suggestion) {
    return `${errorInfo.message}，${errorInfo.suggestion}`;
  }
  
  return errorInfo.message;
}

/**
 * 获取错误的建议操作
 */
export function getErrorSuggestion(error: any): string | undefined {
  const errorInfo = mapError(error);
  return errorInfo.suggestion;
}

/**
 * 获取错误的操作按钮
 */
export function getErrorAction(error: any): { label: string; handler: () => void } | undefined {
  const errorInfo = mapError(error);
  return errorInfo.action;
}
