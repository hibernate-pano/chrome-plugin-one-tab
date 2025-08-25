/**
 * 环境检测工具
 * 用于检测当前运行环境，避免在不兼容的环境中使用特定API
 */

/**
 * 检查是否在Service Worker环境中
 */
export const isServiceWorker = (): boolean => {
  return typeof importScripts === 'function' && typeof navigator !== 'undefined' && navigator.serviceWorker !== undefined;
};

/**
 * 检查是否在浏览器主线程中
 */
export const isMainThread = (): boolean => {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
};

/**
 * 检查是否在Chrome扩展环境中
 */
export const isChromeExtension = (): boolean => {
  return typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
};

/**
 * 检查是否支持localStorage
 */
export const supportsLocalStorage = (): boolean => {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch (error) {
    return false;
  }
};

/**
 * 检查是否支持Chrome Storage API
 */
export const supportsChromeStorage = (): boolean => {
  return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
};

/**
 * 获取安全的存储API
 * 优先使用Chrome Storage API，降级到localStorage
 */
export const getSafeStorage = () => {
  if (supportsChromeStorage()) {
    return {
      async get(key: string): Promise<any> {
        const result = await chrome.storage.local.get(key);
        return result[key];
      },
      
      async set(key: string, value: any): Promise<void> {
        await chrome.storage.local.set({ [key]: value });
      },
      
      async remove(key: string): Promise<void> {
        await chrome.storage.local.remove(key);
      }
    };
  } else if (supportsLocalStorage()) {
    return {
      async get(key: string): Promise<any> {
        const value = localStorage.getItem(key);
        return value ? JSON.parse(value) : undefined;
      },
      
      async set(key: string, value: any): Promise<void> {
        localStorage.setItem(key, JSON.stringify(value));
      },
      
      async remove(key: string): Promise<void> {
        localStorage.removeItem(key);
      }
    };
  } else {
    // 内存存储作为最后的降级方案
    const memoryStorage = new Map<string, any>();
    return {
      async get(key: string): Promise<any> {
        return memoryStorage.get(key);
      },
      
      async set(key: string, value: any): Promise<void> {
        memoryStorage.set(key, value);
      },
      
      async remove(key: string): Promise<void> {
        memoryStorage.delete(key);
      }
    };
  }
};

/**
 * 安全地执行可能在某些环境中不可用的代码
 */
export const safeExecute = async <T>(
  fn: () => Promise<T>,
  fallback: () => Promise<T>,
  errorMessage: string = '操作失败'
): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    console.warn(`${errorMessage}:`, error);
    return await fallback();
  }
};

/**
 * 环境信息
 */
export const getEnvironmentInfo = () => {
  return {
    isServiceWorker: isServiceWorker(),
    isMainThread: isMainThread(),
    isChromeExtension: isChromeExtension(),
    supportsLocalStorage: supportsLocalStorage(),
    supportsChromeStorage: supportsChromeStorage(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'Unknown'
  };
};
