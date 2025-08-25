/**
 * Pull-First 同步服务
 * 实现严格的 pull-first 同步策略，确保每次用户操作前都先拉取云端最新数据
 */

import { TabGroup } from '@/shared/types/tab';
import { storage } from '@/shared/utils/storage';
import { sync as supabaseSync } from '@/shared/utils/supabase';
import { store } from '@/app/store';
import { setGroups } from '@/features/tabs/store/tabGroupsSlice';
import { selectIsAuthenticated } from '@/features/auth/store/authSlice';
import { logger } from '@/shared/utils/logger';
import { atomicOperationWrapper } from './AtomicOperationWrapper';
import { LockType } from './DistributedLockManager';

export interface PullFirstSyncResult {
  success: boolean;
  message?: string;
  syncedGroups?: TabGroup[];
  error?: string;
  conflicts?: number;
}

export interface UserOperation {
  type: 'create' | 'update' | 'delete';
  groupId?: string;
  data?: Partial<TabGroup>;
  description?: string;
}

/**
 * Pull-First 同步服务类
 * 核心原则：每次用户操作前都先拉取云端最新数据，然后在最新数据基础上执行操作
 * 现在使用分布式锁机制确保操作的原子性
 */
export class PullFirstSyncService {
  private readonly SYNC_TIMEOUT = 30000; // 30秒超时

  /**
   * 用户操作的主要同步接口
   * 严格执行 Pull → 操作 → Push 流程，使用分布式锁确保原子性
   */
  async syncUserOperation(operation: UserOperation): Promise<PullFirstSyncResult> {
    const state = store.getState();
    if (!selectIsAuthenticated(state)) {
      logger.warn('用户未登录，跳过同步');
      return { success: false, message: '用户未登录' };
    }

    const operationId = atomicOperationWrapper.generateOperationId('user_op');

    const result = await atomicOperationWrapper.executeAtomicDataOperation(
      // Pull操作
      () => this.pullLatestData().then(result => result.syncedGroups || []),

      // Process操作
      async (groups: TabGroup[]) => {
        const operationResult = await this.executeUserOperation(groups, operation);
        return {
          success: operationResult.success,
          updatedData: operationResult.updatedGroups || groups,
          result: operationResult
        };
      },

      // Push操作
      async (groups: TabGroup[]) => {
        await this.pushToCloud(groups);
        await storage.setGroups(groups);
        store.dispatch(setGroups(groups));
      },

      // 配置
      {
        type: LockType.USER_OPERATION,
        operationId,
        description: `用户操作: ${operation.type} - ${operation.description || operation.groupId}`,
        timeout: this.SYNC_TIMEOUT,
        retryOnLockFailure: true,
        maxRetries: 3
      }
    );

    if (result.success) {
      logger.info('✅ 用户操作同步完成 (pull-first)', { operationId, duration: result.duration });
      return {
        success: true,
        message: '用户操作同步完成',
        syncedGroups: await storage.getGroups()
      };
    } else {
      logger.error('❌ 用户操作同步失败:', result.error, { operationId });
      return {
        success: false,
        error: result.error,
        message: '用户操作同步失败'
      };
    }
  }

