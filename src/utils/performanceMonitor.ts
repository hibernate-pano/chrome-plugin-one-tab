/**
 * 性能监控工具
 * 提供性能指标收集和分析
 */

import { useState, useEffect, useCallback } from 'react';

export interface PerformanceMetric {
  name: string;
  value: number;
  unit: 'ms' | 'bytes' | 'count';
  timestamp: number;
  category: 'rendering' | 'network' | 'memory' | 'interaction';
}

export interface PerformanceReport {
  metrics: PerformanceMetric[];
  summary: {
    avgRenderTime: number;
    avgInteractionTime: number;
    memoryUsage: number;
    slowOperations: Array<{ name: string; duration: number }>;
  };
  recommendations: string[];
}

class PerformanceMonitor {
  private static instance: PerformanceMonitor;
  private metrics: PerformanceMetric[] = [];
  private observers: PerformanceObserver[] = [];
  private readonly MAX_METRICS = 1000;

  private constructor() {
    this.setupObservers();
  }

  static getInstance(): PerformanceMonitor {
    if (!PerformanceMonitor.instance) {
      PerformanceMonitor.instance = new PerformanceMonitor();
    }
    return PerformanceMonitor.instance;
  }

  /**
   * 设置性能观察者
   */
  private setupObservers() {
    // 观察长任务
    if ('PerformanceObserver' in window) {
      try {
        const longTaskObserver = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            this.recordMetric({
              name: 'long-task',
              value: entry.duration,
              unit: 'ms',
              timestamp: entry.startTime,
              category: 'rendering',
            });
          }
        });
        longTaskObserver.observe({ entryTypes: ['longtask'] });
        this.observers.push(longTaskObserver);
      } catch (e) {
        console.warn('Long task observer not supported');
      }

      // 观察布局偏移
      try {
        const layoutShiftObserver = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            if ('value' in entry) {
              this.recordMetric({
                name: 'layout-shift',
                value: (entry as any).value * 1000,
                unit: 'ms',
                timestamp: entry.startTime,
                category: 'rendering',
              });
            }
          }
        });
        layoutShiftObserver.observe({ entryTypes: ['layout-shift'] });
        this.observers.push(layoutShiftObserver);
      } catch (e) {
        console.warn('Layout shift observer not supported');
      }
    }
  }

  /**
   * 记录指标
   */
  recordMetric(metric: PerformanceMetric) {
    this.metrics.push(metric);

    // 限制存储的指标数量
    if (this.metrics.length > this.MAX_METRICS) {
      this.metrics = this.metrics.slice(-this.MAX_METRICS);
    }
  }

  /**
   * 测量函数执行时间
   */
  measure<T>(name: string, fn: () => T): T {
    const startTime = performance.now();
    try {
      return fn();
    } finally {
      const duration = performance.now() - startTime;
      this.recordMetric({
        name,
        value: duration,
        unit: 'ms',
        timestamp: startTime,
        category: 'interaction',
      });
    }
  }

  /**
   * 测量异步函数执行时间
   */
  async measureAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const startTime = performance.now();
    try {
      return await fn();
    } finally {
      const duration = performance.now() - startTime;
      this.recordMetric({
        name,
        value: duration,
        unit: 'ms',
        timestamp: startTime,
        category: 'interaction',
      });
    }
  }

  /**
   * 标记时间点
   */
  mark(name: string) {
    performance.mark(name);
  }

  /**
   * 测量两个标记之间的时间
   */
  measureBetweenMarks(name: string, startMark: string, endMark: string) {
    try {
      performance.measure(name, startMark, endMark);
      const measure = performance.getEntriesByName(name, 'measure')[0];
      if (measure) {
        this.recordMetric({
          name,
          value: measure.duration,
          unit: 'ms',
          timestamp: measure.startTime,
          category: 'interaction',
        });
      }
    } catch (e) {
      console.warn(`Failed to measure ${name}:`, e);
    }
  }

  /**
   * 获取内存使用情况
   */
  getMemoryUsage(): number {
    if ('memory' in performance && (performance as any).memory) {
      const memory = (performance as any).memory;
      return memory.usedJSHeapSize;
    }
    return 0;
  }

  /**
   * 记录内存使用
   */
  recordMemoryUsage() {
    const memoryUsage = this.getMemoryUsage();
    if (memoryUsage > 0) {
      this.recordMetric({
        name: 'memory-usage',
        value: memoryUsage,
        unit: 'bytes',
        timestamp: Date.now(),
        category: 'memory',
      });
    }
  }

  /**
   * 获取所有指标
   */
  getMetrics(): PerformanceMetric[] {
    return [...this.metrics];
  }

  /**
   * 获取指定类型的指标
   */
  getMetricsByCategory(category: PerformanceMetric['category']): PerformanceMetric[] {
    return this.metrics.filter(m => m.category === category);
  }

  /**
   * 获取指定名称的指标
   */
  getMetricsByName(name: string): PerformanceMetric[] {
    return this.metrics.filter(m => m.name === name);
  }

  /**
   * 生成性能报告
   */
  generateReport(): PerformanceReport {
    const renderMetrics = this.getMetricsByCategory('rendering');
    const interactionMetrics = this.getMetricsByCategory('interaction');
    const memoryMetrics = this.getMetricsByCategory('memory');

    // 计算平均渲染时间
    const avgRenderTime = renderMetrics.length > 0
      ? renderMetrics.reduce((sum, m) => sum + m.value, 0) / renderMetrics.length
      : 0;

    // 计算平均交互时间
    const avgInteractionTime = interactionMetrics.length > 0
      ? interactionMetrics.reduce((sum, m) => sum + m.value, 0) / interactionMetrics.length
      : 0;

    // 获取最新的内存使用
    const memoryUsage = memoryMetrics.length > 0
      ? memoryMetrics[memoryMetrics.length - 1].value
      : this.getMemoryUsage();

    // 找出慢操作（超过100ms）
    const slowOperations = interactionMetrics
      .filter(m => m.value > 100)
      .map(m => ({ name: m.name, duration: m.value }))
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 10);

    // 生成优化建议
    const recommendations: string[] = [];

    if (avgRenderTime > 50) {
      recommendations.push('平均渲染时间较长，建议优化组件渲染逻辑');
    }

    if (avgInteractionTime > 100) {
      recommendations.push('交互响应时间较长，建议使用防抖或节流');
    }

    if (memoryUsage > 50 * 1024 * 1024) { // 50MB
      recommendations.push('内存使用较高，建议检查内存泄漏');
    }

    if (slowOperations.length > 0) {
      recommendations.push(`发现 ${slowOperations.length} 个慢操作，建议优化`);
    }

    const longTasks = this.getMetricsByName('long-task');
    if (longTasks.length > 10) {
      recommendations.push('存在过多长任务，建议拆分大型操作');
    }

    return {
      metrics: this.metrics,
      summary: {
        avgRenderTime: Math.round(avgRenderTime * 100) / 100,
        avgInteractionTime: Math.round(avgInteractionTime * 100) / 100,
        memoryUsage,
        slowOperations,
      },      recommendations,
    };
  }

  /**
   * 清除所有指标
   */
  clearMetrics() {
    this.metrics = [];
  }

  /**
   * 清理观察者
   */
  cleanup() {
    for (const observer of this.observers) {
      observer.disconnect();
    }
    this.observers = [];
  }

  /**
   * 导出性能数据为JSON
   */
  exportAsJSON(): string {
    const report = this.generateReport();
    return JSON.stringify(report, null, 2);
  }
}

