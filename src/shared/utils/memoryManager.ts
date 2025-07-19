import { logger } from './logger';

/**
 * 内存使用统计接口
 */
export interface MemoryStats {
  usedJSHeapSize: number; // 已使用的JS堆大小 (bytes)
  totalJSHeapSize: number; // 总JS堆大小 (bytes)
  jsHeapSizeLimit: number; // JS堆大小限制 (bytes)
  usagePercentage: number; // 使用百分比
  timestamp: number; // 时间戳
}

/**
 * 内存监控配置接口
 */
export interface MemoryMonitorConfig {
  enabled: boolean;
  warningThreshold: number; // 警告阈值 (%)
  criticalThreshold: number; // 严重阈值 (%)
  monitorInterval: number; // 监控间隔 (ms)
  maxHistorySize: number; // 最大历史记录数量
}

/**
 * 缓存项接口
 */
export interface CacheItem<T> {
  value: T;
  timestamp: number;
  accessCount: number;
  lastAccessed: number;
  size?: number; // 估算大小 (bytes)
}

/**
 * 缓存配置接口
 */
export interface CacheConfig {
  maxSize: number; // 最大缓存项数量
  maxMemory: number; // 最大内存使用 (bytes)
  ttl: number; // 生存时间 (ms)
  cleanupInterval: number; // 清理间隔 (ms)
}

/**
 * 内存管理器类
 * 提供内存监控、缓存管理和内存优化功能
 */
export class MemoryManager {
  private static instance: MemoryManager;
  
  private memoryHistory: MemoryStats[] = [];
  private monitorTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private caches = new Map<string, Map<string, CacheItem<any>>>();
  private cacheConfigs = new Map<string, CacheConfig>();
  
  private config: MemoryMonitorConfig = {
    enabled: true,
    warningThreshold: 70,
    criticalThreshold: 90,
    monitorInterval: 5000,
    maxHistorySize: 100
  };

  private constructor() {
    this.startMonitoring();
  }

  /**
   * 获取单例实例
   */
  public static getInstance(): MemoryManager {
    if (!MemoryManager.instance) {
      MemoryManager.instance = new MemoryManager();
    }
    return MemoryManager.instance;
  }

  /**
   * 配置内存监控
   */
  public configure(config: Partial<MemoryMonitorConfig>): void {
    this.config = { ...this.config, ...config };
    
    if (this.config.enabled) {
      this.startMonitoring();
    } else {
      this.stopMonitoring();
    }
  }

  /**
   * 获取当前内存使用情况
   */
  public getCurrentMemoryStats(): MemoryStats | null {
    if (!('memory' in performance)) {
      return null;
    }

    const memory = (performance as any).memory;
    const usagePercentage = (memory.usedJSHeapSize / memory.jsHeapSizeLimit) * 100;

    return {
      usedJSHeapSize: memory.usedJSHeapSize,
      totalJSHeapSize: memory.totalJSHeapSize,
      jsHeapSizeLimit: memory.jsHeapSizeLimit,
      usagePercentage,
      timestamp: Date.now()
    };
  }

  /**
   * 获取内存使用历史
   */
  public getMemoryHistory(): MemoryStats[] {
    return [...this.memoryHistory];
  }

  /**
   * 开始内存监控
   */
  private startMonitoring(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
    }

