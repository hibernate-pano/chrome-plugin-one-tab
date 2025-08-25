/**
 * 同步协调器
 * 确保多浏览器环境下的数据一致性，防止操作被覆盖
 */

import { TabGroup } from '@/shared/types/tab';
import { storage } from '@/shared/utils/storage';
import { logger } from '@/shared/utils/logger';
import { optimisticSyncService } from './optimisticSyncService';
import { atomicOperationWrapper } from './AtomicOperationWrapper';
import { LockType } from './DistributedLockManager';

interface PendingOperation {
  id: string;
  type: 'deduplication' | 'delete' | 'update' | 'create';
  timestamp: number;
  groupIds: string[];
  expectedVersions: Map<string, number>;
}

export class SyncCoordinator {
  private pendingOperations = new Map<string, PendingOperation>();
  private operationTimeout = 10000; // 10秒超时

  /**
   * 注册用户操作，防止被其他设备覆盖
   */
  async registerOperation(
    type: PendingOperation['type'],
    groupIds: string[],
    operationId?: string
  ): Promise<string> {
    const id = operationId || this.generateOperationId();

    // 获取当前版本号
    const groups = await storage.getGroups();
    const expectedVersions = new Map<string, number>();

    groupIds.forEach(groupId => {
      const group = groups.find(g => g.id === groupId);
      if (group) {
        expectedVersions.set(groupId, group.version || 1);
      }
    });

    const operation: PendingOperation = {
      id,
      type,
      timestamp: Date.now(),
      groupIds,
      expectedVersions
    };

    this.pendingOperations.set(id, operation);

    // 设置超时清理
    setTimeout(() => {
      this.pendingOperations.delete(id);
    }, this.operationTimeout);

    logger.info(`📝 注册用户操作: ${type}`, { operationId: id, groupIds });
    return id;
  }

  /**
   * 完成操作，移除保护
   */
  completeOperation(operationId: string): void {
    this.pendingOperations.delete(operationId);
    logger.info(`✅ 完成用户操作: ${operationId}`);
  }

  /**
   * 检查是否有冲突的待处理操作
   */
  hasConflictingOperation(groupIds: string[]): boolean {
    for (const operation of this.pendingOperations.values()) {
      // 检查是否有重叠的标签组
      const hasOverlap = operation.groupIds.some(id => groupIds.includes(id));
      if (hasOverlap) {
        logger.warn(`⚠️ 检测到冲突操作: ${operation.type}`, {
          operationId: operation.id,
          conflictingGroups: groupIds.filter(id => operation.groupIds.includes(id))
        });
        return true;
      }
    }
    return false;
  }

  /**
   * 执行原子操作的通用框架
   * 使用分布式锁确保 Pull → 操作 → Push(覆盖) 的原子性
   */
  async executeAtomicOperation<T>(
    operationType: PendingOperation['type'],
    operation: (groups: TabGroup[]) => Promise<{ success: boolean; updatedGroups: TabGroup[]; result: T }>,
    operationName: string
  ): Promise<{ success: boolean; result: T; operationId: string }> {
    const operationId = atomicOperationWrapper.generateOperationId(operationType);

    // 根据操作类型确定锁类型
    const lockType = this.getLockTypeForOperation(operationType);

    const result = await atomicOperationWrapper.executeAtomicDataOperation(
      // Pull操作
      async () => {
        const pullResult = await optimisticSyncService.pullLatestData();
        return pullResult.syncedGroups || await storage.getGroups();
      },

      // Process操作
      async (groups: TabGroup[]) => {
        const operationResult = await operation(groups);
        return {
          success: operationResult.success,
          updatedData: operationResult.updatedGroups,
          result: operationResult.result
        };
      },

      // Push操作
      async (groups: TabGroup[]) => {
        // 立即推送到云端（覆盖模式）- 带重试机制
        let pushResult = await optimisticSyncService.pushOnlySync();

        // 如果推送失败，重试一次
        if (!pushResult.success && pushResult.message?.includes('正在进行中')) {
          logger.info('🔄 推送冲突，等待后重试');
          await new Promise(resolve => setTimeout(resolve, 2000));
          pushResult = await optimisticSyncService.pushOnlySync();
        }

        if (pushResult.success) {
          logger.info(`✅ ${operationName}结果已推送到云端（覆盖模式）`);
        } else {
          logger.warn(`⚠️ ${operationName}结果推送失败:`, { message: pushResult.message });
          // 即使推送失败，本地操作已完成，不回滚
        }

        // 保存到本地存储
        await storage.setGroups(groups);
      },

      // 配置
      {
        type: lockType,
        operationId,
        description: operationName,
        timeout: 30000,
        retryOnLockFailure: true,
        maxRetries: 3
      }
    );

    if (result.success) {
      logger.info(`✅ 原子操作完成: ${operationName}`, { operationId, duration: result.duration });
      return {
        success: true,
        result: result.result as T,
        operationId: result.operationId
      };
    } else {
      logger.error(`❌ 原子操作失败: ${operationName}`, result.error, { operationId });
      return {
        success: false,
        result: {} as T,
        operationId: result.operationId
      };
    }
  }

  /**
   * 根据操作类型确定锁类型
   */
  private getLockTypeForOperation(operationType: PendingOperation['type']): LockType {
    switch (operationType) {
      case 'create':
      case 'update':
      case 'delete':
      case 'deduplication':
        return LockType.USER_OPERATION;
      default:
        return LockType.USER_OPERATION;
    }
  }

