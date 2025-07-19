import { useEffect, useRef, useCallback, useState } from 'react';
import { SmartCache, CacheStrategy } from '@/shared/utils/smartCache';
import { logger } from '@/shared/utils/logger';

/**
 * 预取策略枚举
 */
export enum PrefetchStrategy {
  IMMEDIATE = 'immediate', // 立即预取
  ON_HOVER = 'on-hover', // 鼠标悬停时预取
  ON_VISIBLE = 'on-visible', // 可见时预取
  ON_IDLE = 'on-idle', // 空闲时预取
  PREDICTIVE = 'predictive' // 预测性预取
}

/**
 * 预取配置接口
 */
export interface PrefetchConfig<T> {
  // 数据获取函数
  fetcher: (key: string) => Promise<T>;
  
  // 预取策略
  strategy: PrefetchStrategy;
  
  // 缓存配置
  enableCache?: boolean;
  cacheStrategy?: CacheStrategy;
  cacheTTL?: number;
  
  // 预取控制
  maxConcurrent?: number; // 最大并发预取数
  delay?: number; // 预取延迟 (ms)
  priority?: number; // 预取优先级
  
  // 条件控制
  enabled?: boolean;
  condition?: () => boolean;
  
  // 网络优化
  respectNetworkConditions?: boolean;
  minBandwidth?: number; // 最小带宽要求 (Mbps)
  
  // 错误处理
  maxRetries?: number;
  retryDelay?: number;
}

/**
 * 预取状态接口
 */
export interface PrefetchState {
  prefetching: Set<string>;
  prefetched: Set<string>;
  failed: Set<string>;
  queue: string[];
  stats: {
    totalPrefetched: number;
    totalFailed: number;
    cacheHitRate: number;
    averagePrefetchTime: number;
  };
}

/**
 * 网络信息接口
 */
interface NetworkInformation {
  downlink?: number;
  effectiveType?: string;
  saveData?: boolean;
}

/**
 * 智能数据预取Hook
 * 提供多种预取策略和智能缓存管理
 */
