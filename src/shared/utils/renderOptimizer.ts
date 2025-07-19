import React, { useCallback, useMemo, useRef, useEffect } from 'react';
import { logger } from './logger';

/**
 * 渲染优化工具集
 * 提供组件渲染性能优化的工具函数和Hook
 */

/**
 * 渲染性能监控配置
 */
export interface RenderMonitorConfig {
  enabled: boolean;
  warningThreshold: number; // 渲染时间警告阈值 (ms)
  errorThreshold: number; // 渲染时间错误阈值 (ms)
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

/**
 * 默认渲染监控配置
 */
const DEFAULT_RENDER_CONFIG: RenderMonitorConfig = {
  enabled: process.env.NODE_ENV === 'development',
  warningThreshold: 16, // 60fps
  errorThreshold: 33, // 30fps
  logLevel: 'warn'
};

/**
 * 渲染性能统计
 */
export interface RenderStats {
  componentName: string;
  renderCount: number;
  totalRenderTime: number;
  averageRenderTime: number;
  maxRenderTime: number;
  minRenderTime: number;
  lastRenderTime: number;
  slowRenders: number; // 超过阈值的渲染次数
}

/**
 * 全局渲染统计管理器
 */
class RenderStatsManager {
  private static instance: RenderStatsManager;
  private stats = new Map<string, RenderStats>();
  private config: RenderMonitorConfig = DEFAULT_RENDER_CONFIG;

  static getInstance(): RenderStatsManager {
    if (!RenderStatsManager.instance) {
      RenderStatsManager.instance = new RenderStatsManager();
    }
    return RenderStatsManager.instance;
  }

  configure(config: Partial<RenderMonitorConfig>): void {
    this.config = { ...this.config, ...config };
  }

  recordRender(componentName: string, renderTime: number): void {
    if (!this.config.enabled) return;

    const existing = this.stats.get(componentName);
    
    if (existing) {
      existing.renderCount++;
      existing.totalRenderTime += renderTime;
      existing.averageRenderTime = existing.totalRenderTime / existing.renderCount;
      existing.maxRenderTime = Math.max(existing.maxRenderTime, renderTime);
      existing.minRenderTime = Math.min(existing.minRenderTime, renderTime);
      existing.lastRenderTime = renderTime;
      
      if (renderTime > this.config.warningThreshold) {
        existing.slowRenders++;
      }
    } else {
      this.stats.set(componentName, {
        componentName,
        renderCount: 1,
        totalRenderTime: renderTime,
        averageRenderTime: renderTime,
        maxRenderTime: renderTime,
        minRenderTime: renderTime,
        lastRenderTime: renderTime,
        slowRenders: renderTime > this.config.warningThreshold ? 1 : 0
      });
    }

    // 记录性能日志
    this.logRenderPerformance(componentName, renderTime);
  }

  private logRenderPerformance(componentName: string, renderTime: number): void {
    if (renderTime > this.config.errorThreshold) {
      logger.error(`组件 ${componentName} 渲染时间过长: ${renderTime.toFixed(2)}ms`);
    } else if (renderTime > this.config.warningThreshold) {
      if (this.config.logLevel === 'warn' || this.config.logLevel === 'debug') {
        logger.warn(`组件 ${componentName} 渲染时间较长: ${renderTime.toFixed(2)}ms`);
      }
    } else if (this.config.logLevel === 'debug') {
      logger.debug(`组件 ${componentName} 渲染时间: ${renderTime.toFixed(2)}ms`);
    }
  }

  getStats(componentName?: string): RenderStats | RenderStats[] {
    if (componentName) {
      return this.stats.get(componentName) || {
        componentName,
        renderCount: 0,
        totalRenderTime: 0,
        averageRenderTime: 0,
        maxRenderTime: 0,
        minRenderTime: 0,
        lastRenderTime: 0,
        slowRenders: 0
      };
    }
    return Array.from(this.stats.values());
  }

  getTopSlowComponents(limit: number = 10): RenderStats[] {
    return Array.from(this.stats.values())
      .sort((a, b) => b.averageRenderTime - a.averageRenderTime)
      .slice(0, limit);
  }

