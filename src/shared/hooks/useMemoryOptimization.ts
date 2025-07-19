/**
 * 内存优化相关的React Hooks
 */

import { useRef, useCallback, useMemo, useEffect, useState } from 'react';
import { logger } from '@/shared/utils/logger';

/**
 * 防抖Hook，减少频繁的函数调用
 */
export function useDebounce<T extends (...args: any[]) => any>(
  callback: T,
  delay: number,
  deps: React.DependencyList = []
): T {
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const callbackRef = useRef(callback);

  // 更新回调引用
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  const debouncedCallback = useCallback(
    (...args: Parameters<T>) => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      timeoutRef.current = setTimeout(() => {
        callbackRef.current(...args);
      }, delay);
    },
    [delay, ...deps]
  ) as T;

  // 清理定时器
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return debouncedCallback;
}

/**
 * 节流Hook，限制函数调用频率
 */
export function useThrottle<T extends (...args: any[]) => any>(
  callback: T,
  delay: number,
  deps: React.DependencyList = []
): T {
  const lastCallRef = useRef<number>(0);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  const throttledCallback = useCallback(
    (...args: Parameters<T>) => {
      const now = Date.now();
      const timeSinceLastCall = now - lastCallRef.current;

      if (timeSinceLastCall >= delay) {
        lastCallRef.current = now;
        callbackRef.current(...args);
      } else {
        // 如果还在节流期内，设置定时器在节流期结束后执行
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }

        timeoutRef.current = setTimeout(() => {
          lastCallRef.current = Date.now();
          callbackRef.current(...args);
        }, delay - timeSinceLastCall);
      }
    },
    [delay, ...deps]
  ) as T;

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return throttledCallback;
}

/**
 * 深度比较的useMemo，避免对象引用变化导致的重复计算
 */
export function useDeepMemo<T>(
  factory: () => T,
  deps: React.DependencyList
): T {
  const ref = useRef<{ deps: React.DependencyList; value: T }>();

  const hasChanged = !ref.current || !deepEqual(ref.current.deps, deps);

  if (hasChanged) {
    ref.current = {
      deps: [...deps],
      value: factory(),
    };
  }

  return ref.current.value;
}

/**
 * 简单的深度比较函数
 */
function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;

  if (typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false;

    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!deepEqual(a[i], b[i])) return false;
      }
      return true;
    }

    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;

    for (const key of keysA) {
      if (!keysB.includes(key) || !deepEqual(a[key], b[key])) {
        return false;
      }
    }
    return true;
  }

  return false;
}

/**
 * 内存使用监控Hook
 */
export function useMemoryMonitor(componentName: string) {
  const [memoryInfo, setMemoryInfo] = useState<{
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
  } | null>(null);

  const updateMemoryInfo = useCallback(() => {
    if ('memory' in performance) {
      const memory = (performance as any).memory;
      setMemoryInfo({
        usedJSHeapSize: memory.usedJSHeapSize,
        totalJSHeapSize: memory.totalJSHeapSize,
        jsHeapSizeLimit: memory.jsHeapSizeLimit,
      });
    }
  }, []);

  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      updateMemoryInfo();
      
      const interval = setInterval(updateMemoryInfo, 5000); // 每5秒更新一次
      
      return () => clearInterval(interval);
    }
  }, [updateMemoryInfo]);

  // 在组件卸载时记录内存使用情况
  useEffect(() => {
    return () => {
      if (process.env.NODE_ENV === 'development' && memoryInfo) {
        logger.perf(`组件 ${componentName} 卸载时内存使用`, {
          usedMB: (memoryInfo.usedJSHeapSize / 1024 / 1024).toFixed(2),
          totalMB: (memoryInfo.totalJSHeapSize / 1024 / 1024).toFixed(2),
          limitMB: (memoryInfo.jsHeapSizeLimit / 1024 / 1024).toFixed(2),
        });
      }
    };
  }, [componentName, memoryInfo]);

  return memoryInfo;
}

/**
 * 大数据集分页Hook，避免一次性渲染大量数据
 */
export function usePagination<T>(
  data: T[],
  pageSize: number = 50
) {
  const [currentPage, setCurrentPage] = useState(0);
  
  const totalPages = Math.ceil(data.length / pageSize);
  
  const currentData = useMemo(() => {
    const start = currentPage * pageSize;
    const end = start + pageSize;
    return data.slice(start, end);
  }, [data, currentPage, pageSize]);

  const goToPage = useCallback((page: number) => {
    setCurrentPage(Math.max(0, Math.min(page, totalPages - 1)));
  }, [totalPages]);

  const nextPage = useCallback(() => {
    goToPage(currentPage + 1);
  }, [currentPage, goToPage]);

  const prevPage = useCallback(() => {
    goToPage(currentPage - 1);
  }, [currentPage, goToPage]);

  const reset = useCallback(() => {
    setCurrentPage(0);
  }, []);

  return {
    currentData,
    currentPage,
    totalPages,
    hasNext: currentPage < totalPages - 1,
    hasPrev: currentPage > 0,
    goToPage,
    nextPage,
    prevPage,
    reset,
  };
}

/**
 * 智能缓存Hook，自动清理过期缓存
 */
export function useSmartCache<K, V>(
  maxSize: number = 100,
  ttl: number = 5 * 60 * 1000 // 5分钟
) {
  const cache = useRef(new Map<K, { value: V; timestamp: number }>());
  const accessOrder = useRef<K[]>([]);

  const get = useCallback((key: K): V | undefined => {
    const entry = cache.current.get(key);
    
    if (!entry) return undefined;
    
    // 检查是否过期
    if (Date.now() - entry.timestamp > ttl) {
      cache.current.delete(key);
      accessOrder.current = accessOrder.current.filter(k => k !== key);
      return undefined;
    }
    
    // 更新访问顺序
    accessOrder.current = accessOrder.current.filter(k => k !== key);
    accessOrder.current.push(key);
    
    return entry.value;
  }, [ttl]);

  const set = useCallback((key: K, value: V): void => {
    // 如果缓存已满，删除最久未访问的项
    if (cache.current.size >= maxSize && !cache.current.has(key)) {
      const oldestKey = accessOrder.current.shift();
      if (oldestKey !== undefined) {
        cache.current.delete(oldestKey);
      }
    }
    
    cache.current.set(key, { value, timestamp: Date.now() });
    
    // 更新访问顺序
    accessOrder.current = accessOrder.current.filter(k => k !== key);
    accessOrder.current.push(key);
  }, [maxSize]);

  const clear = useCallback(() => {
    cache.current.clear();
    accessOrder.current = [];
  }, []);

  const size = cache.current.size;

  // 定期清理过期缓存
  useEffect(() => {
    const cleanup = () => {
      const now = Date.now();
      const expiredKeys: K[] = [];
      
      cache.current.forEach((entry, key) => {
        if (now - entry.timestamp > ttl) {
          expiredKeys.push(key);
        }
      });
      
      expiredKeys.forEach(key => {
        cache.current.delete(key);
        accessOrder.current = accessOrder.current.filter(k => k !== key);
      });
      
      if (expiredKeys.length > 0 && process.env.NODE_ENV === 'development') {
        logger.debug('清理过期缓存', { expiredCount: expiredKeys.length });
      }
    };

    const interval = setInterval(cleanup, ttl);
    return () => clearInterval(interval);
  }, [ttl]);

  return { get, set, clear, size };
}
