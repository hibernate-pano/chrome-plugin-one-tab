import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { SmartCache, CacheStrategy } from '@/shared/utils/smartCache';
import { logger } from '@/shared/utils/logger';

/**
 * 懒加载配置接口
 */
export interface LazyLoadingConfig<T> {
  // 数据加载函数
  loadData: (params: any) => Promise<T>;
  
  // 缓存配置
  cacheKey?: string;
  enableCache?: boolean;
  cacheStrategy?: CacheStrategy;
  cacheTTL?: number;
  
  // 懒加载配置
  threshold?: number; // 触发加载的阈值 (px)
  rootMargin?: string; // Intersection Observer 的 rootMargin
  
  // 分页配置
  enablePagination?: boolean;
  pageSize?: number;
  
  // 重试配置
  maxRetries?: number;
  retryDelay?: number;
  
  // 预加载配置
  enablePreload?: boolean;
  preloadDistance?: number; // 预加载距离
}

/**
 * 懒加载状态接口
 */
export interface LazyLoadingState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  hasMore: boolean;
  page: number;
  totalPages: number;
  retryCount: number;
}

/**
 * 懒加载Hook
 * 提供数据懒加载、缓存、分页等功能
 */
export function useLazyLoading<T>(
  config: LazyLoadingConfig<T>,
  dependencies: any[] = []
) {
  const {
    loadData,
    cacheKey,
    enableCache = true,
    cacheStrategy = CacheStrategy.ADAPTIVE,
    cacheTTL = 30 * 60 * 1000, // 30分钟
    threshold = 100,
    rootMargin = '0px',
    enablePagination = false,
    pageSize = 20,
    maxRetries = 3,
    retryDelay = 1000,
    enablePreload = false,
    preloadDistance = 200
  } = config;

  // 状态管理
  const [state, setState] = useState<LazyLoadingState<T>>({
    data: null,
    loading: false,
    error: null,
    hasMore: true,
    page: 1,
    totalPages: 1,
    retryCount: 0
  });

  // 缓存实例
  const cache = useRef<SmartCache<T>>();
  const observerRef = useRef<IntersectionObserver>();
  const loadingRef = useRef(false);
  const abortControllerRef = useRef<AbortController>();

  // 初始化缓存
  useEffect(() => {
    if (enableCache) {
      cache.current = new SmartCache<T>({
        strategy: cacheStrategy,
        defaultTTL: cacheTTL,
        maxSize: 100,
        enableMetrics: true
      });
    }

    return () => {
      cache.current?.destroy();
    };
  }, [enableCache, cacheStrategy, cacheTTL]);

  /**
   * 生成缓存键
   */
  const generateCacheKey = useCallback((params: any): string => {
    if (cacheKey) {
      return `${cacheKey}_${JSON.stringify(params)}`;
    }
    return `lazy_${JSON.stringify(params)}`;
  }, [cacheKey]);

  /**
   * 加载数据
   */
  const loadDataWithCache = useCallback(async (params: any): Promise<T> => {
    const key = generateCacheKey(params);
    
    // 尝试从缓存获取
    if (enableCache && cache.current) {
      const cachedData = await cache.current.get(key);
      if (cachedData) {
        logger.debug(`懒加载缓存命中: ${key}`);
        return cachedData;
      }
    }

    // 从数据源加载
    logger.debug(`懒加载数据: ${key}`);
    const data = await loadData(params);

    // 保存到缓存
    if (enableCache && cache.current) {
      await cache.current.set(key, data, {
        ttl: cacheTTL,
        tags: ['lazy-loading']
      });
    }

    return data;
  }, [loadData, generateCacheKey, enableCache, cacheTTL]);

  /**
   * 执行加载
   */
  const executeLoad = useCallback(async (params: any, isRetry = false) => {
    if (loadingRef.current && !isRetry) return;

    loadingRef.current = true;
    
    // 取消之前的请求
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    
    abortControllerRef.current = new AbortController();

    setState(prev => ({
      ...prev,
      loading: true,
      error: null
    }));

    try {
      const data = await loadDataWithCache(params);
      
      setState(prev => ({
        ...prev,
        data,
        loading: false,
        error: null,
        retryCount: 0
      }));

      logger.debug('懒加载成功', { params });
      
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return; // 请求被取消，不更新状态
      }

      logger.error('懒加载失败', error);

      setState(prev => {
        const newRetryCount = prev.retryCount + 1;
        
        return {
          ...prev,
          loading: false,
          error: error as Error,
          retryCount: newRetryCount
        };
      });

      // 自动重试
      if (state.retryCount < maxRetries) {
        setTimeout(() => {
          executeLoad(params, true);
        }, retryDelay * Math.pow(2, state.retryCount)); // 指数退避
      }
    } finally {
      loadingRef.current = false;
    }
  }, [loadDataWithCache, state.retryCount, maxRetries, retryDelay]);

  /**
   * 手动加载
   */
  const load = useCallback((params: any = {}) => {
    executeLoad(params);
  }, [executeLoad]);

  /**
   * 重试加载
   */
  const retry = useCallback(() => {
    if (state.error) {
      executeLoad({}, true);
    }
  }, [executeLoad, state.error]);

  /**
   * 清除缓存
   */
  const clearCache = useCallback((pattern?: string) => {
    if (cache.current) {
      if (pattern) {
        cache.current.deleteByPattern(new RegExp(pattern));
      } else {
        cache.current.clear();
      }
    }
  }, []);

  /**
   * 预加载数据
   */
  const preload = useCallback(async (params: any) => {
    if (!enablePreload) return;

    try {
      await loadDataWithCache(params);
      logger.debug('预加载完成', { params });
    } catch (error) {
      logger.warn('预加载失败', error);
    }
  }, [enablePreload, loadDataWithCache]);

  /**
   * 获取缓存统计
   */
  const getCacheMetrics = useCallback(() => {
    return cache.current?.getMetrics() || null;
  }, []);

  // 依赖项变化时重新加载
  useEffect(() => {
    if (dependencies.length > 0) {
      load();
    }
  }, dependencies);

  // 清理
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, []);

  return {
    ...state,
    load,
    retry,
    preload,
    clearCache,
    getCacheMetrics
  };
}

