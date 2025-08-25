import { useCallback, useMemo, useRef, useEffect, useState } from 'react';
import { renderStatsManager, useRenderMonitor, useBatchedUpdates } from '@/shared/utils/renderOptimizer';

/**
 * 组件渲染优化Hook集合
 * 提供一站式的组件渲染性能优化解决方案
 */

/**
 * 智能渲染优化Hook
 * 自动应用多种渲染优化策略
 */
export function useSmartRenderOptimization(
  componentName: string,
  options: {
    enableMonitoring?: boolean;
    enableBatching?: boolean;
    cacheSize?: number;
    warningThreshold?: number;
  } = {}
) {
  const {
    enableMonitoring = process.env.NODE_ENV === 'development',
    enableBatching = true,
    cacheSize = 10,
    warningThreshold = 16
  } = options;

  // 渲染监控
  const { renderCount, getStats } = useRenderMonitor(componentName, {
    enabled: enableMonitoring,
    warningThreshold
  });

  // 批量更新
  const scheduleUpdate = useBatchedUpdates();

  // 回调函数缓存
  const callbackCache = useRef<Map<string, any>>(new Map());
  const memoCache = useRef<Map<string, any>>(new Map());

  /**
   * 优化的useCallback
   */
  const optimizedCallback = useCallback(<T extends (...args: any[]) => any>(
    callback: T,
    deps: React.DependencyList,
    cacheKey?: string
  ): T => {
    const key = cacheKey || JSON.stringify(deps);
    
    if (callbackCache.current.has(key)) {
      return callbackCache.current.get(key);
    }

    const memoizedCallback = useCallback(callback, deps);
    callbackCache.current.set(key, memoizedCallback);

    // 限制缓存大小
    if (callbackCache.current.size > cacheSize) {
      const firstKey = callbackCache.current.keys().next().value;
      callbackCache.current.delete(firstKey);
    }

    return memoizedCallback;
  }, [cacheSize]);

  /**
   * 优化的useMemo
   */
  const optimizedMemo = useCallback(<T>(
    factory: () => T,
    deps: React.DependencyList,
    cacheKey?: string
  ): T => {
    const key = cacheKey || JSON.stringify(deps);
    
    if (memoCache.current.has(key)) {
      return memoCache.current.get(key);
    }

    const memoizedValue = useMemo(factory, deps);
    memoCache.current.set(key, memoizedValue);

    // 限制缓存大小
    if (memoCache.current.size > cacheSize) {
      const firstKey = memoCache.current.keys().next().value;
      memoCache.current.delete(firstKey);
    }

    return memoizedValue;
  }, [cacheSize]);

  /**
   * 批量状态更新
   */
  const batchedUpdate = useCallback((updates: Array<() => void>) => {
    if (enableBatching) {
      updates.forEach(update => scheduleUpdate(update));
    } else {
      updates.forEach(update => update());
    }
  }, [enableBatching, scheduleUpdate]);

  // 清理缓存
  useEffect(() => {
    return () => {
      callbackCache.current.clear();
      memoCache.current.clear();
    };
  }, []);

  return {
    renderCount,
    getStats,
    optimizedCallback,
    optimizedMemo,
    batchedUpdate,
    clearCache: () => {
      callbackCache.current.clear();
      memoCache.current.clear();
    }
  };
}

/**
 * 条件渲染优化Hook
 * 避免不必要的条件渲染计算
 */
export function useConditionalRender<T>(
  condition: boolean,
  renderFn: () => T,
  fallback?: T,
  deps: React.DependencyList = []
): T | undefined {
  const lastResult = useRef<T>();
  const lastCondition = useRef<boolean>();

  return useMemo(() => {
    if (condition) {
      if (condition !== lastCondition.current) {
        lastResult.current = renderFn();
        lastCondition.current = condition;
      }
      return lastResult.current;
    } else {
      lastCondition.current = condition;
      return fallback;
    }
  }, [condition, ...deps]);
}

/**
 * 列表渲染优化Hook
 * 优化大列表的渲染性能
 */
export function useOptimizedList<T>(
  items: T[],
  renderItem: (item: T, index: number) => React.ReactNode,
  options: {
    keyExtractor?: (item: T, index: number) => string;
    windowSize?: number;
    enableVirtualization?: boolean;
    itemHeight?: number;
  } = {}
) {
  const {
    keyExtractor = (_, index) => index.toString(),
    windowSize = 50,
    enableVirtualization = items.length > 100,
    itemHeight = 50
  } = options;

  const [visibleRange, setVisibleRange] = useState({ start: 0, end: windowSize });
  const containerRef = useRef<HTMLDivElement>(null);

  // 虚拟化滚动处理
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (!enableVirtualization) return;

    const scrollTop = e.currentTarget.scrollTop;
    const containerHeight = e.currentTarget.clientHeight;
    
    const start = Math.floor(scrollTop / itemHeight);
    const visibleCount = Math.ceil(containerHeight / itemHeight);
    const end = Math.min(start + visibleCount + 10, items.length); // 10个缓冲项

    setVisibleRange({ start: Math.max(0, start - 5), end });
  }, [enableVirtualization, itemHeight, items.length]);

  // 渲染可见项目
  const renderedItems = useMemo(() => {
    const itemsToRender = enableVirtualization 
      ? items.slice(visibleRange.start, visibleRange.end)
      : items;

    return itemsToRender.map((item, index) => {
      const actualIndex = enableVirtualization ? visibleRange.start + index : index;
      const key = keyExtractor(item, actualIndex);
      
      return {
        key,
        element: renderItem(item, actualIndex),
        style: enableVirtualization ? {
          position: 'absolute' as const,
          top: actualIndex * itemHeight,
          height: itemHeight,
          width: '100%'
        } : undefined
      };
    });
  }, [items, visibleRange, enableVirtualization, keyExtractor, renderItem, itemHeight]);

  // 容器样式
  const containerStyle = useMemo(() => {
    if (!enableVirtualization) return {};
    
    return {
      height: items.length * itemHeight,
      position: 'relative' as const,
      overflow: 'auto' as const
    };
  }, [enableVirtualization, items.length, itemHeight]);

  return {
    renderedItems,
    containerRef,
    containerStyle,
    handleScroll,
    visibleRange,
    totalHeight: items.length * itemHeight
  };
}