  reset(): void {
    this.stats.clear();
  }
}

// 导出单例实例
export const renderStatsManager = RenderStatsManager.getInstance();

/**
 * 渲染性能监控Hook
 */
export function useRenderMonitor(componentName: string, config?: Partial<RenderMonitorConfig>) {
  const renderStartTime = useRef<number>();
  const renderCount = useRef(0);

  // 配置监控器
  useEffect(() => {
    if (config) {
      renderStatsManager.configure(config);
    }
  }, [config]);

  // 记录渲染开始
  const startRender = useCallback(() => {
    renderStartTime.current = performance.now();
  }, []);

  // 记录渲染结束
  const endRender = useCallback(() => {
    if (renderStartTime.current) {
      const renderTime = performance.now() - renderStartTime.current;
      renderCount.current++;
      renderStatsManager.recordRender(componentName, renderTime);
    }
  }, [componentName]);

  // 在每次渲染时自动记录
  useEffect(() => {
    startRender();
    return endRender;
  });

  return {
    renderCount: renderCount.current,
    getStats: () => renderStatsManager.getStats(componentName) as RenderStats
  };
}

/**
 * 智能memo比较函数生成器
 * 根据组件的props特征生成优化的比较函数
 */
export function createSmartMemoComparison<T extends Record<string, any>>(
  options: {
    shallowCompareKeys?: (keyof T)[];
    deepCompareKeys?: (keyof T)[];
    ignoreKeys?: (keyof T)[];
    customComparers?: Partial<Record<keyof T, (prev: any, next: any) => boolean>>;
  } = {}
) {
  const {
    shallowCompareKeys = [],
    deepCompareKeys = [],
    ignoreKeys = [],
    customComparers = {}
  } = options;

  return (prevProps: T, nextProps: T): boolean => {
    // 检查引用相等
    if (prevProps === nextProps) return true;

    // 获取所有需要比较的键
    const allKeys = new Set([
      ...Object.keys(prevProps),
      ...Object.keys(nextProps)
    ]);

    for (const key of allKeys) {
      // 跳过忽略的键
      if (ignoreKeys.includes(key as keyof T)) continue;

      const prevValue = prevProps[key];
      const nextValue = nextProps[key];

      // 使用自定义比较器
      if (customComparers[key as keyof T]) {
        if (!customComparers[key as keyof T]!(prevValue, nextValue)) {
          return false;
        }
        continue;
      }

      // 深度比较
      if (deepCompareKeys.includes(key as keyof T)) {
        if (!deepEqual(prevValue, nextValue)) {
          return false;
        }
        continue;
      }

      // 浅比较（默认）
      if (prevValue !== nextValue) {
        return false;
      }
    }

    return true;
  };
}

/**
 * 深度比较函数
 */
function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

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
    if (!keysB.includes(key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }

  return true;
}

/**
 * 优化的useCallback Hook
 * 自动检测依赖项变化，避免不必要的函数重新创建
 */
export function useOptimizedCallback<T extends (...args: any[]) => any>(
  callback: T,
  deps: React.DependencyList,
  options: {
    deepCompareDeps?: boolean;
    maxCacheSize?: number;
  } = {}
): T {
  const { deepCompareDeps = false, maxCacheSize = 10 } = options;
  const cache = useRef<Map<string, T>>(new Map());
  const lastDeps = useRef<React.DependencyList>();

  return useMemo(() => {
    // 生成依赖项的缓存键
    const depsKey = JSON.stringify(deps);
    
    // 检查依赖项是否变化
    const depsChanged = deepCompareDeps
      ? !deepEqual(lastDeps.current, deps)
      : !shallowEqual(lastDeps.current, deps);

    if (!depsChanged && cache.current.has(depsKey)) {
      return cache.current.get(depsKey)!;
    }

    // 创建新的回调函数
    const newCallback = useCallback(callback, deps) as T;
    
    // 更新缓存
    cache.current.set(depsKey, newCallback);
    lastDeps.current = deps;

    // 限制缓存大小
    if (cache.current.size > maxCacheSize) {
      const firstKey = cache.current.keys().next().value;
      cache.current.delete(firstKey);
    }

    return newCallback;
  }, [callback, deps, deepCompareDeps, maxCacheSize]);
}

/**
 * 浅比较函数
 */
function shallowEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  
  return true;
}

/**
 * 优化的useMemo Hook
 * 支持更智能的依赖项比较和缓存策略
 */
export function useOptimizedMemo<T>(
  factory: () => T,
  deps: React.DependencyList,
  options: {
    deepCompareDeps?: boolean;
    cacheSize?: number;
    ttl?: number; // 缓存生存时间 (ms)
  } = {}
): T {
  const { deepCompareDeps = false, cacheSize = 5, ttl } = options;
  const cache = useRef<Map<string, { value: T; timestamp: number }>>(new Map());
  const lastDeps = useRef<React.DependencyList>();

  return useMemo(() => {
    const depsKey = JSON.stringify(deps);
    const now = Date.now();

    // 检查缓存
    const cached = cache.current.get(depsKey);
    if (cached) {
      // 检查TTL
      if (!ttl || (now - cached.timestamp) < ttl) {
        // 检查依赖项是否变化
        const depsChanged = deepCompareDeps
          ? !deepEqual(lastDeps.current, deps)
          : !shallowEqual(lastDeps.current, deps);

        if (!depsChanged) {
          return cached.value;
        }
      }
    }

    // 计算新值
    const newValue = factory();
    
    // 更新缓存
    cache.current.set(depsKey, { value: newValue, timestamp: now });
    lastDeps.current = deps;

    // 清理过期缓存
    if (ttl) {
      for (const [key, item] of cache.current.entries()) {
        if (now - item.timestamp > ttl) {
          cache.current.delete(key);
        }
      }
    }

    // 限制缓存大小
    if (cache.current.size > cacheSize) {
      const firstKey = cache.current.keys().next().value;
      cache.current.delete(firstKey);
    }

    return newValue;
  }, deps);
}

