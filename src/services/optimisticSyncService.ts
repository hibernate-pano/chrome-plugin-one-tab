/**
 * 乐观锁同步服务
 * 实现"先pull后push"的同步流程，确保数据一致性
 */

import { TabGroup } from '@/shared/types/tab';
import { storage } from '@/shared/utils/storage';
import { sync as supabaseSync } from '@/shared/utils/supabase';
import { store } from '@/app/store';
import { setGroups } from '@/features/tabs/store/tabGroupsSlice';
import { selectIsAuthenticated } from '@/features/auth/store/authSlice';
import { logger } from '@/shared/utils/logger';

export interface ConflictInfo {
  type: 'version_conflict';
  localGroup: TabGroup;
  remoteGroup: TabGroup;
  conflictTime: string;
}

export interface SyncResult {
  success: boolean;
  conflicts?: ConflictInfo[];
  message?: string;
  syncedGroups?: TabGroup[];
}

export class OptimisticSyncService {
  private isSyncing = false;
  private syncQueue: Array<() => Promise<void>> = [];
  private isProcessingQueue = false;

  /**
   * 主要同步方法：严格按照pull-first流程
   */
  async syncWithPullFirst(): Promise<SyncResult> {
    if (this.isSyncing) {
      logger.info('同步正在进行中，跳过此次请求');
      return { success: false, message: '同步正在进行中' };
    }

    const state = store.getState();
    if (!selectIsAuthenticated(state)) {
      logger.info('用户未登录，跳过同步');
      return { success: false, message: '用户未登录' };
    }

    try {
      this.isSyncing = true;
      logger.info('🔄 开始pull-first同步流程');

      // Step 1: Pull - 从云端拉取最新数据
      const pullResult = await this.pullFromCloud();
      if (!pullResult.success) {
        return pullResult;
      }

      // Step 2: 检测冲突
      const conflicts = pullResult.conflicts || [];
      if (conflicts.length > 0) {
        logger.info(`检测到 ${conflicts.length} 个冲突，需要解决`);

        // 自动解决冲突
        const resolvedGroups = await this.autoResolveConflicts(conflicts);

        // 更新本地数据
        await storage.setGroups(resolvedGroups);
        store.dispatch(setGroups(resolvedGroups));
      }

      // Step 3: Push - 将合并后的数据推送到云端
      const pushResult = await this.pushToCloud();

      logger.info('✅ pull-first同步流程完成');
      return {
        success: pushResult.success,
        conflicts: conflicts.length > 0 ? conflicts : undefined,
        message: pushResult.message,
        syncedGroups: pullResult.syncedGroups
      };

    } catch (error) {
      logger.error('❌ 同步流程失败:', error);
      return {
        success: false,
        message: `同步失败: ${error instanceof Error ? error.message : '未知错误'}`
      };
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Pull阶段：从云端拉取数据并检测冲突
   */
  private async pullFromCloud(): Promise<SyncResult> {
    try {
      logger.info('🔽 开始从云端拉取数据');

      // 获取云端数据
      const cloudGroups = await supabaseSync.downloadTabGroups();
      logger.info(`从云端获取到 ${cloudGroups.length} 个标签组`);

      // 获取本地数据
      const localGroups = await storage.getGroups();
      logger.info(`本地有 ${localGroups.length} 个标签组`);

      // 检测版本冲突
      const conflicts = this.detectVersionConflicts(localGroups, cloudGroups);

      if (conflicts.length > 0) {
        logger.info(`检测到 ${conflicts.length} 个版本冲突`);
        return {
          success: true,
          conflicts,
          syncedGroups: cloudGroups
        };
      }

      // 无冲突，直接合并数据
      const mergedGroups = this.mergeWithoutConflicts(localGroups, cloudGroups);

      // 更新本地数据
      await storage.setGroups(mergedGroups);
      store.dispatch(setGroups(mergedGroups));

      return {
        success: true,
        syncedGroups: mergedGroups
      };

    } catch (error) {
      logger.error('❌ 从云端拉取数据失败:', error);
      return {
        success: false,
        message: `拉取数据失败: ${error instanceof Error ? error.message : '未知错误'}`
      };
    }
  }

  /**
   * Push阶段：将本地数据推送到云端（覆盖模式）
   * 在pull-first策略下，本地数据是完整的真实状态，应该完全覆盖云端数据
   */
  private async pushToCloud(): Promise<SyncResult> {
    try {
      logger.info('🔼 开始推送数据到云端（覆盖模式）');

      // 获取当前本地数据
      const localGroups = await storage.getGroups();

      // 为push-only操作准备数据：确保版本号存在但不递增
      // （版本号应该在用户操作时已经递增了）
      const groupsWithVersion = localGroups.map(group => ({
        ...group,
        version: group.version || 1, // 保持现有版本号，不递增
        updatedAt: group.updatedAt || new Date().toISOString() // 保持现有时间戳
      }));

      // 推送到云端 - 使用覆盖模式确保数据一致性
      // 覆盖模式会：1) 更新/插入本地存在的标签组  2) 删除本地不存在但云端存在的标签组
      await supabaseSync.uploadTabGroups(groupsWithVersion, true);

      logger.info('✅ 数据推送到云端成功（覆盖模式）');
      return {
        success: true,
        message: '数据同步成功（覆盖模式）'
      };

    } catch (error) {
      logger.error('❌ 推送数据到云端失败:', error);
      return {
        success: false,
        message: `推送数据失败: ${error instanceof Error ? error.message : '未知错误'}`
      };
    }
  }

  /**
   * 检测版本冲突
   */
  private detectVersionConflicts(localGroups: TabGroup[], cloudGroups: TabGroup[]): ConflictInfo[] {
    const conflicts: ConflictInfo[] = [];
    const cloudGroupsMap = new Map(cloudGroups.map(g => [g.id, g]));

    for (const localGroup of localGroups) {
      const cloudGroup = cloudGroupsMap.get(localGroup.id);

      if (cloudGroup && this.hasVersionConflict(localGroup, cloudGroup)) {
        conflicts.push({
          type: 'version_conflict',
          localGroup,
          remoteGroup: cloudGroup,
          conflictTime: new Date().toISOString()
        });
      }
    }

    return conflicts;
  }

  /**
   * 检查是否存在版本冲突
   */
  private hasVersionConflict(local: TabGroup, remote: TabGroup): boolean {
    // 如果版本号不同，且都有实际的修改，则认为有冲突
    const localVersion = local.version || 1;
    const remoteVersion = remote.version || 1;

    if (localVersion === remoteVersion) {
      return false;
    }

    // 检查是否有实际的内容差异
    return this.hasContentDifference(local, remote);
  }

  /**
   * 检查内容是否有差异
   */
  private hasContentDifference(local: TabGroup, remote: TabGroup): boolean {
    // 比较名称
    if (local.name !== remote.name) return true;

    // 比较标签数量
    if (local.tabs.length !== remote.tabs.length) return true;

    // 比较标签内容（简化版）
    const localUrls = new Set(local.tabs.map(t => t.url));
    const remoteUrls = new Set(remote.tabs.map(t => t.url));

    if (localUrls.size !== remoteUrls.size) return true;

    for (const url of localUrls) {
      if (!remoteUrls.has(url)) return true;
    }

    return false;
  }

  /**
   * 无冲突时的简单合并
   */
  private mergeWithoutConflicts(localGroups: TabGroup[], cloudGroups: TabGroup[]): TabGroup[] {
    const mergedMap = new Map<string, TabGroup>();

    // 先添加云端数据
    cloudGroups.forEach(group => {
      mergedMap.set(group.id, {
        ...group,
        version: group.version || 1
      });
    });

    // 再添加本地独有的数据
    localGroups.forEach(localGroup => {
      if (!mergedMap.has(localGroup.id)) {
        mergedMap.set(localGroup.id, {
          ...localGroup,
          version: localGroup.version || 1
        });
      }
    });

    return Array.from(mergedMap.values());
  }

  /**
   * 自动解决冲突（基础版本）
   */
  private async autoResolveConflicts(conflicts: ConflictInfo[]): Promise<TabGroup[]> {
    const localGroups = await storage.getGroups();
    const resolvedGroups = [...localGroups];

    for (const conflict of conflicts) {
      const { localGroup, remoteGroup } = conflict;

      // 简单策略：保守合并，保留更多数据
      const resolved = this.conservativeMerge(localGroup, remoteGroup);

      // 替换本地数据
      const index = resolvedGroups.findIndex(g => g.id === localGroup.id);
      if (index >= 0) {
        resolvedGroups[index] = resolved;
      }
    }

    return resolvedGroups;
  }

  /**
   * 保守合并策略：保留更多数据
   */
  private conservativeMerge(local: TabGroup, remote: TabGroup): TabGroup {
    // 合并标签，去重
    const allTabs = new Map();

    // 先添加本地标签
    local.tabs.forEach(tab => allTabs.set(tab.id, tab));

    // 再添加远程标签，避免重复URL
    remote.tabs.forEach(remoteTab => {
      if (!allTabs.has(remoteTab.id)) {
        // 检查URL是否重复
        const isDuplicate = Array.from(allTabs.values())
          .some((tab: any) => tab.url === remoteTab.url);

        if (!isDuplicate) {
          allTabs.set(remoteTab.id, remoteTab);
        }
      }
    });

    // 选择较新的名称和属性
    const localTime = new Date(local.updatedAt).getTime();
    const remoteTime = new Date(remote.updatedAt).getTime();
    const useRemote = remoteTime > localTime;

    return {
      ...local,
      name: useRemote ? remote.name : local.name,
      tabs: Array.from(allTabs.values()),
      version: Math.max(local.version || 1, remote.version || 1) + 1,
      updatedAt: new Date().toISOString(),
      isLocked: useRemote ? remote.isLocked : local.isLocked
    };
  }

  /**
   * 添加到同步队列 - 完整的pull-first流程（用于定期同步）
   */
  scheduleSync() {
    this.syncQueue.push(() => this.syncWithPullFirst().then(() => { }));
    this.processQueue();
  }

  /**
   * 用户操作后的push-only同步（避免覆盖用户操作）
   */
  schedulePushOnly() {
    logger.info('🔼 安排push-only同步（用户操作后）');
    this.syncQueue.push(() => this.pushOnlySync().then(() => { }));
    this.processQueue();
  }

  /**
   * Push-only同步：仅推送本地数据到云端，不拉取
   */
  async pushOnlySync(): Promise<SyncResult> {
    if (this.isSyncing) {
      logger.info('同步正在进行中，跳过push-only请求');
      return { success: false, message: '同步正在进行中' };
    }

    const state = store.getState();
    if (!selectIsAuthenticated(state)) {
      logger.info('用户未登录，跳过push-only同步');
      return { success: false, message: '用户未登录' };
    }

    try {
      this.isSyncing = true;
      logger.info('🔼 开始push-only同步流程');

      // 直接推送本地数据到云端，不进行pull操作
      const pushResult = await this.pushToCloud();

      logger.info('✅ push-only同步流程完成');
      return {
        success: pushResult.success,
        message: pushResult.message
      };

    } catch (error) {
      logger.error('❌ push-only同步流程失败:', error);
      return {
        success: false,
        message: `push-only同步失败: ${error instanceof Error ? error.message : '未知错误'}`
      };
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 仅拉取最新数据（用于去重等操作前的数据同步）
   */
  async pullLatestData(): Promise<SyncResult> {
    const state = store.getState();
    if (!selectIsAuthenticated(state)) {
      logger.info('用户未登录，跳过数据拉取');
      return { success: false, message: '用户未登录' };
    }

    try {
      logger.info('🔽 开始拉取最新数据（去重前同步）');

      // 获取云端数据
      const cloudGroups = await supabaseSync.downloadTabGroups();
      logger.info(`从云端获取到 ${cloudGroups.length} 个标签组`);

      // 获取本地数据
      const localGroups = await storage.getGroups();
      logger.info(`本地有 ${localGroups.length} 个标签组`);

      // 检测版本冲突
      const conflicts = this.detectVersionConflicts(localGroups, cloudGroups);

      if (conflicts.length > 0) {
        logger.info(`检测到 ${conflicts.length} 个版本冲突，自动解决`);
        // 自动解决冲突
        const resolvedGroups = await this.autoResolveConflicts(conflicts);

        // 更新本地数据
        await storage.setGroups(resolvedGroups);
        store.dispatch(setGroups(resolvedGroups));

        return {
          success: true,
          conflicts,
          syncedGroups: resolvedGroups
        };
      }

      // 无冲突，直接合并数据
      const mergedGroups = this.mergeWithoutConflicts(localGroups, cloudGroups);

      // 更新本地数据
      await storage.setGroups(mergedGroups);
      store.dispatch(setGroups(mergedGroups));

      logger.info('✅ 最新数据拉取完成');
      return {
        success: true,
        syncedGroups: mergedGroups
      };

    } catch (error) {
      logger.error('❌ 拉取最新数据失败:', error);
      return {
        success: false,
        message: `拉取数据失败: ${error instanceof Error ? error.message : '未知错误'}`
      };
    }
  }

  /**
   * 处理同步队列
   */
  private async processQueue() {
    if (this.isProcessingQueue || this.syncQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.syncQueue.length > 0) {
      const task = this.syncQueue.shift();
      if (task) {
        try {
          await task();
        } catch (error) {
          logger.error('队列任务执行失败:', error);
        }
      }
    }

    this.isProcessingQueue = false;
  }
}

export const optimisticSyncService = new OptimisticSyncService();
