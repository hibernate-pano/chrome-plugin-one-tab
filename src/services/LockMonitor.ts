/**
 * 锁状态监控器
 * 提供锁状态的可观测性，包括锁的获取、释放、超时等事件的日志记录和监控
 */

import { distributedLockManager, LockEvent, LockType } from './DistributedLockManager';
import { logger } from '@/shared/utils/logger';

// 锁统计信息
export interface LockStatistics {
  totalAcquisitions: number;
  totalReleases: number;
  totalTimeouts: number;
  totalFailures: number;
  averageHoldTime: number;
  currentLock: any;
  lockTypeStats: Record<LockType, {
    acquisitions: number;
    releases: number;
    failures: number;
    averageHoldTime: number;
  }>;
}

// 锁事件历史记录
export interface LockEventRecord extends LockEvent {
  id: string;
  duration?: number; // 对于释放事件，记录持有时间
}

/**
 * 锁监控器类
 */
export class LockMonitor {
  private static instance: LockMonitor;
  private eventHistory: LockEventRecord[] = [];
  private statistics: LockStatistics;
  private lockAcquisitionTimes = new Map<string, number>();
  private readonly MAX_HISTORY_SIZE = 1000; // 最大历史记录数量

  private constructor() {
    this.statistics = this.initializeStatistics();
    this.setupEventListener();
  }

  /**
   * 获取单例实例
   */
  public static getInstance(): LockMonitor {
    if (!LockMonitor.instance) {
      LockMonitor.instance = new LockMonitor();
    }
    return LockMonitor.instance;
  }

  /**
   * 初始化统计信息
   */
  private initializeStatistics(): LockStatistics {
    return {
      totalAcquisitions: 0,
      totalReleases: 0,
      totalTimeouts: 0,
      totalFailures: 0,
      averageHoldTime: 0,
      currentLock: null,
      lockTypeStats: {
        [LockType.USER_OPERATION]: {
          acquisitions: 0,
          releases: 0,
          failures: 0,
          averageHoldTime: 0
        },
        [LockType.MANUAL_SYNC]: {
          acquisitions: 0,
          releases: 0,
          failures: 0,
          averageHoldTime: 0
        },
        [LockType.PERIODIC_SYNC]: {
          acquisitions: 0,
          releases: 0,
          failures: 0,
          averageHoldTime: 0
        }
      }
    };
  }

  /**
   * 设置事件监听器
   */
  private setupEventListener(): void {
    distributedLockManager.addEventListener((event: LockEvent) => {
      this.handleLockEvent(event);
    });
  }