    this.monitorTimer = setInterval(() => {
      const stats = this.getCurrentMemoryStats();
      if (stats) {
        this.recordMemoryStats(stats);
        this.checkMemoryThresholds(stats);
      }
    }, this.config.monitorInterval);
  }

  /**
   * 停止内存监控
   */
  private stopMonitoring(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = undefined;
    }
  }

  /**
   * 记录内存统计
   */
  private recordMemoryStats(stats: MemoryStats): void {
    this.memoryHistory.push(stats);
    
    // 限制历史记录数量
    if (this.memoryHistory.length > this.config.maxHistorySize) {
      this.memoryHistory.shift();
    }
  }

  /**
   * 检查内存阈值
   */
  private checkMemoryThresholds(stats: MemoryStats): void {
    if (stats.usagePercentage >= this.config.criticalThreshold) {
      logger.error('内存使用达到严重阈值', {
        usage: `${stats.usagePercentage.toFixed(1)}%`,
        used: this.formatBytes(stats.usedJSHeapSize),
        limit: this.formatBytes(stats.jsHeapSizeLimit)
      });
      
      // 触发紧急清理
      this.performEmergencyCleanup();
      
    } else if (stats.usagePercentage >= this.config.warningThreshold) {
      logger.warn('内存使用达到警告阈值', {
        usage: `${stats.usagePercentage.toFixed(1)}%`,
        used: this.formatBytes(stats.usedJSHeapSize),
        limit: this.formatBytes(stats.jsHeapSizeLimit)
      });
      
      // 触发常规清理
      this.performCleanup();
    }
  }

  /**
   * 创建缓存
   */
  public createCache<T>(name: string, config: Partial<CacheConfig> = {}): void {
    const defaultConfig: CacheConfig = {
      maxSize: 1000,
      maxMemory: 50 * 1024 * 1024, // 50MB
      ttl: 30 * 60 * 1000, // 30分钟
      cleanupInterval: 5 * 60 * 1000 // 5分钟
    };

    const finalConfig = { ...defaultConfig, ...config };
    
    this.caches.set(name, new Map());
    this.cacheConfigs.set(name, finalConfig);
    
    // 启动定期清理
    this.startCacheCleanup(name);
  }

  /**
   * 设置缓存项
   */
  public setCacheItem<T>(cacheName: string, key: string, value: T, size?: number): void {
    const cache = this.caches.get(cacheName);
    const config = this.cacheConfigs.get(cacheName);
    
    if (!cache || !config) {
      throw new Error(`缓存 "${cacheName}" 不存在`);
    }

    const item: CacheItem<T> = {
      value,
      timestamp: Date.now(),
      accessCount: 0,
      lastAccessed: Date.now(),
      size: size || this.estimateSize(value)
    };

    cache.set(key, item);
    
    // 检查缓存大小限制
    this.enforceCacheLimits(cacheName);
  }

  /**
   * 获取缓存项
   */
  public getCacheItem<T>(cacheName: string, key: string): T | null {
    const cache = this.caches.get(cacheName);
    const config = this.cacheConfigs.get(cacheName);
    
    if (!cache || !config) {
      return null;
    }

    const item = cache.get(key) as CacheItem<T> | undefined;
    
    if (!item) {
      return null;
    }

    // 检查TTL
    if (Date.now() - item.timestamp > config.ttl) {
      cache.delete(key);
      return null;
    }

    // 更新访问统计
    item.accessCount++;
    item.lastAccessed = Date.now();

    return item.value;
  }

  /**
   * 删除缓存项
   */
  public deleteCacheItem(cacheName: string, key: string): boolean {
    const cache = this.caches.get(cacheName);
    return cache ? cache.delete(key) : false;
  }

  /**
   * 清空缓存
   */
  public clearCache(cacheName: string): void {
    const cache = this.caches.get(cacheName);
    if (cache) {
      cache.clear();
    }
  }

  /**
   * 获取缓存统计
   */
  public getCacheStats(cacheName: string): {
    size: number;
    memoryUsage: number;
    hitRate: number;
    items: Array<{ key: string; accessCount: number; lastAccessed: number; size: number }>;
  } | null {
    const cache = this.caches.get(cacheName);
    
    if (!cache) {
      return null;
    }

    let totalMemory = 0;
    let totalAccess = 0;
    const items: Array<{ key: string; accessCount: number; lastAccessed: number; size: number }> = [];

    cache.forEach((item, key) => {
      totalMemory += item.size || 0;
      totalAccess += item.accessCount;
      items.push({
        key,
        accessCount: item.accessCount,
        lastAccessed: item.lastAccessed,
        size: item.size || 0
      });
    });

    return {
      size: cache.size,
      memoryUsage: totalMemory,
      hitRate: totalAccess > 0 ? (totalAccess / (totalAccess + cache.size)) * 100 : 0,
      items: items.sort((a, b) => b.accessCount - a.accessCount)
    };
  }

  /**
   * 强制执行缓存限制
   */
  private enforceCacheLimits(cacheName: string): void {
    const cache = this.caches.get(cacheName);
    const config = this.cacheConfigs.get(cacheName);
    
    if (!cache || !config) {
      return;
    }

    // 检查数量限制
    if (cache.size > config.maxSize) {
      this.evictLeastRecentlyUsed(cacheName, cache.size - config.maxSize);
    }

    // 检查内存限制
    let totalMemory = 0;
    cache.forEach(item => {
      totalMemory += item.size || 0;
    });

    if (totalMemory > config.maxMemory) {
      this.evictByMemoryPressure(cacheName, totalMemory - config.maxMemory);
    }
  }

  /**
   * 驱逐最近最少使用的项目
   */
  private evictLeastRecentlyUsed(cacheName: string, count: number): void {
    const cache = this.caches.get(cacheName);
    
    if (!cache) {
      return;
    }

    const items = Array.from(cache.entries())
      .sort(([, a], [, b]) => a.lastAccessed - b.lastAccessed);

    for (let i = 0; i < Math.min(count, items.length); i++) {
      cache.delete(items[i][0]);
    }
  }

  /**
   * 根据内存压力驱逐项目
   */
  private evictByMemoryPressure(cacheName: string, targetReduction: number): void {
    const cache = this.caches.get(cacheName);
    
    if (!cache) {
      return;
    }

    const items = Array.from(cache.entries())
      .sort(([, a], [, b]) => {
        // 优先驱逐大尺寸、低访问频率的项目
        const scoreA = (a.size || 0) / (a.accessCount + 1);
        const scoreB = (b.size || 0) / (b.accessCount + 1);
        return scoreB - scoreA;
      });

    let reducedMemory = 0;
    for (const [key, item] of items) {
      if (reducedMemory >= targetReduction) {
        break;
      }
      
      cache.delete(key);
      reducedMemory += item.size || 0;
    }
  }

  /**
   * 启动缓存清理
   */
  private startCacheCleanup(cacheName: string): void {
    const config = this.cacheConfigs.get(cacheName);
    
    if (!config) {
      return;
    }

    setInterval(() => {
      this.cleanupExpiredItems(cacheName);
    }, config.cleanupInterval);
  }

  /**
   * 清理过期项目
   */
  private cleanupExpiredItems(cacheName: string): void {
    const cache = this.caches.get(cacheName);
    const config = this.cacheConfigs.get(cacheName);
    
    if (!cache || !config) {
      return;
    }

    const now = Date.now();
    const expiredKeys: string[] = [];

    cache.forEach((item, key) => {
      if (now - item.timestamp > config.ttl) {
        expiredKeys.push(key);
      }
    });

    expiredKeys.forEach(key => cache.delete(key));
    
    if (expiredKeys.length > 0) {
      logger.debug(`清理缓存 "${cacheName}" 中的 ${expiredKeys.length} 个过期项目`);
    }
  }

  /**
   * 执行常规清理
   */
  private performCleanup(): void {
    // 清理所有缓存的过期项目
    this.caches.forEach((_, cacheName) => {
      this.cleanupExpiredItems(cacheName);
    });

    // 触发垃圾回收（如果可用）
    if ('gc' in window && typeof (window as any).gc === 'function') {
      (window as any).gc();
    }
  }

  /**
   * 执行紧急清理
   */
  private performEmergencyCleanup(): void {
    logger.warn('执行紧急内存清理');
    
    // 清空所有缓存
    this.caches.forEach((cache) => {
      cache.clear();
    });

    // 强制垃圾回收
    if ('gc' in window && typeof (window as any).gc === 'function') {
      (window as any).gc();
    }
  }

  /**
   * 估算对象大小
   */
  private estimateSize(obj: any): number {
    if (obj === null || obj === undefined) {
      return 0;
    }

    if (typeof obj === 'string') {
      return obj.length * 2; // Unicode字符大约2字节
    }

    if (typeof obj === 'number') {
      return 8; // 64位数字
    }

    if (typeof obj === 'boolean') {
      return 4;
    }

    if (Array.isArray(obj)) {
      return obj.reduce((sum, item) => sum + this.estimateSize(item), 0);
    }

    if (typeof obj === 'object') {
      return Object.keys(obj).reduce((sum, key) => {
        return sum + this.estimateSize(key) + this.estimateSize(obj[key]);
      }, 0);
    }

    return 0;
  }

  /**
   * 格式化字节数
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * 销毁内存管理器
   */
  public destroy(): void {
    this.stopMonitoring();
    
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    
    this.caches.clear();
    this.cacheConfigs.clear();
    this.memoryHistory = [];
  }
}

// 导出单例实例
export const memoryManager = MemoryManager.getInstance();
