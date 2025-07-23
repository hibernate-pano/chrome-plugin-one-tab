/**
 * 统一同步服务
 * 简化的单一同步策略，仅使用Supabase实时订阅 + 手动同步
 * 解决多同步机制冲突问题
 */

import { TabGroup } from '@/shared/types/tab';
import { storage } from '@/shared/utils/storage';
import { sync as supabaseSync } from '@/shared/utils/supabase';
import { store } from '@/app/store';
import { setGroups } from '@/features/tabs/store/tabGroupsSlice';
import { selectIsAuthenticated } from '@/features/auth/store/authSlice';
import { logger } from '@/shared/utils/logger';
import { supabase } from '@/utils/supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { syncDebugLogger, logDeduplicationStep, logPageRefreshStep, analyzeDataChange } from '@/utils/syncDebugLogger';

export interface UnifiedSyncResult {
  success: boolean;
  message: string;
  syncedGroups?: TabGroup[];
  error?: string;
  timestamp: string;
}

/**
 * 统一同步服务类
 * 采用"实时订阅 + 手动同步"的简化策略
 */
export class UnifiedSyncService {
  private channel: RealtimeChannel | null = null;
  private currentUserId: string | null = null;
  private isEnabled = false;
  private isSyncing = false;
  private lastSyncTime = 0;
  private readonly MIN_SYNC_INTERVAL = 1000; // 1秒最小同步间隔

  /**
   * 初始化统一同步服务
   */
  async initialize(): Promise<void> {
    const state = store.getState();
    if (!selectIsAuthenticated(state)) {
      logger.warn('用户未登录，跳过同步服务初始化');
      return;
    }

    try {
      const user = state.auth.user;
      if (!user?.id) {
        logger.warn('无法获取用户ID，跳过同步服务初始化');
        return;
      }

      this.currentUserId = user.id;
      await this.setupRealtimeSubscription();
      this.isEnabled = true;

      logger.info('✅ 统一同步服务初始化成功');

      // 执行初始同步
      await this.performInitialSync();

    } catch (error) {
      logger.error('❌ 统一同步服务初始化失败:', error);
    }
  }