/**
 * 防抖渲染Hook
 * 防止组件频繁重新渲染
 */
export function useDebouncedRender(delay: number = 100) {
  const [shouldRender, setShouldRender] = useState(true);
  const timeoutRef = useRef<NodeJS.Timeout>();
  const renderRequestRef = useRef(false);

  const requestRender = useCallback(() => {
    if (renderRequestRef.current) return;
    
    renderRequestRef.current = true;
    setShouldRender(false);

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = setTimeout(() => {
      setShouldRender(true);
      renderRequestRef.current = false;
    }, delay);
  }, [delay]);

  const cancelRender = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    renderRequestRef.current = false;
    setShouldRender(true);
  }, []);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return {
    shouldRender,
    requestRender,
    cancelRender
  };
}

/**
 * 组件更新原因分析Hook
 * 帮助开发者分析组件重新渲染的原因
 */
export function useWhyDidYouUpdate(name: string, props: Record<string, any>) {
  const previousProps = useRef<Record<string, any>>();

  useEffect(() => {
    if (previousProps.current) {
      const allKeys = Object.keys({ ...previousProps.current, ...props });
      const changedProps: Record<string, { from: any; to: any }> = {};

      allKeys.forEach(key => {
        if (previousProps.current![key] !== props[key]) {
          changedProps[key] = {
            from: previousProps.current![key],
            to: props[key]
          };
        }
      });

      if (Object.keys(changedProps).length) {
        console.log('[WhyDidYouUpdate]', name, changedProps);
      }
    }

    previousProps.current = props;
  });
}

/**
 * 渲染性能分析Hook
 * 提供详细的渲染性能分析数据
 */
export function useRenderAnalysis(componentName: string) {
  const [analysis, setAnalysis] = useState<{
    renderCount: number;
    averageRenderTime: number;
    maxRenderTime: number;
    lastRenderTime: number;
    slowRenders: number;
    recommendations: string[];
  }>({
    renderCount: 0,
    averageRenderTime: 0,
    maxRenderTime: 0,
    lastRenderTime: 0,
    slowRenders: 0,
    recommendations: []
  });

  const updateAnalysis = useCallback(() => {
    const stats = renderStatsManager.getStats(componentName);
    if (stats && typeof stats === 'object' && 'renderCount' in stats) {
      const recommendations: string[] = [];
      
      if (stats.averageRenderTime > 16) {
        recommendations.push('平均渲染时间超过16ms，建议使用React.memo优化');
      }
      
      if (stats.slowRenders > stats.renderCount * 0.3) {
        recommendations.push('频繁出现慢渲染，建议检查组件逻辑');
      }
      
      if (stats.renderCount > 50) {
        recommendations.push('渲染次数较多，建议检查是否有不必要的重新渲染');
      }

      setAnalysis({
        renderCount: stats.renderCount,
        averageRenderTime: stats.averageRenderTime,
        maxRenderTime: stats.maxRenderTime,
        lastRenderTime: stats.lastRenderTime,
        slowRenders: stats.slowRenders,
        recommendations
      });
    }
  }, [componentName]);

  // 定期更新分析数据
  useEffect(() => {
    const interval = setInterval(updateAnalysis, 5000);
    return () => clearInterval(interval);
  }, [updateAnalysis]);

  return analysis;
}

/**
 * 组件渲染优化建议Hook
 * 基于组件的使用模式提供优化建议
 */
export function useOptimizationSuggestions(
  componentName: string,
  props: Record<string, any>
) {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const propsHistory = useRef<Array<Record<string, any>>>([]);
  const maxHistorySize = 10;

  useEffect(() => {
    // 记录props历史
    propsHistory.current.push(props);
    if (propsHistory.current.length > maxHistorySize) {
      propsHistory.current.shift();
    }

    // 分析props变化模式
    const newSuggestions: string[] = [];
    
    // 检查是否有频繁变化的props
    const propChangeFrequency: Record<string, number> = {};
    for (let i = 1; i < propsHistory.current.length; i++) {
      const prev = propsHistory.current[i - 1];
      const curr = propsHistory.current[i];
      
      Object.keys(curr).forEach(key => {
        if (prev[key] !== curr[key]) {
          propChangeFrequency[key] = (propChangeFrequency[key] || 0) + 1;
        }
      });
    }

    // 生成建议
    Object.entries(propChangeFrequency).forEach(([key, frequency]) => {
      if (frequency > propsHistory.current.length * 0.7) {
        newSuggestions.push(`属性 "${key}" 变化频繁，建议使用useCallback或useMemo优化`);
      }
    });

    // 检查对象类型的props
    Object.entries(props).forEach(([key, value]) => {
      if (typeof value === 'object' && value !== null) {
        newSuggestions.push(`属性 "${key}" 是对象类型，建议使用useMemo缓存或考虑拆分`);
      }
      
      if (typeof value === 'function') {
        newSuggestions.push(`属性 "${key}" 是函数类型，建议使用useCallback缓存`);
      }
    });

    setSuggestions(newSuggestions);
  }, [props]);

  return suggestions;
}