// 导出单例
export const performanceMonitor = PerformanceMonitor.getInstance();

/**
 * 性能装饰器 - 自动测量函数性能
 */
export function measurePerformance(name?: string) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;
    const measureName = name || `${target.constructor.name}.${propertyKey}`;

    descriptor.value = function (...args: any[]) {
      return performanceMonitor.measure(measureName, () => {
        return originalMethod.apply(this, args);
      });
    };

    return descriptor;
  };
}

/**
 * 异步性能装饰器
 */
export function measureAsyncPerformance(name?: string) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;
    const measureName = name || `${target.constructor.name}.${propertyKey}`;

    descriptor.value = async function (...args: any[]) {
      return await performanceMonitor.measureAsync(measureName, () => {
        return originalMethod.apply(this, args);
      });
    };

    return descriptor;
  };
}

/**
 * React Hook - 测量组件渲染性能
 */
export function usePerformanceTracking(componentName: string) {
  useEffect(() => {
    performanceMonitor.mark(`${componentName}-render-start`);

    return () => {
      performanceMonitor.mark(`${componentName}-render-end`);
      performanceMonitor.measureBetweenMarks(
        `${componentName}-render`,
        `${componentName}-render-start`,
        `${componentName}-render-end`
      );
    };
  });
}

/**
 * 性能监控 Hook 结构
 */
export interface PerformanceMonitorMetrics {
  memory: {
    used: number;
    limit: number;
  };
  rendering: {
    fps: number;
    averageRenderTime: number;
    longTasks: number;
  };
  storage: {
    size: number;
    operations: number;
  };
}

/**
 * React Hook - 获取性能监控数据
 */
export function usePerformanceMonitor() {
  const [metrics, setMetrics] = useState<PerformanceMonitorMetrics | null>(null);

  const getReport = useCallback(() => {
    const report = performanceMonitor.generateReport();
    return {
      ...report,
      entries: report.metrics,
    };
  }, []);

  useEffect(() => {
    const updateMetrics = () => {
      const memoryUsage = performanceMonitor.getMemoryUsage();
      const report = performanceMonitor.generateReport();
      const longTasks = performanceMonitor.getMetricsByName('long-task');

      // 估算 FPS（基于长任务数量）
      const fps = Math.max(10, 60 - longTasks.length * 5);

      // 估算存储大小
      let storageSize = 0;
      try {
        const storage = localStorage.getItem('tabvault_groups');
        storageSize = storage ? new Blob([storage]).size : 0;
      } catch {
        // 忽略存储访问错误
      }

      setMetrics({
        memory: {
          used: memoryUsage,
          limit: (performance as Performance & { memory?: { jsHeapSizeLimit: number } }).memory?.jsHeapSizeLimit || 1024 * 1024 * 1024,
        },
        rendering: {
          fps,
          averageRenderTime: report.summary.avgRenderTime,
          longTasks: longTasks.length,
        },
        storage: {
          size: storageSize,
          operations: report.metrics.filter(m => m.name.includes('storage')).length,
        },
      });
    };

    // 初始更新
    updateMetrics();

    // 定期更新
    const interval = setInterval(updateMetrics, 2000);

    return () => clearInterval(interval);
  }, []);

  return { metrics, getReport };
}