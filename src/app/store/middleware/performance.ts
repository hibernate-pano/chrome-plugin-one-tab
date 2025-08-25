/**
 * 性能监控中间件
 * 监控Redux action的执行时间和性能指标
 */
import { Middleware, AnyAction } from '@reduxjs/toolkit';
import { logger } from '@/shared/utils/logger';

interface ActionPerformance {
  type: string;
  startTime: number;
  endTime: number;
  duration: number;
  payloadSize?: number;
}

class PerformanceMonitor {
  private actionTimes = new Map<string, number>();
  private performanceHistory: ActionPerformance[] = [];
  private readonly MAX_HISTORY = 100;
  private readonly SLOW_ACTION_THRESHOLD = 100; // 100ms
  private readonly CLEANUP_INTERVAL = 60000; // 1分钟
  private cleanupTimer: NodeJS.Timeout | null = null;

  recordActionStart(_actionType: string, actionId: string): void {
    this.actionTimes.set(actionId, performance.now());
  }

  recordActionEnd(action: any, actionId: string): void {
    const startTime = this.actionTimes.get(actionId);
    if (!startTime) return;

    const endTime = performance.now();
    const duration = endTime - startTime;

    const perfData: ActionPerformance = {
      type: action.type,
      startTime,
      endTime,
      duration,
      payloadSize: this.calculatePayloadSize(action.payload),
    };

    // 记录到历史
    this.performanceHistory.push(perfData);
    if (this.performanceHistory.length > this.MAX_HISTORY) {
      this.performanceHistory.shift();
    }

    // 清理action时间记录
    this.actionTimes.delete(actionId);

    // 报告慢action
    if (duration > this.SLOW_ACTION_THRESHOLD) {
      logger.warn('检测到慢Redux Action', {
        type: action.type,
        duration: `${duration.toFixed(2)}ms`,
        payloadSize: perfData.payloadSize,
        threshold: `${this.SLOW_ACTION_THRESHOLD}ms`,
      });
    }

    // 在开发环境记录性能数据
    if (process.env.NODE_ENV === 'development' && duration > 10) {
      logger.perf('Redux Action性能', {
        type: action.type,
        duration: `${duration.toFixed(2)}ms`,
        payloadSize: perfData.payloadSize,
      });
    }
  }

  private calculatePayloadSize(payload: any): number {
    if (!payload) return 0;
    
    try {
      return JSON.stringify(payload).length;
    } catch {
      return 0;
    }
  }

  getPerformanceStats() {
    if (this.performanceHistory.length === 0) {
      return null;
    }

    const durations = this.performanceHistory.map(p => p.duration);
    const total = durations.reduce((sum, d) => sum + d, 0);
    const avg = total / durations.length;
    const max = Math.max(...durations);
    const min = Math.min(...durations);

    // 按类型分组统计
    const typeStats = new Map<string, { count: number; totalDuration: number; avgDuration: number }>();

    this.performanceHistory.forEach(perf => {
      const existing = typeStats.get(perf.type) || { count: 0, totalDuration: 0, avgDuration: 0 };
      existing.count++;
      existing.totalDuration += perf.duration;
      existing.avgDuration = existing.totalDuration / existing.count;
      typeStats.set(perf.type, existing);
    });

    return {
      totalActions: this.performanceHistory.length,
      averageDuration: avg,
      maxDuration: max,
      minDuration: min,
      slowActionCount: durations.filter(d => d > this.SLOW_ACTION_THRESHOLD).length,
      typeStats: Object.fromEntries(typeStats),
    };
  }

  /**
   * 启动内存清理定时器
   */
  startCleanup(): void {
    if (this.cleanupTimer) return;

    this.cleanupTimer = setInterval(() => {
      this.cleanupMemory();
    }, this.CLEANUP_INTERVAL);

    logger.debug('性能监控内存清理定时器已启动');
  }

  /**
   * 停止内存清理定时器
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      logger.debug('性能监控内存清理定时器已停止');
    }
  }

  /**
   * 清理过期的性能数据和内存
   */
  private cleanupMemory(): void {
    const now = performance.now();
    const maxAge = 5 * 60 * 1000; // 5分钟

    // 清理过期的action时间记录
    const expiredActionIds: string[] = [];
    this.actionTimes.forEach((startTime, actionId) => {
      if (now - startTime > maxAge) {
        expiredActionIds.push(actionId);
      }
    });

    expiredActionIds.forEach(id => {
      this.actionTimes.delete(id);
    });

    // 如果历史记录过多，保留最新的记录
    if (this.performanceHistory.length > this.MAX_HISTORY) {
      const keepCount = Math.floor(this.MAX_HISTORY * 0.8); // 保留80%
      this.performanceHistory = this.performanceHistory.slice(-keepCount);
    }

    if (expiredActionIds.length > 0 || this.performanceHistory.length > this.MAX_HISTORY) {
      logger.debug('性能监控内存清理完成', {
        expiredActions: expiredActionIds.length,
        historySize: this.performanceHistory.length,
        activeActions: this.actionTimes.size,
      });
    }
  }

  /**
   * 销毁监控器，清理所有资源
   */
  destroy(): void {
    this.stopCleanup();
    this.actionTimes.clear();
    this.performanceHistory = [];
    logger.debug('性能监控器已销毁');
  }

  clearHistory(): void {
    this.performanceHistory = [];
    this.actionTimes.clear();
    logger.debug('性能历史已清理');
  }
}

const perfMonitor = new PerformanceMonitor();

// 启动内存清理
if (process.env.NODE_ENV === 'development') {
  perfMonitor.startCleanup();
}

export const performanceMiddleware: Middleware = () => (next) => (action: unknown) => {
  const typedAction = action as AnyAction;
  // 跳过框架内部actions
  if (!typedAction.type || typedAction.type.startsWith('@@')) {
    return next(action);
  }

  const actionId = `${typedAction.type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  // 记录开始时间
  perfMonitor.recordActionStart(typedAction.type, actionId);

  // 执行action
  const result = next(action);

  // 记录结束时间
  perfMonitor.recordActionEnd(typedAction, actionId);

  return result;
};

// 导出性能监控器以供外部使用
export { perfMonitor };

// 开发环境下每30秒输出一次性能统计
let performanceStatsInterval: NodeJS.Timeout | null = null;

if (process.env.NODE_ENV === 'development') {
  performanceStatsInterval = setInterval(() => {
    const stats = perfMonitor.getPerformanceStats();
    if (stats && stats.totalActions > 0) {
      logger.perf('Redux性能统计', {
        period: '30s',
        ...stats,
      });
    }
  }, 30000);
}

// 清理函数，供外部调用
export const cleanupPerformanceMonitoring = () => {
  if (performanceStatsInterval) {
    clearInterval(performanceStatsInterval);
    performanceStatsInterval = null;
    logger.debug('性能监控定时器已清理');
  }
};