export function useDataPrefetch<T>(config: PrefetchConfig<T>) {
  const {
    fetcher,
    strategy,
    enableCache = true,
    cacheStrategy = CacheStrategy.ADAPTIVE,
    cacheTTL = 30 * 60 * 1000, // 30分钟
    maxConcurrent = 3,
    delay = 0,
    priority = 1,
    enabled = true,
    condition,
    respectNetworkConditions = true,
    minBandwidth = 1, // 1 Mbps
    maxRetries = 2,
    retryDelay = 1000
  } = config;

  // 状态管理
  const [state, setState] = useState<PrefetchState>({
    prefetching: new Set(),
    prefetched: new Set(),
    failed: new Set(),
    queue: [],
    stats: {
      totalPrefetched: 0,
      totalFailed: 0,
      cacheHitRate: 0,
      averagePrefetchTime: 0
    }
  });

  // 缓存和队列管理
  const cache = useRef<SmartCache<T>>();
  const prefetchQueue = useRef<Array<{ key: string; priority: number; retries: number }>>([]);
  const activePrefetches = useRef<Set<string>>(new Set());
  const prefetchTimes = useRef<number[]>([]);
  const abortControllers = useRef<Map<string, AbortController>>(new Map());

  // 初始化缓存
  useEffect(() => {
    if (enableCache) {
      cache.current = new SmartCache<T>({
        strategy: cacheStrategy,
        defaultTTL: cacheTTL,
        maxSize: 200,
        enableMetrics: true
      });
    }

    return () => {
      cache.current?.destroy();
      // 取消所有进行中的预取
      abortControllers.current.forEach(controller => controller.abort());
    };
  }, [enableCache, cacheStrategy, cacheTTL]);

  /**
   * 检查网络条件
   */
  const checkNetworkConditions = useCallback((): boolean => {
    if (!respectNetworkConditions) return true;

    const connection = (navigator as any).connection as NetworkInformation;
    if (!connection) return true;

    // 检查数据节省模式
    if (connection.saveData) {
      logger.debug('数据节省模式开启，跳过预取');
      return false;
    }

    // 检查带宽
    if (connection.downlink && connection.downlink < minBandwidth) {
      logger.debug(`带宽不足 (${connection.downlink} Mbps < ${minBandwidth} Mbps)，跳过预取`);
      return false;
    }

    // 检查连接类型
    if (connection.effectiveType === 'slow-2g' || connection.effectiveType === '2g') {
      logger.debug('网络连接较慢，跳过预取');
      return false;
    }

    return true;
  }, [respectNetworkConditions, minBandwidth]);

  /**
   * 执行预取
   */
  const executePrefetch = useCallback(async (key: string, retryCount = 0): Promise<void> => {
    if (!enabled || (condition && !condition()) || !checkNetworkConditions()) {
      return;
    }

    // 检查是否已经在预取或已预取
    if (activePrefetches.current.has(key) || state.prefetched.has(key)) {
      return;
    }

    // 检查缓存
    if (enableCache && cache.current) {
      const cached = await cache.current.get(key);
      if (cached) {
        setState(prev => ({
          ...prev,
          prefetched: new Set([...prev.prefetched, key])
        }));
        return;
      }
    }

    // 检查并发限制
    if (activePrefetches.current.size >= maxConcurrent) {
      // 添加到队列
      prefetchQueue.current.push({ key, priority, retries: retryCount });
      prefetchQueue.current.sort((a, b) => b.priority - a.priority);
      return;
    }

    activePrefetches.current.add(key);
    
    setState(prev => ({
      ...prev,
      prefetching: new Set([...prev.prefetching, key])
    }));

    // 创建AbortController
    const abortController = new AbortController();
    abortControllers.current.set(key, abortController);

    const startTime = performance.now();

    try {
      // 延迟执行
      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      // 检查是否被取消
      if (abortController.signal.aborted) {
        return;
      }

      logger.debug(`开始预取数据: ${key}`);
      const data = await fetcher(key);

      // 保存到缓存
      if (enableCache && cache.current) {
        await cache.current.set(key, data, {
          ttl: cacheTTL,
          priority,
          tags: ['prefetch']
        });
      }

      const endTime = performance.now();
      const prefetchTime = endTime - startTime;
      prefetchTimes.current.push(prefetchTime);

      // 限制时间记录数量
      if (prefetchTimes.current.length > 100) {
        prefetchTimes.current.shift();
      }

      setState(prev => ({
        ...prev,
        prefetching: new Set([...prev.prefetching].filter(k => k !== key)),
        prefetched: new Set([...prev.prefetched, key]),
        stats: {
          ...prev.stats,
          totalPrefetched: prev.stats.totalPrefetched + 1,
          averagePrefetchTime: prefetchTimes.current.reduce((sum, time) => sum + time, 0) / prefetchTimes.current.length
        }
      }));

      logger.debug(`预取完成: ${key}`, { time: `${prefetchTime.toFixed(2)}ms` });

    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }

      logger.warn(`预取失败: ${key}`, error);

      // 重试逻辑
      if (retryCount < maxRetries) {
        setTimeout(() => {
          executePrefetch(key, retryCount + 1);
        }, retryDelay * Math.pow(2, retryCount));
      } else {
        setState(prev => ({
          ...prev,
          prefetching: new Set([...prev.prefetching].filter(k => k !== key)),
          failed: new Set([...prev.failed, key]),
          stats: {
            ...prev.stats,
            totalFailed: prev.stats.totalFailed + 1
          }
        }));
      }
    } finally {
      activePrefetches.current.delete(key);
      abortControllers.current.delete(key);

      // 处理队列中的下一个项目
      if (prefetchQueue.current.length > 0) {
        const next = prefetchQueue.current.shift()!;
        executePrefetch(next.key, next.retries);
      }
    }
  }, [
    enabled,
    condition,
    checkNetworkConditions,
    enableCache,
    maxConcurrent,
    delay,
    priority,
    cacheTTL,
    fetcher,
    maxRetries,
    retryDelay,
    state.prefetched
  ]);

  /**
   * 预取数据
   */
  const prefetch = useCallback((key: string) => {
    executePrefetch(key);
  }, [executePrefetch]);

  /**
   * 批量预取
   */
  const prefetchBatch = useCallback((keys: string[]) => {
    keys.forEach(key => prefetch(key));
  }, [prefetch]);

  /**
   * 取消预取
   */
  const cancelPrefetch = useCallback((key: string) => {
    const controller = abortControllers.current.get(key);
    if (controller) {
      controller.abort();
      abortControllers.current.delete(key);
    }

    // 从队列中移除
    prefetchQueue.current = prefetchQueue.current.filter(item => item.key !== key);

    setState(prev => ({
      ...prev,
      prefetching: new Set([...prev.prefetching].filter(k => k !== key))
    }));
  }, []);

  /**
   * 清除预取状态
   */
  const clearPrefetchState = useCallback(() => {
    // 取消所有进行中的预取
    abortControllers.current.forEach(controller => controller.abort());
    abortControllers.current.clear();
    
    // 清空队列
    prefetchQueue.current = [];
    activePrefetches.current.clear();

    setState({
      prefetching: new Set(),
      prefetched: new Set(),
      failed: new Set(),
      queue: [],
      stats: {
        totalPrefetched: 0,
        totalFailed: 0,
        cacheHitRate: 0,
        averagePrefetchTime: 0
      }
    });
  }, []);

  /**
   * 获取预取数据
   */
  const getPrefetchedData = useCallback(async (key: string): Promise<T | null> => {
    if (enableCache && cache.current) {
      return await cache.current.get(key);
    }
    return null;
  }, [enableCache]);

  /**
   * 检查是否已预取
   */
  const isPrefetched = useCallback((key: string): boolean => {
    return state.prefetched.has(key);
  }, [state.prefetched]);

  /**
   * 检查是否正在预取
   */
  const isPrefetching = useCallback((key: string): boolean => {
    return state.prefetching.has(key);
  }, [state.prefetching]);

  /**
   * 获取缓存统计
   */
  const getCacheMetrics = useCallback(() => {
    return cache.current?.getMetrics() || null;
  }, []);

  // 更新缓存命中率
  useEffect(() => {
    if (enableCache && cache.current) {
      const metrics = cache.current.getMetrics();
      setState(prev => ({
        ...prev,
        stats: {
          ...prev.stats,
          cacheHitRate: metrics.hitRate
        }
      }));
    }
  }, [enableCache, state.prefetched.size]);

  return {
    prefetch,
    prefetchBatch,
    cancelPrefetch,
    clearPrefetchState,
    getPrefetchedData,
    isPrefetched,
    isPrefetching,
    getCacheMetrics,
    state
  };
}

