/**
 * 原子操作包装器
 * 将所有同步操作包装为原子操作，确保pull-process-push流程的完整性
 */

import { distributedLockManager, LockType, LockAcquisitionResult } from './DistributedLockManager';
import { logger } from '@/shared/utils/logger';
import { TabGroup } from '@/types/tab';

// 原子操作结果接口
export interface AtomicOperationResult<T = any> {
  success: boolean;
  result?: T;
  error?: string;
  lockId?: string;
  duration?: number;
  operationId: string;
}

// 原子操作配置
export interface AtomicOperationConfig {
  type: LockType;
  operationId: string;
  description?: string;
  timeout?: number;
  retryOnLockFailure?: boolean;
  maxRetries?: number;
}

// 操作函数类型定义
export type SyncOperation<T> = () => Promise<T>;
export type DataOperation<T> = (data: TabGroup[]) => Promise<{ success: boolean; updatedData: TabGroup[]; result: T }>;

/**
 * 原子操作包装器类
 */
export class AtomicOperationWrapper {
  private static instance: AtomicOperationWrapper;
  private readonly DEFAULT_TIMEOUT = 30000; // 30秒
  private readonly DEFAULT_MAX_RETRIES = 3;

  private constructor() {}

  /**
   * 获取单例实例
   */
  public static getInstance(): AtomicOperationWrapper {
    if (!AtomicOperationWrapper.instance) {
      AtomicOperationWrapper.instance = new AtomicOperationWrapper();
    }
    return AtomicOperationWrapper.instance;
  }

  /**
   * 执行原子同步操作
   * 适用于简单的同步操作（如手动同步、定时同步）
   */
  public async executeAtomicSync<T>(
    operation: SyncOperation<T>,
    config: AtomicOperationConfig
  ): Promise<AtomicOperationResult<T>> {
    const startTime = Date.now();
    let lockId: string | undefined;

    try {
      logger.info(`🔄 开始原子同步操作: ${config.description || config.operationId}`, {
        type: config.type,
        operationId: config.operationId
      });

      // 获取锁
      const lockResult = await this.acquireLockWithRetry(config);
      if (!lockResult.success) {
        return {
          success: false,
          error: lockResult.error || '获取锁失败',
          operationId: config.operationId,
          duration: Date.now() - startTime
        };
      }

      lockId = lockResult.lockId!;

      // 执行操作
      const result = await operation();

      logger.info(`✅ 原子同步操作完成: ${config.description || config.operationId}`, {
        operationId: config.operationId,
        duration: Date.now() - startTime
      });

      return {
        success: true,
        result,
        lockId,
        operationId: config.operationId,
        duration: Date.now() - startTime
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      logger.error(`❌ 原子同步操作失败: ${errorMessage}`, {
        operationId: config.operationId,
        error,
        duration: Date.now() - startTime
      });

      return {
        success: false,
        error: errorMessage,
        lockId,
        operationId: config.operationId,
        duration: Date.now() - startTime
      };

    } finally {
      // 释放锁
      if (lockId) {
        distributedLockManager.releaseLock(lockId);
      }
    }
  }

  /**
   * 执行原子数据操作
   * 适用于需要pull-process-push流程的复杂操作（如保存、删除、更新）
   */
  public async executeAtomicDataOperation<T>(
    pullOperation: () => Promise<TabGroup[]>,
    processOperation: DataOperation<T>,
    pushOperation: (data: TabGroup[]) => Promise<void>,
    config: AtomicOperationConfig
  ): Promise<AtomicOperationResult<T>> {
    const startTime = Date.now();
    let lockId: string | undefined;

    try {
      logger.info(`🔄 开始原子数据操作: ${config.description || config.operationId}`, {
        type: config.type,
        operationId: config.operationId
      });

      // 获取锁
      const lockResult = await this.acquireLockWithRetry(config);
      if (!lockResult.success) {
        return {
          success: false,
          error: lockResult.error || '获取锁失败',
          operationId: config.operationId,
          duration: Date.now() - startTime
        };
      }

      lockId = lockResult.lockId!;

      // Step 1: Pull - 拉取最新数据
      logger.info(`📥 Step 1: 拉取最新数据 (${config.operationId})`);
      const latestData = await pullOperation();

      // Step 2: Process - 处理数据
      logger.info(`⚙️ Step 2: 处理数据 (${config.operationId})`);
      const processResult = await processOperation(latestData);

      if (!processResult.success) {
        return {
          success: false,
          error: '数据处理失败',
          lockId,
          operationId: config.operationId,
          duration: Date.now() - startTime
        };
      }

      // Step 3: Push - 推送数据
      logger.info(`🚀 Step 3: 推送数据 (${config.operationId})`);
      await pushOperation(processResult.updatedData);

      logger.info(`✅ 原子数据操作完成: ${config.description || config.operationId}`, {
        operationId: config.operationId,
        duration: Date.now() - startTime
      });

      return {
        success: true,
        result: processResult.result,
        lockId,
        operationId: config.operationId,
        duration: Date.now() - startTime
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      logger.error(`❌ 原子数据操作失败: ${errorMessage}`, {
        operationId: config.operationId,
        error,
        duration: Date.now() - startTime
      });

      return {
        success: false,
        error: errorMessage,
        lockId,
        operationId: config.operationId,
        duration: Date.now() - startTime
      };

    } finally {
      // 释放锁
      if (lockId) {
        distributedLockManager.releaseLock(lockId);
      }
    }
  }

  /**
   * 带重试的锁获取
   */
  private async acquireLockWithRetry(config: AtomicOperationConfig): Promise<LockAcquisitionResult> {
    const maxRetries = config.retryOnLockFailure ? (config.maxRetries || this.DEFAULT_MAX_RETRIES) : 1;
    const timeout = config.timeout || this.DEFAULT_TIMEOUT;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      logger.info(`🔒 尝试获取锁 (第${attempt}/${maxRetries}次): ${config.operationId}`, {
        type: config.type,
        timeout
      });

      const result = await distributedLockManager.acquireLock(
        config.type,
        config.operationId,
        config.description,
        timeout
      );

      if (result.success) {
        logger.info(`🔒 锁获取成功: ${config.operationId}`, {
          lockId: result.lockId,
          attempt,
          waitTime: result.waitTime
        });
        return result;
      }

      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // 指数退避，最大5秒
        logger.warn(`🔒 锁获取失败，${delay}ms后重试: ${result.error}`, {
          operationId: config.operationId,
          attempt,
          delay
        });
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        logger.error(`🔒 锁获取最终失败: ${result.error}`, {
          operationId: config.operationId,
          totalAttempts: maxRetries
        });
      }
    }

    return {
      success: false,
      error: `经过${maxRetries}次尝试后仍无法获取锁`
    };
  }

  /**
   * 生成操作ID
   */
  public generateOperationId(prefix: string = 'op'): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 检查是否有活跃的锁
   */
  public hasActiveLock(): boolean {
    const lockStatus = distributedLockManager.getLockStatus();
    return lockStatus !== null;
  }

  /**
   * 获取当前锁状态
   */
  public getCurrentLockStatus() {
    return distributedLockManager.getLockStatus();
  }
}

// 导出单例实例
export const atomicOperationWrapper = AtomicOperationWrapper.getInstance();
