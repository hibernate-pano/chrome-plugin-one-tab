/**
 * 智能防抖器
 * 根据事件类型和频率动态调整防抖延迟
 */

import { logger } from './logger';

/**
 * 防抖配置接口
 */
export interface DebounceConfig {
  // 默认延迟（毫秒）
  defaultDelay: number;
  
  // 最小延迟（毫秒）
  minDelay: number;
  
  // 最大延迟（毫秒）
  maxDelay: number;
  
  // 是否启用自适应延迟
  enableAdaptiveDelay: boolean;
  
  // 高频事件的延迟倍数
  highFrequencyMultiplier: number;
  
  // 低频事件的延迟倍数
  lowFrequencyMultiplier: number;
}

/**
 * 事件统计信息
 */
interface EventStats {
  count: number;
  lastEventTime: number;
  averageInterval: number;
  recentEvents: number[];
}

/**
 * 防抖任务
 */
interface DebounceTask {
  id: string;
  callback: () => Promise<void> | void;
  delay: number;
  timer: NodeJS.Timeout;
  createdAt: number;
  eventType: string;
}

/**
 * 智能防抖器类
 */
export class SmartDebouncer {
  private config: DebounceConfig;
  private eventStats = new Map<string, EventStats>();
  private activeTasks = new Map<string, DebounceTask>();
  private readonly STATS_WINDOW = 60000; // 1分钟统计窗口
  private readonly HIGH_FREQUENCY_THRESHOLD = 5; // 1分钟内超过5次认为是高频
  private readonly LOW_FREQUENCY_THRESHOLD = 1; // 1分钟内少于1次认为是低频

  constructor(config: Partial<DebounceConfig> = {}) {
    this.config = {
      defaultDelay: 500,
      minDelay: 100,
      maxDelay: 5000,
      enableAdaptiveDelay: true,
      highFrequencyMultiplier: 1.5,
      lowFrequencyMultiplier: 0.7,
      ...config
    };

    logger.debug('智能防抖器已初始化', this.config);
  }

  /**
   * 防抖执行函数
   */
  debounce(
    key: string,
    callback: () => Promise<void> | void,
    eventType: string = 'default',
    customDelay?: number
  ): void {
    // 取消之前的任务
    this.cancelTask(key);

    // 更新事件统计
    this.updateEventStats(eventType);

    // 计算延迟
    const delay = customDelay || this.calculateDelay(eventType);

    // 创建新任务
    const task: DebounceTask = {
      id: key,
      callback,
      delay,
      timer: setTimeout(async () => {
        try {
          logger.debug(`执行防抖任务: ${key}`, { eventType, delay });
          await callback();
          this.activeTasks.delete(key);
        } catch (error) {
          logger.error(`防抖任务执行失败: ${key}`, error);
          this.activeTasks.delete(key);
        }
      }, delay),
      createdAt: Date.now(),
      eventType
    };

    this.activeTasks.set(key, task);

    logger.debug(`创建防抖任务: ${key}`, {
      eventType,
      delay,
      activeTasksCount: this.activeTasks.size
    });
  }

  /**
   * 立即执行并取消防抖
   */
  async flush(key: string): Promise<void> {
    const task = this.activeTasks.get(key);
    if (task) {
      clearTimeout(task.timer);
      this.activeTasks.delete(key);
      
      try {
        logger.debug(`立即执行防抖任务: ${key}`);
        await task.callback();
      } catch (error) {
        logger.error(`立即执行防抖任务失败: ${key}`, error);
      }
    }
  }

  /**
   * 取消防抖任务
   */
  cancel(key: string): void {
    this.cancelTask(key);
  }

  /**
   * 取消所有防抖任务
   */
  cancelAll(): void {
    for (const [key] of this.activeTasks) {
      this.cancelTask(key);
    }
    logger.debug('已取消所有防抖任务');
  }

  /**
   * 检查是否有待执行的任务
   */
  hasPendingTask(key: string): boolean {
    return this.activeTasks.has(key);
  }

  /**
   * 获取待执行任务数量
   */
  getPendingTaskCount(): number {
    return this.activeTasks.size;
  }

  /**
   * 更新配置
   */
  updateConfig(newConfig: Partial<DebounceConfig>): void {
    this.config = { ...this.config, ...newConfig };
    logger.debug('防抖器配置已更新', this.config);
  }

  /**
   * 获取事件统计信息
   */
  getEventStats(): Map<string, EventStats> {
    // 清理过期统计
    this.cleanupOldStats();
    return new Map(this.eventStats);
  }

  /**
   * 清除统计信息
   */
  clearStats(): void {
    this.eventStats.clear();
    logger.debug('防抖器统计信息已清除');
  }

  /**
   * 私有方法：取消任务
   */
  private cancelTask(key: string): void {
    const task = this.activeTasks.get(key);
    if (task) {
      clearTimeout(task.timer);
      this.activeTasks.delete(key);
      logger.debug(`取消防抖任务: ${key}`);
    }
  }