  /**
   * 处理锁事件
   */
  private handleLockEvent(event: LockEvent): void {
    const eventRecord: LockEventRecord = {
      ...event,
      id: `event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    };

    // 记录事件到历史
    this.addEventToHistory(eventRecord);

    // 更新统计信息
    this.updateStatistics(event);

    // 记录日志
    this.logEvent(event);
  }

  /**
   * 添加事件到历史记录
   */
  private addEventToHistory(eventRecord: LockEventRecord): void {
    this.eventHistory.push(eventRecord);

    // 限制历史记录大小
    if (this.eventHistory.length > this.MAX_HISTORY_SIZE) {
      this.eventHistory = this.eventHistory.slice(-this.MAX_HISTORY_SIZE);
    }
  }

  /**
   * 更新统计信息
   */
  private updateStatistics(event: LockEvent): void {
    const typeStats = this.statistics.lockTypeStats[event.lockType];

    switch (event.type) {
      case 'acquired':
        this.statistics.totalAcquisitions++;
        typeStats.acquisitions++;
        this.lockAcquisitionTimes.set(event.lockId, event.timestamp);
        this.statistics.currentLock = distributedLockManager.getLockStatus();
        break;

      case 'released':
        this.statistics.totalReleases++;
        typeStats.releases++;
        
        // 计算持有时间
        const acquisitionTime = this.lockAcquisitionTimes.get(event.lockId);
        if (acquisitionTime) {
          const holdTime = event.timestamp - acquisitionTime;
          this.updateAverageHoldTime(event.lockType, holdTime);
          this.lockAcquisitionTimes.delete(event.lockId);
          
          // 更新事件记录中的持有时间
          const eventRecord = this.eventHistory[this.eventHistory.length - 1];
          if (eventRecord && eventRecord.lockId === event.lockId) {
            eventRecord.duration = holdTime;
          }
        }
        
        this.statistics.currentLock = distributedLockManager.getLockStatus();
        break;

      case 'expired':
        this.statistics.totalTimeouts++;
        this.lockAcquisitionTimes.delete(event.lockId);
        this.statistics.currentLock = distributedLockManager.getLockStatus();
        break;

      case 'failed':
        this.statistics.totalFailures++;
        typeStats.failures++;
        break;
    }
  }

  /**
   * 更新平均持有时间
   */
  private updateAverageHoldTime(lockType: LockType, holdTime: number): void {
    const typeStats = this.statistics.lockTypeStats[lockType];
    const totalReleases = typeStats.releases;
    
    if (totalReleases === 1) {
      typeStats.averageHoldTime = holdTime;
    } else {
      typeStats.averageHoldTime = 
        (typeStats.averageHoldTime * (totalReleases - 1) + holdTime) / totalReleases;
    }

    // 更新全局平均持有时间
    const globalTotalReleases = this.statistics.totalReleases;
    if (globalTotalReleases === 1) {
      this.statistics.averageHoldTime = holdTime;
    } else {
      this.statistics.averageHoldTime = 
        (this.statistics.averageHoldTime * (globalTotalReleases - 1) + holdTime) / globalTotalReleases;
    }
  }

  /**
   * 记录事件日志
   */
  private logEvent(event: LockEvent): void {
    const logContext = {
      lockId: event.lockId,
      lockType: event.lockType,
      timestamp: new Date(event.timestamp).toISOString(),
      details: event.details
    };

    switch (event.type) {
      case 'acquired':
        logger.info(`🔒 锁已获取: ${event.lockType}`, logContext);
        break;
      case 'released':
        logger.info(`🔓 锁已释放: ${event.lockType}`, logContext);
        break;
      case 'expired':
        logger.warn(`⏰ 锁已过期: ${event.lockType}`, logContext);
        break;
      case 'failed':
        logger.error(`❌ 锁获取失败: ${event.lockType}`, logContext);
        break;
      case 'waiting':
        logger.info(`⏳ 等待锁: ${event.lockType}`, logContext);
        break;
    }
  }

  /**
   * 获取统计信息
   */
  public getStatistics(): LockStatistics {
    return { ...this.statistics };
  }

  /**
   * 获取事件历史
   */
  public getEventHistory(limit?: number): LockEventRecord[] {
    if (limit) {
      return this.eventHistory.slice(-limit);
    }
    return [...this.eventHistory];
  }

  /**
   * 获取特定类型的事件历史
   */
  public getEventHistoryByType(eventType: LockEvent['type'], limit?: number): LockEventRecord[] {
    const filteredEvents = this.eventHistory.filter(event => event.type === eventType);
    if (limit) {
      return filteredEvents.slice(-limit);
    }
    return filteredEvents;
  }

  /**
   * 获取特定锁类型的事件历史
   */
  public getEventHistoryByLockType(lockType: LockType, limit?: number): LockEventRecord[] {
    const filteredEvents = this.eventHistory.filter(event => event.lockType === lockType);
    if (limit) {
      return filteredEvents.slice(-limit);
    }
    return filteredEvents;
  }

  /**
   * 清理历史记录
   */
  public clearHistory(): void {
    this.eventHistory = [];
    logger.info('🧹 锁监控历史记录已清理');
  }

  /**
   * 重置统计信息
   */
  public resetStatistics(): void {
    this.statistics = this.initializeStatistics();
    this.lockAcquisitionTimes.clear();
    logger.info('🔄 锁监控统计信息已重置');
  }

  /**
   * 生成监控报告
   */
  public generateReport(): string {
    const stats = this.getStatistics();
    const recentEvents = this.getEventHistory(10);

    return `
=== 锁监控报告 ===
总获取次数: ${stats.totalAcquisitions}
总释放次数: ${stats.totalReleases}
总超时次数: ${stats.totalTimeouts}
总失败次数: ${stats.totalFailures}
平均持有时间: ${stats.averageHoldTime.toFixed(2)}ms
当前锁状态: ${stats.currentLock ? `${stats.currentLock.type} (${stats.currentLock.operationId})` : '无'}

=== 按锁类型统计 ===
${Object.entries(stats.lockTypeStats).map(([type, typeStats]) => 
  `${type}: 获取${typeStats.acquisitions}次, 释放${typeStats.releases}次, 失败${typeStats.failures}次, 平均持有${typeStats.averageHoldTime.toFixed(2)}ms`
).join('\n')}

=== 最近事件 ===
${recentEvents.map(event => 
  `${new Date(event.timestamp).toLocaleTimeString()} - ${event.type}: ${event.lockType} (${event.lockId})`
).join('\n')}
`;
  }
}

// 导出单例实例
export const lockMonitor = LockMonitor.getInstance();