  /**
   * 定时同步：仅拉取云端数据，不推送本地变更，使用分布式锁确保原子性
   */
  async performPeriodicSync(): Promise<PullFirstSyncResult> {
    const state = store.getState();
    if (!selectIsAuthenticated(state)) {
      return { success: false, message: '用户未登录' };
    }

    const operationId = atomicOperationWrapper.generateOperationId('periodic_sync');
    logger.info(`🔄 开始定时同步 (${operationId})`);

    // 检查当前锁状态
    const currentLock = atomicOperationWrapper.getCurrentLockStatus();
    if (currentLock) {
      logger.info(`🔒 检测到活跃锁: ${currentLock.type} (${currentLock.operationId})`);
    }

    const result = await atomicOperationWrapper.executeAtomicSync(
      async () => {
        // 定时同步只拉取，不推送，避免覆盖用户正在进行的操作
        const pullResult = await this.pullLatestData();

        if (pullResult.success && pullResult.syncedGroups) {
          // 更新本地存储和 Redux 状态
          await storage.setGroups(pullResult.syncedGroups);
          store.dispatch(setGroups(pullResult.syncedGroups));

          return {
            success: true,
            message: '定时同步完成',
            syncedGroups: pullResult.syncedGroups
          };
        }

        return pullResult;
      },
      {
        type: LockType.PERIODIC_SYNC,
        operationId,
        description: '定时同步 (pull-only)',
        timeout: this.SYNC_TIMEOUT,
        retryOnLockFailure: false, // 定时同步失败不重试，避免阻塞
        maxRetries: 1
      }
    );

    if (result.success) {
      logger.info('✅ 定时同步完成 (pull-only)', { operationId, duration: result.duration });
      return result.result || { success: true, message: '定时同步完成' };
    } else {
      logger.error('❌ 定时同步失败:', result.error, { operationId });
      return {
        success: false,
        error: result.error,
        message: '定时同步失败'
      };
    }
  }

  /**
   * 手动同步：完整的 pull-first 流程，使用分布式锁确保原子性
   */
  async performManualSync(): Promise<PullFirstSyncResult> {
    const state = store.getState();
    if (!selectIsAuthenticated(state)) {
      return { success: false, message: '用户未登录' };
    }

    const operationId = atomicOperationWrapper.generateOperationId('manual_sync');

    const result = await atomicOperationWrapper.executeAtomicDataOperation(
      // Pull操作
      () => this.pullLatestData().then(result => result.syncedGroups || []),

      // Process操作
      async (cloudGroups: TabGroup[]) => {
        const localGroups = await storage.getGroups();

        if (localGroups.length > 0) {
          // 合并本地和云端数据（简单策略：本地优先）
          const mergedGroups = this.mergeGroups(localGroups, cloudGroups);
          return {
            success: true,
            updatedData: mergedGroups,
            result: { message: '手动同步完成（双向）', syncedGroups: mergedGroups }
          };
        } else {
          // 本地无数据，只使用云端数据
          return {
            success: true,
            updatedData: cloudGroups,
            result: { message: '手动同步完成（下载）', syncedGroups: cloudGroups }
          };
        }
      },

      // Push操作
      async (groups: TabGroup[]) => {
        if (groups.length > 0) {
          await this.pushToCloud(groups);
        }
        await storage.setGroups(groups);
        store.dispatch(setGroups(groups));
      },

      // 配置
      {
        type: LockType.MANUAL_SYNC,
        operationId,
        description: '手动同步 (pull-first)',
        timeout: this.SYNC_TIMEOUT,
        retryOnLockFailure: true,
        maxRetries: 2
      }
    );

    if (result.success) {
      logger.info('✅ 手动同步完成 (pull-first)', { operationId, duration: result.duration });
      return {
        success: true,
        message: result.result?.message || '手动同步完成',
        syncedGroups: result.result?.syncedGroups || await storage.getGroups()
      };
    } else {
      logger.error('❌ 手动同步失败:', result.error, { operationId });
      return {
        success: false,
        error: result.error,
        message: '手动同步失败'
      };
    }
  }

  /**
   * 用户操作后的同步：简化版本，主要用于标签拖拽等操作后的同步
   */
  async performUserActionSync(operation: UserOperation): Promise<PullFirstSyncResult> {
    const state = store.getState();
    if (!selectIsAuthenticated(state)) {
      return { success: false, message: '用户未登录' };
    }

    const operationId = atomicOperationWrapper.generateOperationId('user_action');

    const result = await atomicOperationWrapper.executeAtomicSync(
      async () => {
        // 简化的用户操作同步：直接推送当前本地数据到云端
        const localGroups = await storage.getGroups();
        await this.pushToCloud(localGroups);

        return {
          success: true,
          message: '用户操作同步完成',
          syncedGroups: localGroups
        };
      },
      {
        type: LockType.USER_OPERATION,
        operationId,
        description: `用户操作同步: ${operation.type} - ${operation.description || operation.groupId}`,
        timeout: this.SYNC_TIMEOUT,
        retryOnLockFailure: true,
        maxRetries: 2
      }
    );

    if (result.success) {
      logger.info('✅ 用户操作同步完成', { operationId, duration: result.duration });
      return result.result || { success: true, message: '用户操作同步完成' };
    } else {
      logger.error('❌ 用户操作同步失败:', result.error, { operationId });
      return {
        success: false,
        error: result.error,
        message: '用户操作同步失败'
      };
    }
  }

