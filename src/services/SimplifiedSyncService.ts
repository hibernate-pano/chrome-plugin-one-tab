/**
 * 简化的同步服务
 * 基于时间戳的冲突检测，替代复杂的版本号管理
 * 专门处理用户主动操作的同步需求
 */

import { TabGroup } from '@/shared/types/tab';
import { storage } from '@/shared/utils/storage';
import { sync as supabaseSync } from '@/shared/utils/supabase';
import { store } from '@/app/store';
import { setGroups } from '@/features/tabs/store/tabGroupsSlice';
import { selectIsAuthenticated } from '@/features/auth/store/authSlice';
import { logger } from '@/shared/utils/logger';
import {
  timestampComparator,
  dataMerger,
  MergeStrategy,
  type MergeResult
} from '@/shared/utils/timestampComparison';

export interface TimestampConflictInfo {
  type: 'timestamp_conflict';
  localGroup: TabGroup;
  remoteGroup: TabGroup;
  conflictTime: string;
  recommendation: 'use_latest' | 'smart_merge';
}

export interface SimplifiedSyncResult {
  success: boolean;
  conflicts?: TimestampConflictInfo[];
  message?: string;
  syncedGroups?: TabGroup[];
  error?: string;
}

export interface UserOperation {
  type: 'create' | 'update' | 'delete';
  groupId?: string;
  data?: Partial<TabGroup>;
}

/**
 * 简化的同步服务类
 * 专注于用户操作的同步，使用时间戳比较替代版本号管理
 */
export class SimplifiedSyncService {
  private isSyncing = false;
  private readonly SYNC_TIMEOUT = 30000; // 30秒超时
  private readonly CLOCK_SKEW_TOLERANCE = 60000; // 1分钟时钟偏差容忍

