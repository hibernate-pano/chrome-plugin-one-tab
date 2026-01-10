import React from 'react';

/**
 * 性能监控和分析工具
 * 提供性能指标收集、内存监控、渲染性能追踪等功能
 */

interface PerformanceMetrics {
  memory: {
    used: number;
    total: number;
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
    averageOperationTime: number;
  };
}

interface PerformanceEntry {
  timestamp: number;
  type: 'render' | 'storage' | 'memory' | 'sync';
  duration: number;
  metadata?: Record<string, any>;
}

class PerformanceMonitor {
  private entries: PerformanceEntry[] = [];
  private observers: ((metrics: PerformanceMetrics) => void)[] = [];
  private memoryObserver?: PerformanceObserver;
  private longTaskObserver?: PerformanceObserver;
  private isMonitoring = false;

  startMonitoring() {
    if (this.isMonitoring) return;
    this.isMonitoring = true;

    // 监控内存使用
    if ('memory' in performance) {
      this.memoryObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          this.recordEntry('memory', 0, { memory: entry });
        }
      });
      this.memoryObserver.observe({ entryTypes: ['measure'] });
    }

    // 监控长任务
    if ('PerformanceObserver' in window) {
      this.longTaskObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          this.recordEntry('render', entry.duration, { type: 'long-task' });
        }
      });
      this.longTaskObserver.observe({ entryTypes: ['longtask'] });
    }

    console.log('Performance monitoring started');
  }

  stopMonitoring() {
    if (!this.isMonitoring) return;
    this.isMonitoring = false;

    this.memoryObserver?.disconnect();
    this.longTaskObserver?.disconnect();

    console.log('Performance monitoring stopped');
  }

  /**
   * 记录性能条目
   */
  recordEntry(type: PerformanceEntry['type'], duration: number, metadata?: Record<string, any>) {
    const entry: PerformanceEntry = {
      timestamp: Date.now(),
      type,
      duration,
      metadata,
    };

    this.entries.push(entry);

    // 保持最近1000个条目
    if (this.entries.length > 1000) {
      this.entries = this.entries.slice(-1000);
    }

    // 通知观察者
    this.notifyObservers();
  }

  /**
   * 包装函数以监控其执行时间
   */
  measureFunction<T extends (...args: any[]) => any>(
    fn: T,
    name: string,
    type: PerformanceEntry['type'] = 'render'
  ): T {
    return ((...args: Parameters<T>) => {
      const startTime = performance.now();
      try {
        const result = fn(...args);
        const duration = performance.now() - startTime;
        this.recordEntry(type, duration, { name, success: true });
        return result;
      } catch (error) {
        const duration = performance.now() - startTime;
        this.recordEntry(type, duration, {
          name,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }) as T;
  }

  /**
   * 监控React组件渲染性能
   */
  measureComponent(Component: React.ComponentType<any>, componentName: string) {
    const wrappedComponent = React.memo(Component);
    const measuredComponent = (props: any) => {
      const renderStart = performance.now();

      React.useEffect(() => {
        const renderTime = performance.now() - renderStart;
        this.recordEntry('render', renderTime, {
          component: componentName,
          props: Object.keys(props),
        });
      });

      return React.createElement(wrappedComponent, props);
    };

    measuredComponent.displayName = `Measured(${componentName})`;
    return measuredComponent;
  }

  /**
   * 获取当前性能指标
   */
  getMetrics(): PerformanceMetrics {
    const recentEntries = this.entries.filter(
      entry => Date.now() - entry.timestamp < 60000 // 最近1分钟
    );

    const renderEntries = recentEntries.filter(e => e.type === 'render');
    const storageEntries = recentEntries.filter(e => e.type === 'storage');

    // 计算内存使用
    const memoryInfo = (performance as any).memory;
    const memory = memoryInfo
      ? {
          used: memoryInfo.usedJSHeapSize,
          total: memoryInfo.totalJSHeapSize,
          limit: memoryInfo.jsHeapSizeLimit,
        }
      : { used: 0, total: 0, limit: 0 };

    // 计算渲染性能
    const fps =
      renderEntries.length > 0
        ? 1000 / (renderEntries.reduce((sum, e) => sum + e.duration, 0) / renderEntries.length)
        : 60;
    const averageRenderTime =
      renderEntries.length > 0
        ? renderEntries.reduce((sum, e) => sum + e.duration, 0) / renderEntries.length
        : 0;
    const longTasks = renderEntries.filter(e => e.duration > 50).length; // 超过50ms的任务

    // 计算存储性能
    const size = localStorage.length * 2; // 粗略估算
    const operations = storageEntries.length;
    const averageOperationTime =
      storageEntries.length > 0
        ? storageEntries.reduce((sum, e) => sum + e.duration, 0) / storageEntries.length
        : 0;

    return {
      memory,
      rendering: { fps, averageRenderTime, longTasks },
      storage: { size, operations, averageOperationTime },
    };
  }

  /**
   * 添加性能指标观察者
   */
  addObserver(callback: (metrics: PerformanceMetrics) => void) {
    this.observers.push(callback);
  }

  /**
   * 移除性能指标观察者
   */
  removeObserver(callback: (metrics: PerformanceMetrics) => void) {
    this.observers = this.observers.filter(observer => observer !== callback);
  }

  private notifyObservers() {
    const metrics = this.getMetrics();
    this.observers.forEach(observer => {
      try {
        observer(metrics);
      } catch (error) {
        console.error('Performance observer error:', error);
      }
    });
  }

  /**
   * 获取性能报告
   */
  getReport(): {
    summary: PerformanceMetrics;
    entries: PerformanceEntry[];
    recommendations: string[];
  } {
    const metrics = this.getMetrics();
    const recommendations: string[] = [];

    // 生成优化建议
    if (metrics.memory.used / metrics.memory.limit > 0.8) {
      recommendations.push('内存使用率过高，考虑优化数据结构或实现虚拟化');
    }

    if (metrics.rendering.fps < 30) {
      recommendations.push('渲染性能较低，建议优化组件渲染或使用memo');
    }

    if (metrics.rendering.longTasks > 10) {
      recommendations.push('检测到较多长任务，建议使用代码分割和懒加载');
    }

    if (metrics.storage.averageOperationTime > 100) {
      recommendations.push('存储操作较慢，考虑优化数据结构或使用索引');
    }

    return {
      summary: metrics,
      entries: [...this.entries],
      recommendations,
    };
  }

  /**
   * 清理旧的性能数据
   */
  cleanup(maxAge: number = 3600000) {
    // 默认1小时
    const cutoff = Date.now() - maxAge;
    this.entries = this.entries.filter(entry => entry.timestamp > cutoff);
  }
}

// 导出单例实例
export const performanceMonitor = new PerformanceMonitor();

// React Hook for performance monitoring
export const usePerformanceMonitor = () => {
  const [metrics, setMetrics] = React.useState<PerformanceMetrics | null>(null);

  React.useEffect(() => {
    const updateMetrics = () => {
      setMetrics(performanceMonitor.getMetrics());
    };

    performanceMonitor.addObserver(updateMetrics);
    performanceMonitor.startMonitoring();

    return () => {
      performanceMonitor.removeObserver(updateMetrics);
    };
  }, []);

  return {
    metrics,
    recordEntry: performanceMonitor.recordEntry.bind(performanceMonitor),
    measureFunction: performanceMonitor.measureFunction.bind(performanceMonitor),
    getReport: performanceMonitor.getReport.bind(performanceMonitor),
  };
};