  /**
   * 执行受保护的去重操作（使用原子操作框架）
   */
  async executeProtectedDeduplication(): Promise<{ success: boolean; removedCount: number; operationId: string }> {
    const result = await this.executeAtomicOperation<{ removedCount: number }>(
      'deduplication',
      async (groups: TabGroup[]) => {
        const deduplicationResult = await this.performDeduplication(groups);
        return {
          success: deduplicationResult.success,
          updatedGroups: deduplicationResult.updatedGroups,
          result: { removedCount: deduplicationResult.removedCount }
        };
      },
      '去重操作'
    );

    return {
      success: result.success,
      removedCount: result.result.removedCount || 0,
      operationId: result.operationId
    };
  }

  /**
   * 执行受保护的删除操作（使用原子操作框架）
   */
  async executeProtectedDeletion(groupId: string): Promise<{ success: boolean; deletedGroupId: string; operationId: string }> {
    const result = await this.executeAtomicOperation<{ deletedGroupId: string }>(
      'delete',
      async (groups: TabGroup[]) => {
        // 检查标签组是否存在
        const groupExists = groups.some(g => g.id === groupId);
        if (!groupExists) {
          logger.warn(`标签组 ${groupId} 不存在，跳过删除`);
          return {
            success: false,
            updatedGroups: groups,
            result: { deletedGroupId: '' }
          };
        }

        // 执行删除操作
        const updatedGroups = groups.filter(g => g.id !== groupId);

        logger.info(`删除标签组: ${groupId}`);
        return {
          success: true,
          updatedGroups,
          result: { deletedGroupId: groupId }
        };
      },
      '删除操作'
    );

    return {
      success: result.success,
      deletedGroupId: result.result.deletedGroupId || '',
      operationId: result.operationId
    };
  }

  /**
   * 执行受保护的更新操作（使用原子操作框架）
   */
  async executeProtectedUpdate(
    groupId: string,
    updateFn: (group: TabGroup) => TabGroup,
    operationName: string = '更新操作'
  ): Promise<{ success: boolean; updatedGroup: TabGroup | null; operationId: string }> {
    const result = await this.executeAtomicOperation<{ updatedGroup: TabGroup | null }>(
      'update',
      async (groups: TabGroup[]) => {
        // 查找要更新的标签组
        const groupIndex = groups.findIndex(g => g.id === groupId);
        if (groupIndex === -1) {
          logger.warn(`标签组 ${groupId} 不存在，跳过更新`);
          return {
            success: false,
            updatedGroups: groups,
            result: { updatedGroup: null }
          };
        }

        // 执行更新操作
        const originalGroup = groups[groupIndex];
        const updatedGroup = updateFn(originalGroup);

        // 更新版本号和时间戳
        const finalUpdatedGroup = {
          ...updatedGroup,
          version: (originalGroup.version || 1) + 1,
          updatedAt: new Date().toISOString()
        };

        // 创建新的标签组数组
        const updatedGroups = [...groups];
        updatedGroups[groupIndex] = finalUpdatedGroup;

        logger.info(`${operationName}: ${groupId}`);
        return {
          success: true,
          updatedGroups,
          result: { updatedGroup: finalUpdatedGroup }
        };
      },
      operationName
    );

    return {
      success: result.success,
      updatedGroup: result.result.updatedGroup,
      operationId: result.operationId
    };
  }

  /**
   * 执行去重逻辑 - 简化版本，与删除逻辑保持一致
   */
  private async performDeduplication(groups: TabGroup[]): Promise<{ success: boolean; updatedGroups: TabGroup[]; removedCount: number }> {
    try {
      logger.info('🔄 开始执行去重逻辑');

      const urlMap = new Map<string, boolean>();
      let removedCount = 0;

      // 创建深拷贝避免修改原数据
      const updatedGroups = groups.map(group => ({
        ...group,
        tabs: [...group.tabs]
      }));

      // 执行去重逻辑
      updatedGroups.forEach((group) => {
        const originalTabCount = group.tabs.length;

        group.tabs = group.tabs.filter((tab) => {
          if (!tab.url) return true; // 保留没有URL的标签

          const key = tab.url;
          if (urlMap.has(key)) {
            removedCount++;
            return false; // 重复，过滤掉
          }

          urlMap.set(key, true);
          return true;
        });

        // 如果标签数量发生变化，更新时间戳和版本号
        if (group.tabs.length !== originalTabCount) {
          group.updatedAt = new Date().toISOString();
          group.version = (group.version || 1) + 1;
        }
      });

      // 过滤空的标签组
      const filteredGroups = updatedGroups.filter(group => group.tabs.length > 0);

      logger.info(`✅ 去重完成: 移除 ${removedCount} 个重复标签，剩余 ${filteredGroups.length} 个标签组`);

      return {
        success: true,
        updatedGroups: filteredGroups,
        removedCount
      };

    } catch (error) {
      logger.error('❌ 去重逻辑执行失败:', error);
      return {
        success: false,
        updatedGroups: [],
        removedCount: 0
      };
    }
  }

  /**
   * 检查实时同步是否应该被阻止
   */
  shouldBlockRealtimeSync(incomingGroupIds: string[]): boolean {
    return this.hasConflictingOperation(incomingGroupIds);
  }

  /**
   * 生成操作ID
   */
  private generateOperationId(): string {
    return `op_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * 获取待处理操作的统计信息
   */
  getPendingOperationsStats(): { count: number; types: string[] } {
    const operations = Array.from(this.pendingOperations.values());
    return {
      count: operations.length,
      types: [...new Set(operations.map(op => op.type))]
    };
  }

  /**
   * 清理过期的操作
   */
  cleanupExpiredOperations(): void {
    const now = Date.now();
    for (const [id, operation] of this.pendingOperations.entries()) {
      if (now - operation.timestamp > this.operationTimeout) {
        this.pendingOperations.delete(id);
        logger.info(`🧹 清理过期操作: ${operation.type}`, { operationId: id });
      }
    }
  }
}

export const syncCoordinator = new SyncCoordinator();
