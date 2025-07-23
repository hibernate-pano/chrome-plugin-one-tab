/**
 * 分布式锁管理器
 * 实现基于localStorage的分布式锁机制，确保同步操作的原子性
 */

import { logger } from '@/shared/utils/logger';

// 锁类型和优先级定义
export enum LockType {
  USER_OPERATION = 'user_operation',     // 优先级最高：用户主动操作
  MANUAL_SYNC = 'manual_sync',           // 优先级中等：手动同步
  PERIODIC_SYNC = 'periodic_sync'        // 优先级最低：定时同步
}

// 锁优先级映射
const LOCK_PRIORITY: Record<LockType, number> = {
  [LockType.USER_OPERATION]: 100,
  [LockType.MANUAL_SYNC]: 50,
  [LockType.PERIODIC_SYNC]: 10
};

// 锁信息接口
export interface LockInfo {
  id: string;
  type: LockType;
  priority: number;
  acquiredAt: number;
  expiresAt: number;
  operationId: string;
  description?: string;
}

// 锁获取结果
export interface LockAcquisitionResult {
  success: boolean;
  lockId?: string;
  error?: string;
  waitTime?: number;
}

// 锁状态监控事件
export interface LockEvent {
  type: 'acquired' | 'released' | 'expired' | 'failed' | 'waiting';
  lockId: string;
  lockType: LockType;
  timestamp: number;
  details?: any;
}

/**
 * 分布式锁管理器类
 */
export class DistributedLockManager {
  private static instance: DistributedLockManager;
  private readonly LOCK_KEY = 'onetabplus_sync_lock';
  private readonly DEFAULT_TIMEOUT = 30000; // 30秒默认超时
  private readonly MAX_WAIT_TIME = 60000; // 最大等待时间60秒
  private readonly CLEANUP_INTERVAL = 5000; // 清理间隔5秒

  private cleanupTimer: NodeJS.Timeout | null = null;
  private eventListeners: ((event: LockEvent) => void)[] = [];

  private constructor() {
    this.startCleanupTimer();
  }

  /**
   * 获取单例实例
   */
  public static getInstance(): DistributedLockManager {
    if (!DistributedLockManager.instance) {
      DistributedLockManager.instance = new DistributedLockManager();
    }
    return DistributedLockManager.instance;
  }

  /**
   * 获取锁
   */
  public async acquireLock(
    type: LockType,
    operationId: string,
    description?: string,
    timeout: number = this.DEFAULT_TIMEOUT
  ): Promise<LockAcquisitionResult> {
    const lockId = this.generateLockId();
    const priority = LOCK_PRIORITY[type];
    const startTime = Date.now();

    logger.info(`🔒 尝试获取锁: ${type}`, {
      lockId,
      operationId,
      description,
      priority,
      timeout
    });

    try {
      // 检查是否可以立即获取锁
      const immediateResult = this.tryAcquireImmediate(lockId, type, priority, operationId, description, timeout);
      if (immediateResult.success) {
        this.emitEvent({
          type: 'acquired',
          lockId,
          lockType: type,
          timestamp: Date.now(),
          details: { operationId, description, immediate: true }
        });
        return immediateResult;
      }

      // 如果不能立即获取，根据优先级决定是否等待
      const currentLock = this.getCurrentLock();
      if (currentLock && priority <= currentLock.priority) {
        // 优先级不够，直接失败
        const error = `锁被更高优先级操作占用: ${currentLock.type}`;
        logger.warn(`🔒 获取锁失败: ${error}`, { lockId, currentLock });

        this.emitEvent({
          type: 'failed',
          lockId,
          lockType: type,
          timestamp: Date.now(),
          details: { error, currentLock }
        });

        return { success: false, error };
      }

      // 高优先级操作，等待当前锁释放
      return await this.waitForLock(lockId, type, priority, operationId, description, timeout, startTime);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      logger.error(`🔒 获取锁异常: ${errorMessage}`, { lockId, type, operationId });

      this.emitEvent({
        type: 'failed',
        lockId,
        lockType: type,
        timestamp: Date.now(),
        details: { error: errorMessage }
      });

      return { success: false, error: errorMessage };
    }
  }

  /**
   * 释放锁
   */
  public releaseLock(lockId: string): boolean {
    try {
      const currentLock = this.getCurrentLock();

      if (!currentLock || currentLock.id !== lockId) {
        logger.warn(`🔒 尝试释放不存在或不匹配的锁: ${lockId}`, { currentLock });
        return false;
      }

      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem(this.LOCK_KEY);
        }
      } catch (error) {
        logger.error('🔒 移除锁信息失败:', error);
      }

      logger.info(`🔓 锁已释放: ${lockId}`, {
        type: currentLock.type,
        operationId: currentLock.operationId,
        duration: Date.now() - currentLock.acquiredAt
      });

      this.emitEvent({
        type: 'released',
        lockId,
        lockType: currentLock.type,
        timestamp: Date.now(),
        details: {
          operationId: currentLock.operationId,
          duration: Date.now() - currentLock.acquiredAt
        }
      });