/**
 * 路由预取Hook
 * 专门用于路由级别的数据预取
 */
export function useRoutePrefetch<T>(
  routes: Record<string, () => Promise<T>>,
  options: {
    strategy?: PrefetchStrategy;
    enableCache?: boolean;
    prefetchOnHover?: boolean;
    prefetchOnVisible?: boolean;
  } = {}
) {
  const {
    strategy = PrefetchStrategy.ON_HOVER,
    enableCache = true,
    prefetchOnHover = true,
    prefetchOnVisible = false
  } = options;

  const { prefetch, isPrefetched, getPrefetchedData } = useDataPrefetch({
    fetcher: async (route: string) => {
      const loader = routes[route];
      if (!loader) {
        throw new Error(`Route loader not found: ${route}`);
      }
      return await loader();
    },
    strategy,
    enableCache,
    cacheTTL: 10 * 60 * 1000 // 10分钟
  });

  /**
   * 预取路由数据
   */
  const prefetchRoute = useCallback((route: string) => {
    if (routes[route]) {
      prefetch(route);
    }
  }, [prefetch, routes]);

  /**
   * 获取路由数据
   */
  const getRouteData = useCallback(async (route: string) => {
    return await getPrefetchedData(route);
  }, [getPrefetchedData]);

  /**
   * 创建链接预取处理器
   */
  const createLinkHandler = useCallback((route: string) => {
    const handlers: any = {};

    if (prefetchOnHover) {
      handlers.onMouseEnter = () => prefetchRoute(route);
    }

    if (prefetchOnVisible) {
      // 这里可以添加Intersection Observer逻辑
    }

    return handlers;
  }, [prefetchRoute, prefetchOnHover, prefetchOnVisible]);

  return {
    prefetchRoute,
    getRouteData,
    isPrefetched,
    createLinkHandler
  };
}