/**
 * 渲染批处理Hook
 * 将多个状态更新批处理到单次渲染中
 */
export function useBatchedUpdates() {
  const updateQueue = useRef<Array<() => void>>([]);
  const isScheduled = useRef(false);

  const flushUpdates = useCallback(() => {
    if (updateQueue.current.length > 0) {
      React.unstable_batchedUpdates(() => {
        updateQueue.current.forEach(update => update());
        updateQueue.current = [];
      });
    }
    isScheduled.current = false;
  }, []);

  const scheduleUpdate = useCallback((update: () => void) => {
    updateQueue.current.push(update);
    
    if (!isScheduled.current) {
      isScheduled.current = true;
      // 使用 MessageChannel 确保在下一个事件循环中执行
      const channel = new MessageChannel();
      channel.port2.onmessage = flushUpdates;
      channel.port1.postMessage(null);
    }
  }, [flushUpdates]);

  return scheduleUpdate;
}

/**
 * 组件渲染性能分析器
 */
export function useRenderProfiler(componentName: string) {
  const renderTimes = useRef<number[]>([]);
  const maxSamples = 100;

  const onRender = useCallback((
    id: string,
    phase: 'mount' | 'update',
    actualDuration: number,
    baseDuration: number,
    startTime: number,
    commitTime: number
  ) => {
    renderTimes.current.push(actualDuration);
    
    // 限制样本数量
    if (renderTimes.current.length > maxSamples) {
      renderTimes.current.shift();
    }

    // 记录性能数据
    renderStatsManager.recordRender(componentName, actualDuration);

    // 在开发环境中提供详细日志
    if (process.env.NODE_ENV === 'development' && actualDuration > 16) {
      logger.warn(`组件 ${componentName} 渲染性能分析:`, {
        phase,
        actualDuration: `${actualDuration.toFixed(2)}ms`,
        baseDuration: `${baseDuration.toFixed(2)}ms`,
        improvement: baseDuration > actualDuration ? `${((baseDuration - actualDuration) / baseDuration * 100).toFixed(1)}%` : '0%'
      });
    }
  }, [componentName]);

  const getAverageRenderTime = useCallback(() => {
    if (renderTimes.current.length === 0) return 0;
    return renderTimes.current.reduce((sum, time) => sum + time, 0) / renderTimes.current.length;
  }, []);

  const getMaxRenderTime = useCallback(() => {
    return renderTimes.current.length > 0 ? Math.max(...renderTimes.current) : 0;
  }, []);

  return {
    onRender,
    getAverageRenderTime,
    getMaxRenderTime,
    sampleCount: renderTimes.current.length
  };
}

/**
 * 渲染优化报告生成器
 */
export function generateRenderOptimizationReport(): {
  summary: {
    totalComponents: number;
    slowComponents: number;
    averageRenderTime: number;
    totalRenders: number;
  };
  recommendations: string[];
  topSlowComponents: RenderStats[];
} {
  const allStats = renderStatsManager.getStats() as RenderStats[];
  const slowComponents = allStats.filter(stat => stat.averageRenderTime > 16);
  
  const totalRenders = allStats.reduce((sum, stat) => sum + stat.renderCount, 0);
  const totalRenderTime = allStats.reduce((sum, stat) => sum + stat.totalRenderTime, 0);
  const averageRenderTime = totalRenders > 0 ? totalRenderTime / totalRenders : 0;

  const recommendations: string[] = [];
  
  if (slowComponents.length > 0) {
    recommendations.push(`发现 ${slowComponents.length} 个渲染较慢的组件，建议使用 React.memo 优化`);
  }
  
  if (averageRenderTime > 10) {
    recommendations.push('整体渲染性能较慢，建议检查组件结构和状态管理');
  }
  
  const componentsWithManySlowRenders = allStats.filter(stat => 
    stat.slowRenders > stat.renderCount * 0.3
  );
  
  if (componentsWithManySlowRenders.length > 0) {
    recommendations.push('部分组件频繁出现慢渲染，建议优化组件逻辑或拆分组件');
  }

  return {
    summary: {
      totalComponents: allStats.length,
      slowComponents: slowComponents.length,
      averageRenderTime,
      totalRenders
    },
    recommendations,
    topSlowComponents: renderStatsManager.getTopSlowComponents(10)
  };
}
