/**
 * 性能优化工具
 * 包括缓存、防抖、节流等功能
 */

/**
 * 防抖函数
 * @param func 要防抖的函数
 * @param delay 延迟时间（毫秒）
 * @returns 防抖后的函数
 */
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  delay: number
): (...args: Parameters<T>) => void {
  // 在浏览器 / Service Worker / Node 环境下都兼容的定时器类型
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return function (this: any, ...args: Parameters<T>): void {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    timeoutId = setTimeout(() => {
      func.apply(this, args);
    }, delay);
  };
}

/**
 * 节流函数
 * @param func 要节流的函数
 * @param limit 限制时间（毫秒）
 * @returns 节流后的函数
 */
export function throttle<T extends (...args: any[]) => any>(
  func: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle: boolean;

  return function (this: any, ...args: Parameters<T>): void {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

/**
 * 可等待的防抖异步函数包装器（只执行最后一次调用）
 *
 * - 多次调用会合并为一次执行（使用最后一次参数）
 * - 每次调用都会返回一个 Promise，只有当最终执行完成后才 resolve/reject
 * - 适合用在“频繁写入但需要 await 落盘”的场景（例如存储层 setGroups/setSettings）
 */
export function debounceAsync<TArgs extends any[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  delay: number
): (...args: TArgs) => Promise<TResult> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: TArgs | null = null;

  // 所有在窗口期内的调用共享同一次最终执行的结果
  let pending:
    | {
        promise: Promise<TResult>;
        resolve: (value: TResult) => void;
        reject: (reason?: any) => void;
      }
    | null = null;

  const schedule = () => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(async () => {
      timeoutId = null;
      
      // 安全检查：确保有参数可用
      if (!lastArgs) {
        console.error('debounceAsync: No arguments available for execution');
        return;
      }
      
      const args = lastArgs;
      lastArgs = null;

      const currentPending = pending;
      pending = null;

      try {
        const result = await fn(...args);
        currentPending?.resolve(result);
      } catch (err) {
        currentPending?.reject(err);
      }
    }, delay);
  };

  return (...args: TArgs) => {
    lastArgs = args;

    if (!pending) {
      let resolve!: (value: TResult) => void;
      let reject!: (reason?: any) => void;
      const promise = new Promise<TResult>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      pending = { promise, resolve, reject };
    }

    schedule();
    return pending.promise;
  };
}

/**
 * 简单的内存缓存类（带 LRU 淘汰策略）
 */
export class SimpleCache<T = any> {
  private cache: Map<string, { value: T; timestamp: number; ttl: number }> = new Map();
  private maxSize: number;

  constructor(maxSize: number = 100) {
    this.maxSize = maxSize;
  }

  /**
   * 设置缓存
   * @param key 缓存键
   * @param value 缓存值
   * @param ttl 生存时间（毫秒），0表示永不过期
   */
  set(key: string, value: T, ttl: number = 0): void {
    // 如果键已存在，先删除（为了更新 Map 的插入顺序）
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    
    // 如果缓存已满，删除最旧的条目（Map 的第一个键）
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    
    this.cache.set(key, {
      value,
      timestamp: Date.now(),
      ttl
    });
  }

  /**
   * 获取缓存
   * @param key 缓存键
   * @returns 缓存值，如果不存在或已过期则返回undefined
   */
  get(key: string): T | undefined {
    const item = this.cache.get(key);
    
    if (!item) {
      return undefined;
    }

    // 检查是否过期
    if (item.ttl > 0 && Date.now() - item.timestamp > item.ttl) {
      this.cache.delete(key);
      return undefined;
    }

    return item.value;
  }

  /**
   * 删除缓存
   * @param key 缓存键
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * 获取缓存大小
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * 获取最大缓存大小
   */
  get maxCacheSize(): number {
    return this.maxSize;
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * 清理过期的缓存项
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, item] of this.cache.entries()) {
      if (item.ttl > 0 && now - item.timestamp > item.ttl) {
        this.cache.delete(key);
      }
    }
  }
}

/**
 * 带有自动清理功能的缓存管理器
 */
export class CacheManager {
  private caches: Map<string, SimpleCache> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startCleanupInterval();
  }

  /**
   * 获取或创建缓存实例
   */
  getCache(name: string): SimpleCache {
    if (!this.caches.has(name)) {
      const cache = new SimpleCache();
      this.caches.set(name, cache);
    }
    return this.caches.get(name)!;
  }

  /**
   * 开始定期清理任务
   */
  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60 * 1000); // 每分钟清理一次
  }

  /**
   * 清理所有缓存中的过期项
   */
  private cleanup(): void {
    for (const cache of this.caches.values()) {
      cache.cleanup();
    }
  }

  /**
   * 销毁缓存管理器
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.caches.clear();
  }
}

// 创建全局缓存管理器实例
export const cacheManager = new CacheManager();

/**
 * 带缓存的异步函数包装器
 * @param key 缓存键
 * @param fn 异步函数
 * @param ttl 缓存生存时间（毫秒）
 * @returns 缓存的结果
 */
export async function cachedAsyncFn<T>(
  cacheName: string,
  key: string,
  fn: () => Promise<T>,
  ttl: number = 5 * 60 * 1000 // 默认5分钟
): Promise<T> {
  const cache = cacheManager.getCache(cacheName);
  const cachedValue = cache.get(key);

  if (cachedValue !== undefined) {
    return cachedValue as T;
  }

  const result = await fn();
  cache.set(key, result, ttl);
  return result;
}