  /**
   * 用户操作的主要同步接口
   * 执行 Pull → 冲突检测 → 操作 → Push 流程
   */
  async syncUserOperation(operation: UserOperation): Promise<SimplifiedSyncResult> {
    if (this.isSyncing) {
      logger.warn('同步正在进行中，跳过此次用户操作同步');
      return { success: false, message: '同步正在进行中' };
    }

    const state = store.getState();
    if (!selectIsAuthenticated(state)) {
      logger.warn('用户未登录，跳过同步');
      return { success: false, message: '用户未登录' };
    }

    try {
      this.isSyncing = true;
      logger.info(`🔄 开始用户操作同步: ${operation.type}`, { groupId: operation.groupId });

      // Step 1: Pull - 获取最新的云端数据
      const pullResult = await this.pullLatestData();
      if (!pullResult.success) {
        return pullResult;
      }

      let currentGroups = pullResult.syncedGroups || await storage.getGroups();

      // Step 2: 执行用户操作
      const operationResult = await this.executeUserOperation(currentGroups, operation);
      if (!operationResult.success) {
        return operationResult;
      }

      currentGroups = operationResult.updatedGroups!;

      // Step 3: Push - 推送到云端
      const pushResult = await this.pushToCloud(currentGroups);
      if (!pushResult.success) {
        return pushResult;
      }

      // Step 4: 更新本地存储和UI
      await storage.setGroups(currentGroups);
      store.dispatch(setGroups(currentGroups));

      logger.info('✅ 用户操作同步完成', {
        operation: operation.type,
        groupId: operation.groupId
      });

      return {
        success: true,
        message: '用户操作同步成功',
        syncedGroups: currentGroups
      };

    } catch (error) {
      logger.error('❌ 用户操作同步失败:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '未知错误',
        message: '用户操作同步失败'
      };
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 拉取最新数据并检测时间戳冲突
   */
  private async pullLatestData(): Promise<SimplifiedSyncResult> {
    try {
      logger.info('📥 拉取云端最新数据');

      // 获取云端数据
      const cloudGroups = await supabaseSync.downloadTabGroups();
      logger.info(`从云端获取到 ${cloudGroups.length} 个标签组`);

      // 获取本地数据
      const localGroups = await storage.getGroups();
      logger.info(`本地有 ${localGroups.length} 个标签组`);

      // 检测时间戳冲突
      const conflicts = this.detectTimestampConflicts(localGroups, cloudGroups);

      if (conflicts.length > 0) {
        logger.info(`检测到 ${conflicts.length} 个时间戳冲突，自动解决`);

        // 自动解决冲突
        const resolvedGroups = this.resolveConflictsByLatest(conflicts, localGroups, cloudGroups);

        return {
          success: true,
          conflicts,
          syncedGroups: resolvedGroups
        };
      }

      // 无冲突，使用云端数据（更完整）
      const mergedGroups = this.mergeWithoutConflicts(localGroups, cloudGroups);

      return {
        success: true,
        syncedGroups: mergedGroups
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
   * 检测基于时间戳的冲突（使用新的时间戳比较工具）
   */
  private detectTimestampConflicts(
    localGroups: TabGroup[],
    remoteGroups: TabGroup[]
  ): TimestampConflictInfo[] {
    const conflicts: TimestampConflictInfo[] = [];
    const remoteMap = new Map(remoteGroups.map(g => [g.id, g]));

    for (const localGroup of localGroups) {
      const remoteGroup = remoteMap.get(localGroup.id);
      if (!remoteGroup) continue;

      // 使用新的时间戳比较器
      const comparison = timestampComparator.compareTabGroups(localGroup, remoteGroup);

      // 检查是否存在实际冲突（时间戳不等且有内容差异）
      if (!comparison.isEqual && this.hasContentDifference(localGroup, remoteGroup)) {
        conflicts.push({
          type: 'timestamp_conflict',
          localGroup,
          remoteGroup,
          conflictTime: new Date().toISOString(),
          recommendation: this.getConflictRecommendation(localGroup, remoteGroup)
        });
      }
    }

    return conflicts;
  }

  // hasTimestampConflict 方法已被 timestampComparator.compareTabGroups 替代

  /**
   * 检查内容差异（简化版本）
   */
  private hasContentDifference(local: TabGroup, remote: TabGroup): boolean {
    // 检查基本属性
    if (local.name !== remote.name || local.isLocked !== remote.isLocked) {
      return true;
    }

    // 检查标签页数量
    if (local.tabs.length !== remote.tabs.length) {
      return true;
    }

    // 检查标签页URL（简化比较）
    const localUrls = new Set(local.tabs.map(tab => tab.url));
    const remoteUrls = new Set(remote.tabs.map(tab => tab.url));

    return localUrls.size !== remoteUrls.size ||
      ![...localUrls].every(url => remoteUrls.has(url));
  }

  /**
   * 获取冲突解决建议
   */
  private getConflictRecommendation(
    local: TabGroup,
    remote: TabGroup
  ): TimestampConflictInfo['recommendation'] {
    const timeDiff = Math.abs(
      new Date(local.updatedAt).getTime() - new Date(remote.updatedAt).getTime()
    );

    // 如果时间差很小（5分钟内），建议智能合并
    if (timeDiff < 5 * 60 * 1000) {
      return 'smart_merge';
    }

    // 否则使用最新优先
    return 'use_latest';
  }

  /**
   * 使用最新优先策略解决冲突（使用新的数据合并器）
   */
  private resolveConflictsByLatest(
    conflicts: TimestampConflictInfo[],
    localGroups: TabGroup[],
    remoteGroups: TabGroup[]
  ): TabGroup[] {
    // 使用新的批量合并功能
    const mergeResult = dataMerger.mergeTabGroupArrays(
      localGroups,
      remoteGroups,
      MergeStrategy.LATEST_WINS
    );

    // 记录合并统计信息
    if (mergeResult.conflicts.length > 0) {
      logger.info('冲突解决统计:', {
        总数: mergeResult.stats.total,
        冲突数: mergeResult.stats.conflicts,
        合并数: mergeResult.stats.merged,
        冲突详情: mergeResult.conflicts
      });
    }

    return mergeResult.merged;
  }

  /**
   * 无冲突时的数据合并（使用新的合并器）
   */
  private mergeWithoutConflicts(localGroups: TabGroup[], remoteGroups: TabGroup[]): TabGroup[] {
    // 使用远程优先策略进行无冲突合并
    const mergeResult = dataMerger.mergeTabGroupArrays(
      localGroups,
      remoteGroups,
      MergeStrategy.REMOTE_PRIORITY
    );

    logger.info('无冲突合并完成:', {
      总数: mergeResult.stats.total,
      本地独有: localGroups.length - mergeResult.stats.merged,
      远程独有: remoteGroups.length - mergeResult.stats.merged,
      共同拥有: mergeResult.stats.merged
    });

    return mergeResult.merged;
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
      const now = new Date().toISOString();

      switch (operation.type) {
        case 'create':
          if (operation.data) {
            const newGroup: TabGroup = {
              ...operation.data as TabGroup,
              createdAt: now,
              updatedAt: now,
              lastSyncedAt: null
            };
            updatedGroups.unshift(newGroup);
          }
          break;

        case 'update':
          if (operation.groupId && operation.data) {
            const index = updatedGroups.findIndex(g => g.id === operation.groupId);
            if (index !== -1) {
              updatedGroups[index] = {
                ...updatedGroups[index],
                ...operation.data,
                updatedAt: now,
                lastSyncedAt: null
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

      return { success: true, updatedGroups };

    } catch (error) {
      logger.error('❌ 执行用户操作失败:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '未知错误'
      };
    }
  }

  /**
   * 推送数据到云端
   */
  private async pushToCloud(groups: TabGroup[]): Promise<SimplifiedSyncResult> {
    try {
      logger.info('🔼 推送数据到云端');

      // 使用覆盖模式推送，确保数据一致性
      await supabaseSync.uploadTabGroups(groups, true);

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
   * 验证时间戳的有效性
   */
  private validateTimestamp(timestamp: string): boolean {
    const time = new Date(timestamp).getTime();
    const now = Date.now();

    // 检查时间戳是否合理（不能太久远或未来）
    return time > 0 && time <= now + this.CLOCK_SKEW_TOLERANCE;
  }

  /**
   * 获取当前同步状态
   */
  isSyncInProgress(): boolean {
    return this.isSyncing;
  }
}

// 导出单例实例
export const simplifiedSyncService = new SimplifiedSyncService();
