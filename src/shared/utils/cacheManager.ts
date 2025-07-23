/**
 * 缓存管理器
 * 用于清理各种缓存，确保数据一致性
 */

import { logger } from './logger';

export interface CacheManager {
  clearAll(): Promise<void>;
  clearComponentCache(): Promise<void>;
  clearStorageCache(): Promise<void>;
  clearReduxCache(): Promise<void>;
  forceRefresh(): Promise<void>;
}

class CacheManagerImpl implements CacheManager {
  private componentCaches = new Set<() => void>();
  private storageCaches = new Set<string>();

  /**
   * 注册组件缓存清理函数
   */
  registerComponentCache(clearFn: () => void): () => void {
    this.componentCaches.add(clearFn);
    
    // 返回取消注册函数
    return () => {
      this.componentCaches.delete(clearFn);
    };
  }

  /**
   * 注册存储缓存键
   */
  registerStorageCache(key: string): void {
    this.storageCaches.add(key);
  }

  /**
   * 清理所有缓存
   */
  async clearAll(): Promise<void> {
    logger.debug('开始清理所有缓存');
    
    await Promise.all([
      this.clearComponentCache(),
      this.clearStorageCache(),
      this.clearReduxCache()
    ]);
    
    logger.debug('所有缓存清理完成');
  }

  /**
   * 清理组件级缓存
   */
  async clearComponentCache(): Promise<void> {
    logger.debug(`清理 ${this.componentCaches.size} 个组件缓存`);
    
    this.componentCaches.forEach(clearFn => {
      try {
        clearFn();
      } catch (error) {
        logger.warn('清理组件缓存失败', error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * 清理存储缓存
   */
  async clearStorageCache(): Promise<void> {
    logger.debug(`清理 ${this.storageCaches.size} 个存储缓存`);
    
    // 清理 localStorage 缓存
    if (typeof window !== 'undefined' && window.localStorage) {
      this.storageCaches.forEach(key => {
        try {
          localStorage.removeItem(key);
        } catch (error) {
          logger.warn(`清理 localStorage 缓存失败: ${key}`, error instanceof Error ? error : new Error(String(error)));
        }
      });
    }

    // 清理 Chrome Storage 缓存（如果需要）
    if (typeof chrome !== 'undefined' && chrome.storage) {
      try {
        const keysToRemove = Array.from(this.storageCaches);
        if (keysToRemove.length > 0) {
          await chrome.storage.local.remove(keysToRemove);
        }
      } catch (error) {
        logger.warn('清理 Chrome Storage 缓存失败', error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  /**
   * 清理 Redux 缓存
   */
  async clearReduxCache(): Promise<void> {
    // Redux 状态通常不需要手动清理，因为它是响应式的
    // 但我们可以触发一些清理操作
    logger.debug('Redux 缓存清理（通常由状态更新自动处理）');
  }

  /**
   * 强制刷新页面数据
   */
  async forceRefresh(): Promise<void> {
    logger.debug('强制刷新页面数据');
    
    // 清理所有缓存
    await this.clearAll();
    
    // 触发页面重新渲染（如果在浏览器环境中）
    if (typeof window !== 'undefined') {
      // 触发自定义事件，通知组件刷新
      window.dispatchEvent(new CustomEvent('cache-cleared', {
        detail: { timestamp: Date.now() }
      }));
    }
  }

  /**
   * 清理特定类型的缓存
   */
  async clearCacheByType(type: 'component' | 'storage' | 'redux'): Promise<void> {
    switch (type) {
      case 'component':
        await this.clearComponentCache();
        break;
      case 'storage':
        await this.clearStorageCache();
        break;
      case 'redux':
        await this.clearReduxCache();
        break;
      default:
        logger.warn(`未知的缓存类型: ${type}`);
    }
  }

  /**
   * 获取缓存统计信息
   */
  getCacheStats() {
    return {
      componentCaches: this.componentCaches.size,
      storageCaches: this.storageCaches.size,
      timestamp: Date.now()
    };
  }

  /**
   * 重置缓存管理器
   */
  reset(): void {
    this.componentCaches.clear();
    this.storageCaches.clear();
    logger.debug('缓存管理器已重置');
  }
}

// 全局缓存管理器实例
export const cacheManager = new CacheManagerImpl();

// 便捷函数
export const clearAllCaches = () => cacheManager.clearAll();
export const clearComponentCaches = () => cacheManager.clearComponentCache();
export const clearStorageCaches = () => cacheManager.clearStorageCache();
export const forceRefresh = () => cacheManager.forceRefresh();

// 在开发环境下暴露到全局对象
if (process.env.NODE_ENV === 'development') {
  (window as any).cacheManager = cacheManager;
  (window as any).clearAllCaches = clearAllCaches;
}

// 注册常见的存储缓存键
cacheManager.registerStorageCache('onetab_groups');
cacheManager.registerStorageCache('onetab_settings');
cacheManager.registerStorageCache('onetab_auth_cache');
cacheManager.registerStorageCache('onetab_theme');

// React Hook 用于组件中使用缓存管理
export const useCacheManager = () => {
  const registerCache = (clearFn: () => void) => {
    return cacheManager.registerComponentCache(clearFn);
  };

  return {
    registerCache,
    clearAll: cacheManager.clearAll.bind(cacheManager),
    clearComponent: cacheManager.clearComponentCache.bind(cacheManager),
    clearStorage: cacheManager.clearStorageCache.bind(cacheManager),
    forceRefresh: cacheManager.forceRefresh.bind(cacheManager),
    stats: cacheManager.getCacheStats()
  };
};

export default cacheManager;