  /**
   * 设置实时订阅
   */
  private async setupRealtimeSubscription(): Promise<void> {
    if (this.channel) {
      await this.channel.unsubscribe();
    }

    this.channel = supabase
      .channel('unified_tab_groups_sync')
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'tab_groups',
        filter: `user_id=eq.${this.currentUserId}`
      }, (payload) => {
        this.handleRealtimeChange(payload);
      })
      .subscribe((status) => {
        logger.info('📡 实时订阅状态:', status);
      });
  }

  /**
   * 处理实时数据变化
   */
  private async handleRealtimeChange(payload: any): Promise<void> {
    try {
      const { eventType, new: newRecord, old: oldRecord } = payload;

      logger.info('🔄 收到实时数据变化:', {
        eventType,
        recordId: newRecord?.id || oldRecord?.id
      });

      // 防抖处理，避免频繁同步
      const now = Date.now();
      if (now - this.lastSyncTime < this.MIN_SYNC_INTERVAL) {
        logger.debug('⏭️ 同步间隔过短，跳过此次实时同步');
        return;
      }

      // 简单的设备过滤：检查device_id
      const deviceId = await this.getCurrentDeviceId();
      const recordDeviceId = eventType === 'DELETE'
        ? oldRecord?.device_id
        : newRecord?.device_id;

      if (recordDeviceId === deviceId) {
        logger.debug('⏭️ 跳过自己设备的变化');
        return;
      }

      // 执行实时同步
      await this.performRealtimeSync();

    } catch (error) {
      logger.error('❌ 处理实时变化失败:', error);
    }
  }

  /**
   * 执行初始同步 - 带详细调试日志
   */
  private async performInitialSync(): Promise<void> {
    logger.info('🔄 执行初始数据同步');

    try {
      await logPageRefreshStep('start', {});

      // 加载本地数据
      const localGroups = await storage.getGroups();
      await logPageRefreshStep('load_local', { localGroups });

      // 加载云端数据
      const cloudGroups = await supabaseSync.downloadTabGroups();
      await logPageRefreshStep('load_cloud', { localGroups, cloudGroups });

      // 数据合并决策
      const finalGroups = cloudGroups.length > 0 ? cloudGroups : localGroups;
      const mergeStrategy = cloudGroups.length > 0 ? 'cloud_priority' : 'local_fallback';

      await logPageRefreshStep('merge', {
        localGroups,
        cloudGroups,
        finalGroups,
        mergeStrategy
      });

      // 分析数据变化
      if (localGroups.length !== finalGroups.length) {
        analyzeDataChange(localGroups, finalGroups, 'initial_sync');
      }

      await storage.setGroups(finalGroups);
      store.dispatch(setGroups(finalGroups));

      await logPageRefreshStep('complete', {
        localGroups,
        cloudGroups,
        finalGroups,
        mergeStrategy
      });

      logger.info('✅ 初始同步完成', {
        cloudCount: cloudGroups.length,
        localCount: localGroups.length,
        finalCount: finalGroups.length,
        strategy: mergeStrategy
      });

    } catch (error) {
      logger.error('❌ 初始同步失败:', error);
      await logPageRefreshStep('complete', { error });
    }
  }

  /**
   * 执行实时同步
   */
  private async performRealtimeSync(): Promise<void> {
    if (this.isSyncing) {
      logger.debug('同步正在进行中，跳过实时同步');
      return;
    }

    try {
      this.isSyncing = true;
      this.lastSyncTime = Date.now();

      logger.info('🔄 执行实时同步');

      // 从云端拉取最新数据
      const cloudGroups = await supabaseSync.downloadTabGroups();

      // 更新本地数据和UI
      await storage.setGroups(cloudGroups);
      store.dispatch(setGroups(cloudGroups));

      logger.info('✅ 实时同步完成', { groupsCount: cloudGroups.length });

    } catch (error) {
      logger.error('❌ 实时同步失败:', error);
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 手动同步（用户操作后调用）
   */
  async manualSync(operation: 'upload' | 'download' | 'bidirectional' = 'bidirectional'): Promise<UnifiedSyncResult> {
    if (this.isSyncing) {
      return {
        success: false,
        message: '同步正在进行中',
        timestamp: new Date().toISOString()
      };
    }

    const state = store.getState();
    if (!selectIsAuthenticated(state)) {
      return {
        success: false,
        message: '用户未登录',
        timestamp: new Date().toISOString()
      };
    }

    try {
      this.isSyncing = true;
      logger.info(`🔄 开始手动同步: ${operation}`);

      let finalGroups: TabGroup[] = [];

      switch (operation) {
        case 'upload':
          finalGroups = await this.performUpload();
          break;
        case 'download':
          finalGroups = await this.performDownload();
          break;
        case 'bidirectional':
          finalGroups = await this.performBidirectionalSync();
          break;
      }

      return {
        success: true,
        message: `${operation}同步成功`,
        syncedGroups: finalGroups,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      logger.error(`❌ 手动同步失败 (${operation}):`, error);
      return {
        success: false,
        message: `${operation}同步失败`,
        error: error instanceof Error ? error.message : '未知错误',
        timestamp: new Date().toISOString()
      };
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 执行上传同步
   */
  private async performUpload(): Promise<TabGroup[]> {
    const localGroups = await storage.getGroups();

    // 使用覆盖模式确保云端数据与本地一致
    await supabaseSync.uploadTabGroups(localGroups, true);

    logger.info('✅ 上传同步完成', { groupsCount: localGroups.length });
    return localGroups;
  }

  /**
   * 执行下载同步
   */
  private async performDownload(): Promise<TabGroup[]> {
    const cloudGroups = await supabaseSync.downloadTabGroups();

    await storage.setGroups(cloudGroups);
    store.dispatch(setGroups(cloudGroups));

    logger.info('✅ 下载同步完成', { groupsCount: cloudGroups.length });
    return cloudGroups;
  }

  /**
   * 执行双向同步 - 带详细调试日志
   */
  private async performBidirectionalSync(): Promise<TabGroup[]> {
    const localGroups = await storage.getGroups();
    const cloudGroups = await supabaseSync.downloadTabGroups();

    logger.info('🔄 开始双向同步', {
      localCount: localGroups.length,
      cloudCount: cloudGroups.length,
      localTotalTabs: localGroups.reduce((sum, g) => sum + g.tabs.length, 0),
      cloudTotalTabs: cloudGroups.reduce((sum, g) => sum + g.tabs.length, 0)
    });

    // 简单的合并策略：使用更新时间较新的数据
    const mergedGroups = this.mergeGroupsByTimestamp(localGroups, cloudGroups);

    // 分析合并结果
    analyzeDataChange(localGroups, mergedGroups, 'bidirectional_merge_local');
    analyzeDataChange(cloudGroups, mergedGroups, 'bidirectional_merge_cloud');

    // 保存到本地和云端
    await storage.setGroups(mergedGroups);
    await supabaseSync.uploadTabGroups(mergedGroups, true);
    store.dispatch(setGroups(mergedGroups));

    logger.info('✅ 双向同步完成', {
      localCount: localGroups.length,
      cloudCount: cloudGroups.length,
      mergedCount: mergedGroups.length,
      mergedTotalTabs: mergedGroups.reduce((sum, g) => sum + g.tabs.length, 0)
    });

    return mergedGroups;
  }

  /**
   * 按时间戳合并标签组 - 带详细合并分析
   */
  private mergeGroupsByTimestamp(localGroups: TabGroup[], cloudGroups: TabGroup[]): TabGroup[] {
    const mergedMap = new Map<string, TabGroup>();
    const mergeDecisions: Array<{
      groupId: string;
      groupName: string;
      decision: 'local_only' | 'cloud_only' | 'local_newer' | 'cloud_newer';
      localTime?: string;
      cloudTime?: string;
    }> = [];

    // 添加本地数据
    localGroups.forEach(group => {
      mergedMap.set(group.id, group);
      mergeDecisions.push({
        groupId: group.id,
        groupName: group.name,
        decision: 'local_only',
        localTime: group.updatedAt
      });
    });

    // 添加云端数据，如果更新时间更新则覆盖
    cloudGroups.forEach(cloudGroup => {
      const localGroup = mergedMap.get(cloudGroup.id);

      if (!localGroup) {
        mergedMap.set(cloudGroup.id, cloudGroup);
        mergeDecisions.push({
          groupId: cloudGroup.id,
          groupName: cloudGroup.name,
          decision: 'cloud_only',
          cloudTime: cloudGroup.updatedAt
        });
      } else {
        const localTime = new Date(localGroup.updatedAt).getTime();
        const cloudTime = new Date(cloudGroup.updatedAt).getTime();

        // 更新合并决策记录
        const decisionIndex = mergeDecisions.findIndex(d => d.groupId === cloudGroup.id);
        if (decisionIndex !== -1) {
          mergeDecisions[decisionIndex].cloudTime = cloudGroup.updatedAt;
        }

        if (cloudTime > localTime) {
          mergedMap.set(cloudGroup.id, cloudGroup);
          if (decisionIndex !== -1) {
            mergeDecisions[decisionIndex].decision = 'cloud_newer';
          }
        } else {
          if (decisionIndex !== -1) {
            mergeDecisions[decisionIndex].decision = 'local_newer';
          }
        }
      }
    });

    // 输出合并决策日志
    console.group('🔀 时间戳合并决策分析');
    console.table(mergeDecisions);
    console.groupEnd();

    const result = Array.from(mergedMap.values());

    logger.info('🔀 时间戳合并完成', {
      localCount: localGroups.length,
      cloudCount: cloudGroups.length,
      mergedCount: result.length,
      decisions: {
        localOnly: mergeDecisions.filter(d => d.decision === 'local_only').length,
        cloudOnly: mergeDecisions.filter(d => d.decision === 'cloud_only').length,
        localNewer: mergeDecisions.filter(d => d.decision === 'local_newer').length,
        cloudNewer: mergeDecisions.filter(d => d.decision === 'cloud_newer').length
      }
    });

    return result;
  }

  /**
   * 执行去重操作（统一接口）- 带详细调试日志
   */
  async performDeduplication(): Promise<UnifiedSyncResult> {
    logger.info('🔄 开始统一去重操作');

    try {
      // 记录开始状态
      const initialLocalGroups = await storage.getGroups();
      await logDeduplicationStep('start', { localGroups: initialLocalGroups });

      // 1. 先下载最新数据
      await logDeduplicationStep('before_download', { localGroups: initialLocalGroups });

      const downloadResult = await this.manualSync('download');
      if (!downloadResult.success) {
        await logDeduplicationStep('complete', { error: downloadResult.error });
        return downloadResult;
      }

      // 记录下载后的数据状态
      const afterDownloadGroups = await storage.getGroups();
      await logDeduplicationStep('after_download', {
        localGroups: initialLocalGroups,
        cloudGroups: downloadResult.syncedGroups,
        deduplicatedGroups: afterDownloadGroups
      });

      // 分析下载前后的数据变化
      analyzeDataChange(initialLocalGroups, afterDownloadGroups, 'download_sync');

      // 2. 执行去重逻辑
      const groups = await storage.getGroups();
      const deduplicatedGroups = this.performDeduplicationLogic(groups);

      await logDeduplicationStep('after_dedup', {
        localGroups: groups,
        deduplicatedGroups: deduplicatedGroups.groups,
        removedCount: deduplicatedGroups.removedCount
      });

      // 分析去重前后的数据变化
      analyzeDataChange(groups, deduplicatedGroups.groups, 'deduplication');

      // 3. 保存并上传结果
      await storage.setGroups(deduplicatedGroups.groups);
      store.dispatch(setGroups(deduplicatedGroups.groups));

      await supabaseSync.uploadTabGroups(deduplicatedGroups.groups, true);

      await logDeduplicationStep('after_upload', {
        deduplicatedGroups: deduplicatedGroups.groups,
        removedCount: deduplicatedGroups.removedCount
      });

      await logDeduplicationStep('complete', {
        deduplicatedGroups: deduplicatedGroups.groups,
        removedCount: deduplicatedGroups.removedCount
      });

      logger.info('✅ 统一去重操作完成', {
        removedCount: deduplicatedGroups.removedCount,
        remainingGroups: deduplicatedGroups.groups.length
      });

      return {
        success: true,
        message: `去重完成，移除了 ${deduplicatedGroups.removedCount} 个重复标签`,
        syncedGroups: deduplicatedGroups.groups,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      logger.error('❌ 统一去重操作失败:', error);
      await logDeduplicationStep('complete', { error });

      return {
        success: false,
        message: '去重操作失败',
        error: error instanceof Error ? error.message : '未知错误',
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * 去重逻辑实现
   */
  private performDeduplicationLogic(groups: TabGroup[]): { groups: TabGroup[]; removedCount: number } {
    const urlMap = new Map<string, { groupId: string; tabIndex: number }>();
    let removedCount = 0;

    // 创建深拷贝避免修改原数据
    const updatedGroups = groups.map(group => ({
      ...group,
      tabs: [...group.tabs]
    }));

    // 去重逻辑
    updatedGroups.forEach((group, groupIndex) => {
      group.tabs = group.tabs.filter((tab, tabIndex) => {
        if (!tab.url) return true;

        const key = tab.url;
        if (urlMap.has(key)) {
          removedCount++;
          return false;
        }

        urlMap.set(key, { groupId: group.id, tabIndex });
        return true;
      });

      // 更新时间戳
      if (group.tabs.length !== groups[groupIndex].tabs.length) {
        group.updatedAt = new Date().toISOString();
      }
    });

    // 过滤空的标签组
    const filteredGroups = updatedGroups.filter(group => group.tabs.length > 0);

    return {
      groups: filteredGroups,
      removedCount
    };
  }

  /**
   * 获取当前设备ID
   */
  private async getCurrentDeviceId(): Promise<string> {
    try {
      const { deviceId } = await chrome.storage.local.get('deviceId');
      return deviceId || 'unknown';
    } catch (error) {
      return 'unknown';
    }
  }

  /**
   * 断开连接 - 修复disconnect方法
   */
  async disconnect(): Promise<void> {
    try {
      logger.info('🔌 开始断开统一同步服务');

      // 安全地断开实时订阅
      if (this.channel) {
        try {
          await this.channel.unsubscribe();
          logger.info('✅ 实时订阅已断开');
        } catch (error) {
          logger.warn('⚠️ 断开实时订阅时出错:', { error });
        }
        this.channel = null;
      }

      // 重置状态
      this.isEnabled = false;
      this.currentUserId = null;
      this.isSyncing = false;
      this.lastSyncTime = 0;

      logger.info('✅ 统一同步服务已完全断开');
    } catch (error) {
      logger.error('❌ 断开统一同步服务时出错:', error);
      // 即使出错也要重置状态
      this.channel = null;
      this.isEnabled = false;
      this.currentUserId = null;
      this.isSyncing = false;
    }
  }

  /**
   * 获取同步状态
   */
  getStatus(): {
    isEnabled: boolean;
    isSyncing: boolean;
    lastSyncTime: number;
    currentUserId: string | null;
  } {
    return {
      isEnabled: this.isEnabled,
      isSyncing: this.isSyncing,
      lastSyncTime: this.lastSyncTime,
      currentUserId: this.currentUserId
    };
  }
}

/**
 * 全局统一同步服务实例
 */
export const unifiedSyncService = new UnifiedSyncService();