  /**
   * 私有方法：更新事件统计
   */
  private updateEventStats(eventType: string): void {
    const now = Date.now();
    const stats = this.eventStats.get(eventType) || {
      count: 0,
      lastEventTime: 0,
      averageInterval: 0,
      recentEvents: []
    };

    // 更新统计信息
    stats.count++;
    stats.recentEvents.push(now);
    
    // 只保留统计窗口内的事件
    stats.recentEvents = stats.recentEvents.filter(
      time => now - time <= this.STATS_WINDOW
    );

    // 计算平均间隔
    if (stats.recentEvents.length > 1) {
      const intervals = [];
      for (let i = 1; i < stats.recentEvents.length; i++) {
        intervals.push(stats.recentEvents[i] - stats.recentEvents[i - 1]);
      }
      stats.averageInterval = intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length;
    }

    stats.lastEventTime = now;
    this.eventStats.set(eventType, stats);
  }

  /**
   * 私有方法：计算延迟
   */
  private calculateDelay(eventType: string): number {
    if (!this.config.enableAdaptiveDelay) {
      return this.config.defaultDelay;
    }

    const stats = this.eventStats.get(eventType);
    if (!stats || stats.recentEvents.length < 2) {
      return this.config.defaultDelay;
    }

    const recentEventCount = stats.recentEvents.length;
    let multiplier = 1;

    // 根据事件频率调整延迟
    if (recentEventCount > this.HIGH_FREQUENCY_THRESHOLD) {
      // 高频事件，增加延迟
      multiplier = this.config.highFrequencyMultiplier;
      logger.debug(`检测到高频事件: ${eventType}`, { 
        count: recentEventCount, 
        multiplier 
      });
    } else if (recentEventCount < this.LOW_FREQUENCY_THRESHOLD) {
      // 低频事件，减少延迟
      multiplier = this.config.lowFrequencyMultiplier;
      logger.debug(`检测到低频事件: ${eventType}`, { 
        count: recentEventCount, 
        multiplier 
      });
    }

    const calculatedDelay = Math.round(this.config.defaultDelay * multiplier);
    
    // 确保延迟在合理范围内
    return Math.max(
      this.config.minDelay,
      Math.min(this.config.maxDelay, calculatedDelay)
    );
  }

  /**
   * 私有方法：清理过期统计
   */
  private cleanupOldStats(): void {
    const now = Date.now();
    
    for (const [eventType, stats] of this.eventStats.entries()) {
      // 清理过期事件
      stats.recentEvents = stats.recentEvents.filter(
        time => now - time <= this.STATS_WINDOW
      );

      // 如果没有最近事件，删除统计
      if (stats.recentEvents.length === 0 && 
          now - stats.lastEventTime > this.STATS_WINDOW * 2) {
        this.eventStats.delete(eventType);
      }
    }
  }

  /**
   * 获取调试信息
   */
  getDebugInfo(): {
    config: DebounceConfig;
    activeTasksCount: number;
    eventTypesCount: number;
    totalEvents: number;
  } {
    this.cleanupOldStats();
    
    const totalEvents = Array.from(this.eventStats.values())
      .reduce((sum, stats) => sum + stats.count, 0);

    return {
      config: this.config,
      activeTasksCount: this.activeTasks.size,
      eventTypesCount: this.eventStats.size,
      totalEvents
    };
  }
}

/**
 * 预设配置
 */
export const DEBOUNCE_PRESETS = {
  // 实时同步配置
  REALTIME_SYNC: {
    defaultDelay: 500,
    minDelay: 200,
    maxDelay: 2000,
    enableAdaptiveDelay: true,
    highFrequencyMultiplier: 1.8,
    lowFrequencyMultiplier: 0.6
  },

  // 用户输入配置
  USER_INPUT: {
    defaultDelay: 300,
    minDelay: 100,
    maxDelay: 1000,
    enableAdaptiveDelay: true,
    highFrequencyMultiplier: 1.5,
    lowFrequencyMultiplier: 0.8
  },

  // 网络请求配置
  NETWORK_REQUEST: {
    defaultDelay: 1000,
    minDelay: 500,
    maxDelay: 5000,
    enableAdaptiveDelay: true,
    highFrequencyMultiplier: 2.0,
    lowFrequencyMultiplier: 0.5
  }
} as const;

/**
 * 创建预设防抖器
 */
export function createRealtimeSyncDebouncer(): SmartDebouncer {
  return new SmartDebouncer(DEBOUNCE_PRESETS.REALTIME_SYNC);
}

export function createUserInputDebouncer(): SmartDebouncer {
  return new SmartDebouncer(DEBOUNCE_PRESETS.USER_INPUT);
}

export function createNetworkRequestDebouncer(): SmartDebouncer {
  return new SmartDebouncer(DEBOUNCE_PRESETS.NETWORK_REQUEST);
}
