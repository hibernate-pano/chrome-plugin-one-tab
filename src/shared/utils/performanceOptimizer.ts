import React from 'react';
import { logger } from './logger';

/**
 * 性能优化工具集
 * 提供组件性能优化的工具函数和HOC
 */

/**
 * 深度比较函数，用于React.memo的比较
 */
export function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  
  if (a == null || b == null) return false;
  
  if (typeof a !== typeof b) return false;
  
  if (typeof a !== 'object') return false;
  
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
 * 创建优化的memo比较函数
 */
export function createMemoComparison<T>(
  compareKeys?: (keyof T)[],
  customCompare?: (prev: T, next: T) => boolean
) {
  return (prevProps: T, nextProps: T): boolean => {
    // 如果提供了自定义比较函数，优先使用
    if (customCompare) {
      return customCompare(prevProps, nextProps);
    }
    
    // 如果指定了比较的键，只比较这些键
    if (compareKeys) {
      return compareKeys.every(key => 
        deepEqual(prevProps[key], nextProps[key])
      );
    }
    
    // 默认深度比较所有属性
    return deepEqual(prevProps, nextProps);
  };
}

/**
 * 性能监控HOC
 */
export function withPerformanceMonitoring<P extends object>(
  WrappedComponent: React.ComponentType<P>,
  componentName: string
) {
  const MonitoredComponent = React.memo(
    React.forwardRef<any, P>((props, ref) => {
      const renderStartTime = React.useRef<number>();
      
      // 记录渲染开始时间
      renderStartTime.current = performance.now();
      
      React.useEffect(() => {
        if (renderStartTime.current) {
          const renderTime = performance.now() - renderStartTime.current;
          
          if (renderTime > 16) { // 超过16ms（60fps）
            logger.warn(`组件 ${componentName} 渲染时间过长: ${renderTime.toFixed(2)}ms`);
          }
          
          if (process.env.NODE_ENV === 'development') {
            logger.debug(`组件 ${componentName} 渲染时间: ${renderTime.toFixed(2)}ms`);
          }
        }
      });
      
      return React.createElement(WrappedComponent, { ...props, ref });
    }),
    createMemoComparison()
  );
  
  MonitoredComponent.displayName = `withPerformanceMonitoring(${componentName})`;
  
  return MonitoredComponent;
}

/**
 * 批量状态更新工具
 */
export class BatchUpdater {
  private updates: (() => void)[] = [];
  private timeoutId: number | null = null;
  
  /**
   * 添加更新到批次中
   */
  addUpdate(update: () => void) {
    this.updates.push(update);
    
    if (this.timeoutId === null) {
      this.timeoutId = window.setTimeout(() => {
        this.flushUpdates();
      }, 0);
    }
  }
  
  /**
   * 立即执行所有批次更新
   */
  flushUpdates() {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    
    const updates = [...this.updates];
    this.updates = [];
    
    // 使用React的批处理机制
    React.unstable_batchedUpdates(() => {
      updates.forEach(update => update());
    });
  }
  
  /**
   * 清理所有待处理的更新
   */
  clear() {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.updates = [];
  }
}

/**
 * 创建批量更新器的Hook
 */
export function useBatchUpdater() {
  const batchUpdater = React.useRef(new BatchUpdater());
  
  React.useEffect(() => {
    return () => {
      batchUpdater.current.clear();
    };
  }, []);
  
  return batchUpdater.current;
}

/**
 * 防抖渲染Hook
 */
export function useDebouncedRender<T>(
  value: T,
  delay: number = 300
): T {
  const [debouncedValue, setDebouncedValue] = React.useState(value);
  
  React.useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);
    
    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);
  
  return debouncedValue;
}

/**
 * 渲染次数监控Hook
 */
export function useRenderCount(componentName: string) {
  const renderCount = React.useRef(0);
  
  React.useEffect(() => {
    renderCount.current += 1;
    
    if (process.env.NODE_ENV === 'development') {
      logger.debug(`组件 ${componentName} 渲染次数: ${renderCount.current}`);
      
      if (renderCount.current > 10) {
        logger.warn(`组件 ${componentName} 渲染次数过多: ${renderCount.current}`);
      }
    }
  });
  
  return renderCount.current;
}

/**
 * 组件大小监控Hook
 */
export function useComponentSize(ref: React.RefObject<HTMLElement>) {
  const [size, setSize] = React.useState({ width: 0, height: 0 });
  
  React.useEffect(() => {
    if (!ref.current) return;
    
    const resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setSize({ width, height });
      }
    });
    
    resizeObserver.observe(ref.current);
    
    return () => {
      resizeObserver.disconnect();
    };
  }, [ref]);
  
  return size;
}

/**
 * 性能优化的列表渲染Hook
 */
export function useOptimizedList<T>(
  items: T[],
  keyExtractor: (item: T, index: number) => string,
  renderItem: (item: T, index: number) => React.ReactNode,
  windowSize: number = 10
) {
  const [visibleRange, setVisibleRange] = React.useState({ start: 0, end: windowSize });
  
  const visibleItems = React.useMemo(() => {
    return items.slice(visibleRange.start, visibleRange.end);
  }, [items, visibleRange]);
  
  const renderedItems = React.useMemo(() => {
    return visibleItems.map((item, index) => {
      const actualIndex = visibleRange.start + index;
      return {
        key: keyExtractor(item, actualIndex),
        element: renderItem(item, actualIndex)
      };
    });
  }, [visibleItems, visibleRange.start, keyExtractor, renderItem]);
  
  return {
    renderedItems,
    setVisibleRange,
    totalItems: items.length,
    visibleRange
  };
}