/**
 * 图片懒加载Hook
 */
export function useLazyImage(src: string, options: {
  placeholder?: string;
  threshold?: number;
  rootMargin?: string;
  enableCache?: boolean;
} = {}) {
  const {
    placeholder,
    threshold = 0.1,
    rootMargin = '50px',
    enableCache = true
  } = options;

  const [imageSrc, setImageSrc] = useState<string>(placeholder || '');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const observerRef = useRef<IntersectionObserver>();

  // 缓存已加载的图片
  const imageCache = useRef<Set<string>>(new Set());

  const loadImage = useCallback(async () => {
    if (!src) return;

    // 检查缓存
    if (enableCache && imageCache.current.has(src)) {
      setImageSrc(src);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // 预加载图片
      const img = new Image();
      img.onload = () => {
        setImageSrc(src);
        setLoading(false);
        
        if (enableCache) {
          imageCache.current.add(src);
        }
      };
      img.onerror = () => {
        setError(new Error('图片加载失败'));
        setLoading(false);
      };
      img.src = src;
    } catch (err) {
      setError(err as Error);
      setLoading(false);
    }
  }, [src, enableCache]);

  // 设置Intersection Observer
  useEffect(() => {
    if (!imgRef.current) return;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            loadImage();
            observerRef.current?.unobserve(entry.target);
          }
        });
      },
      {
        threshold,
        rootMargin
      }
    );

    observerRef.current.observe(imgRef.current);

    return () => {
      observerRef.current?.disconnect();
    };
  }, [loadImage, threshold, rootMargin]);

  return {
    imgRef,
    src: imageSrc,
    loading,
    error,
    reload: loadImage
  };
}

/**
 * 无限滚动Hook
 */
export function useInfiniteScroll<T>(
  loadMore: (page: number) => Promise<T[]>,
  options: {
    threshold?: number;
    rootMargin?: string;
    hasMore?: boolean;
    enabled?: boolean;
  } = {}
) {
  const {
    threshold = 1.0,
    rootMargin = '0px',
    hasMore = true,
    enabled = true
  } = options;

  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [page, setPage] = useState(1);
  const [hasMoreItems, setHasMoreItems] = useState(hasMore);

  const sentinelRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver>();

  const loadNextPage = useCallback(async () => {
    if (loading || !hasMoreItems || !enabled) return;

    setLoading(true);
    setError(null);

    try {
      const newItems = await loadMore(page);
      
      if (newItems.length === 0) {
        setHasMoreItems(false);
      } else {
        setItems(prev => [...prev, ...newItems]);
        setPage(prev => prev + 1);
      }
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [loadMore, page, loading, hasMoreItems, enabled]);

  // 设置Intersection Observer
  useEffect(() => {
    if (!sentinelRef.current || !enabled) return;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            loadNextPage();
          }
        });
      },
      {
        threshold,
        rootMargin
      }
    );

    observerRef.current.observe(sentinelRef.current);

    return () => {
      observerRef.current?.disconnect();
    };
  }, [loadNextPage, threshold, rootMargin, enabled]);

  const reset = useCallback(() => {
    setItems([]);
    setPage(1);
    setHasMoreItems(true);
    setError(null);
  }, []);

  return {
    items,
    loading,
    error,
    hasMore: hasMoreItems,
    sentinelRef,
    loadNextPage,
    reset
  };
}