      return true;
    } catch (error) {
      logger.error(`🔒 释放锁异常: ${error}`, { lockId });
      return false;
    }
  }

  /**
   * 检查锁状态
   */
  public getLockStatus(): LockInfo | null {
    return this.getCurrentLock();
  }

  /**
   * 添加事件监听器
   */
  public addEventListener(listener: (event: LockEvent) => void): void {
    this.eventListeners.push(listener);
  }

  /**
   * 移除事件监听器
   */
  public removeEventListener(listener: (event: LockEvent) => void): void {
    const index = this.eventListeners.indexOf(listener);
    if (index > -1) {
      this.eventListeners.splice(index, 1);
    }
  }

  /**
   * 尝试立即获取锁
   */
  private tryAcquireImmediate(
    lockId: string,
    type: LockType,
    priority: number,
    operationId: string,
    description?: string,
    timeout: number = this.DEFAULT_TIMEOUT
  ): LockAcquisitionResult {
    const currentLock = this.getCurrentLock();

    // 如果没有锁或锁已过期，直接获取
    if (!currentLock || this.isLockExpired(currentLock)) {
      if (currentLock && this.isLockExpired(currentLock)) {
        logger.info(`🔒 清理过期锁: ${currentLock.id}`, { currentLock });
        this.emitEvent({
          type: 'expired',
          lockId: currentLock.id,
          lockType: currentLock.type,
          timestamp: Date.now(),
          details: { reason: 'expired_during_acquire' }
        });
      }

      const lockInfo: LockInfo = {
        id: lockId,
        type,
        priority,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + timeout,
        operationId,
        description
      };

      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(this.LOCK_KEY, JSON.stringify(lockInfo));
        } else {
          logger.warn('🔒 localStorage不可用，锁机制降级');
          return { success: false, error: 'localStorage不可用' };
        }
      } catch (error) {
        logger.error('🔒 保存锁信息失败:', error);
        return { success: false, error: '保存锁信息失败' };
      }

      return { success: true, lockId };
    }

    return { success: false, error: '锁被占用' };
  }

  /**
   * 等待锁释放
   */
  private async waitForLock(
    lockId: string,
    type: LockType,
    priority: number,
    operationId: string,
    description: string | undefined,
    timeout: number,
    startTime: number
  ): Promise<LockAcquisitionResult> {
    const maxWaitTime = Math.min(this.MAX_WAIT_TIME, timeout);
    const pollInterval = 100; // 100ms轮询间隔

    this.emitEvent({
      type: 'waiting',
      lockId,
      lockType: type,
      timestamp: Date.now(),
      details: { operationId, maxWaitTime }
    });

    return new Promise((resolve) => {
      const checkLock = () => {
        const elapsed = Date.now() - startTime;

        if (elapsed >= maxWaitTime) {
          resolve({
            success: false,
            error: '等待锁超时',
            waitTime: elapsed
          });
          return;
        }

        const result = this.tryAcquireImmediate(lockId, type, priority, operationId, description, timeout);
        if (result.success) {
          this.emitEvent({
            type: 'acquired',
            lockId,
            lockType: type,
            timestamp: Date.now(),
            details: {
              operationId,
              description,
              waitTime: elapsed,
              immediate: false
            }
          });
          resolve({ ...result, waitTime: elapsed });
        } else {
          setTimeout(checkLock, pollInterval);
        }
      };

      checkLock();
    });
  }

  /**
   * 获取当前锁信息
   */
  private getCurrentLock(): LockInfo | null {
    try {
      // 检查localStorage是否可用
      if (typeof localStorage === 'undefined') {
        logger.warn('🔒 localStorage不可用，使用内存存储');
        return null;
      }

      const lockData = localStorage.getItem(this.LOCK_KEY);
      if (!lockData) return null;

      return JSON.parse(lockData) as LockInfo;
    } catch (error) {
      logger.error('🔒 解析锁信息失败:', error);
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem(this.LOCK_KEY);
        }
      } catch (removeError) {
        logger.error('🔒 清理锁信息失败:', removeError);
      }
      return null;
    }
  }

  /**
   * 检查锁是否过期
   */
  private isLockExpired(lock: LockInfo): boolean {
    return Date.now() > lock.expiresAt;
  }

  /**
   * 生成锁ID
   */
  private generateLockId(): string {
    return `lock_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 发送事件
   */
  private emitEvent(event: LockEvent): void {
    this.eventListeners.forEach(listener => {
      try {
        listener(event);
      } catch (error) {
        logger.error('🔒 事件监听器异常:', error);
      }
    });
  }

  /**
   * 启动清理定时器
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredLocks();
    }, this.CLEANUP_INTERVAL);
  }

  /**
   * 清理过期锁
   */
  private cleanupExpiredLocks(): void {
    const currentLock = this.getCurrentLock();
    if (currentLock && this.isLockExpired(currentLock)) {
      logger.info(`🔒 清理过期锁: ${currentLock.id}`, { currentLock });
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem(this.LOCK_KEY);
        }
      } catch (error) {
        logger.error('🔒 清理过期锁失败:', error);
      }

      this.emitEvent({
        type: 'expired',
        lockId: currentLock.id,
        lockType: currentLock.type,
        timestamp: Date.now(),
        details: { reason: 'cleanup' }
      });
    }
  }

  /**
   * 销毁管理器
   */
  public destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.eventListeners = [];
  }
}

// 导出单例实例
export const distributedLockManager = DistributedLockManager.getInstance();