  /**
   * 拉取云端最新数据
   */
  private async pullLatestData(): Promise<PullFirstSyncResult> {
    try {
      logger.info('📥 拉取云端最新数据');

      // 获取云端数据
      const cloudGroups = await supabaseSync.downloadTabGroups();
      logger.info(`从云端获取到 ${cloudGroups.length} 个标签组`);

      // 确保标签组按时间倒序排列
      const sortedGroups = cloudGroups.sort((a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      return {
        success: true,
        syncedGroups: sortedGroups,
        message: '云端数据拉取成功'
      };

    } catch (error) {
      logger.error('❌ 拉取数据失败:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '未知错误',
        message: '拉取云端数据失败'
      };
    }
  }

  /**
   * 推送数据到云端（覆盖模式）
   */
  private async pushToCloud(groups: TabGroup[]): Promise<PullFirstSyncResult> {
    try {
      logger.info('🔼 推送数据到云端（覆盖模式）');

      // 确保标签组按时间倒序排列
      const sortedGroups = groups.sort((a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      // 使用覆盖模式推送，确保云端数据与本地完全一致
      await supabaseSync.uploadTabGroups(sortedGroups, true);

      logger.info('✅ 数据推送成功');
      return {
        success: true,
        message: '数据推送成功'
      };

    } catch (error) {
      logger.error('❌ 推送数据失败:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '未知错误',
        message: '推送数据失败'
      };
    }
  }

  /**
   * 执行用户操作
   */
  private async executeUserOperation(
    groups: TabGroup[],
    operation: UserOperation
  ): Promise<{ success: boolean; updatedGroups?: TabGroup[]; error?: string }> {
    try {
      let updatedGroups = [...groups];

      switch (operation.type) {
        case 'create':
          if (operation.data) {
            const newGroup = {
              ...operation.data,
              id: operation.data.id || `group_${Date.now()}`,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            } as TabGroup;
            updatedGroups = [newGroup, ...updatedGroups];
          }
          break;

        case 'update':
          if (operation.groupId && operation.data) {
            const index = updatedGroups.findIndex(g => g.id === operation.groupId);
            if (index !== -1) {
              updatedGroups[index] = {
                ...updatedGroups[index],
                ...operation.data,
                updatedAt: new Date().toISOString(),
              };
            }
          }
          break;

        case 'delete':
          if (operation.groupId) {
            updatedGroups = updatedGroups.filter(g => g.id !== operation.groupId);
          }
          break;
      }

      return {
        success: true,
        updatedGroups
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '未知错误'
      };
    }
  }

  /**
   * 简单的数据合并策略（本地优先）
   */
  private mergeGroups(localGroups: TabGroup[], cloudGroups: TabGroup[]): TabGroup[] {
    const merged = new Map<string, TabGroup>();

    // 先添加云端数据
    cloudGroups.forEach(group => {
      merged.set(group.id, group);
    });

    // 本地数据覆盖云端数据（本地优先）
    localGroups.forEach(group => {
      merged.set(group.id, group);
    });

    // 转换为数组并按时间倒序排列
    return Array.from(merged.values()).sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  /**
   * 获取同步状态
   */
  getStatus() {
    return {
      isSyncing: this.isSyncing
    };
  }
}

/**
 * 全局 Pull-First 同步服务实例
 */
export const pullFirstSyncService = new PullFirstSyncService();
