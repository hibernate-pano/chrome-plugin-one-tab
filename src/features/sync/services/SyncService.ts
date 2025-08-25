import { store } from '@/app/store';
// 使用新版同步架构
import { syncTabsToCloud, syncTabsFromCloud, uploadToCloud, downloadFromCloud } from '../store/syncSlice';
import { syncSettingsToCloud, syncSettingsFromCloud } from '@/features/settings/store/settingsSlice';
// 使用统一的认证状态检查
import { selectIsAuthenticated } from '@/features/auth/store/authSlice';
import { retryWithBackoff } from '@/shared/utils/syncHelpers';
// 移除复杂的冲突解决器，使用简单的时间戳比较
import { errorHandler } from '@/shared/utils/errorHandler';
import { sync as supabaseSync } from '@/shared/utils/supabase';
import { storage } from '@/shared/utils/storage';

/**
 * 同步领域服务
 * 负责处理云端同步、冲突解决、数据一致性等业务逻辑
 */
export class SyncService {
  // 初始化同步服务 - 已禁用自动同步
  async initialize() {
    console.log('同步服务初始化：已禁用自动同步功能，仅保留手动同步');
    // 不再自动同步，保证本地操作优先，避免卡顿
  }

  // 检查云端是否有数据
  async hasCloudData() {
    try {
      const cloudGroups = await supabaseSync.downloadTabGroups();
      return cloudGroups.length > 0;
    } catch (error) {
      console.error('检查云端数据失败:', error);
      return false;
    }
  }

  // 检查本地是否有数据
  async hasLocalData() {
    try {
      const localGroups = await storage.getGroups();
      return localGroups.length > 0;
    } catch (error) {
      console.error('检查本地数据失败:', error);
      return false;
    }
  }

  // 后台同步数据
  async backgroundSync() {
    return this.syncAll(true);
  }

  // 上传数据到云端（覆盖模式）
  async uploadToCloud(background = false, overwriteCloud = true) {
    const state = store.getState();

    if (!selectIsAuthenticated(state)) {
      throw new Error('用户未登录，无法上传数据');
    }

    try {
      console.log('开始上传数据到云端', { background, overwriteCloud });

      // 使用新版同步操作
      const tabsResult = await store.dispatch(syncTabsToCloud({ background, overwriteCloud }));
      const settingsResult = await store.dispatch(syncSettingsToCloud());

      if (syncTabsToCloud.fulfilled.match(tabsResult) && syncSettingsToCloud.fulfilled.match(settingsResult)) {
        return {
          success: true,
          message: '数据上传成功',
          syncTime: tabsResult.payload.syncTime
        };
      } else {
        throw new Error('上传过程中发生错误');
      }
    } catch (error) {
      console.error('上传数据失败:', error);
      return {
        success: false,
        error: errorHandler.getErrorMessage(error),
        message: '数据上传失败'
      };
    }
  }

  // 从云端下载数据
  async downloadFromCloud(background = false, forceRemoteStrategy = false) {
    const state = store.getState();

    if (!selectIsAuthenticated(state)) {
      throw new Error('用户未登录，无法下载数据');
    }

    try {
      console.log('开始从云端下载数据', { background, forceRemoteStrategy });

      // 使用新版同步操作
      const tabsResult = await store.dispatch(syncTabsFromCloud({ background, forceRemoteStrategy }));
      const settingsResult = await store.dispatch(syncSettingsFromCloud());

      if (syncTabsFromCloud.fulfilled.match(tabsResult) && syncSettingsFromCloud.fulfilled.match(settingsResult)) {
        return {
          success: true,
          message: '数据下载成功',
          syncTime: tabsResult.payload.syncTime
        };
      } else {
        throw new Error('下载过程中发生错误');
      }
    } catch (error) {
      console.error('下载数据失败:', error);
      return {
        success: false,
        error: errorHandler.getErrorMessage(error),
        message: '数据下载失败'
      };
    }
  }

  // 智能同步：根据数据状态选择最佳策略
  async smartSync(background = false) {
    try {
      const hasLocal = await this.hasLocalData();
      const hasCloud = await this.hasCloudData();

      if (!hasLocal && !hasCloud) {
        return { success: true, message: '无数据需要同步' };
      }

      if (!hasLocal && hasCloud) {
        // 只有云端数据，下载到本地
        return await this.downloadFromCloud(background, true);
      }

      if (hasLocal && !hasCloud) {
        // 只有本地数据，上传到云端
        return await this.uploadToCloud(background, true);
      }

      // 两端都有数据，使用冲突解决策略
      return await this.syncWithConflictResolution(background);
    } catch (error) {
      console.error('智能同步失败:', error);
      return {
        success: false,
        error: errorHandler.getErrorMessage(error),
        message: '智能同步失败'
      };
    }
  }

  // 简化的冲突解决：最后修改优先
  async syncWithConflictResolution(background = false) {
    try {
      // 获取本地和云端数据
      const localGroups = await storage.getGroups();
      const cloudGroups = await supabaseSync.downloadTabGroups();

      // 简单的合并策略：云端数据优先（最后修改优先）
      const mergedGroups = cloudGroups.length > 0 ? cloudGroups : localGroups;

      // 保存合并后的数据到本地和云端
      await storage.setGroups(mergedGroups);
      if (localGroups.length > 0) {
        // 在冲突解决后使用覆盖模式确保数据一致性
        await supabaseSync.uploadTabGroups(mergedGroups, true);
      }

      return {
        success: true,
        message: '数据同步完成（简化策略）',
        syncTime: new Date().toISOString()
      };
    } catch (error) {
      console.error('同步失败:', error);
      return {
        success: false,
        error: errorHandler.getErrorMessage(error),
        message: '同步失败'
      };
    }
  }

  // 完整同步（标签组 + 设置）
  async syncAll(background = false) {
    try {
      console.log('开始完整同步', { background });

      // 智能同步标签组
      const tabsResult = await this.smartSync(background);

      // 同步设置（简单策略：云端优先）
      const settingsResult = await store.dispatch(syncSettingsFromCloud());

      if (tabsResult.success && syncSettingsFromCloud.fulfilled.match(settingsResult)) {
        return {
          success: true,
          message: '完整同步成功',
          syncTime: new Date().toISOString()
        };
      } else {
        throw new Error('同步过程中发生错误');
      }
    } catch (error) {
      console.error('完整同步失败:', error);
      return {
        success: false,
        error: errorHandler.getErrorMessage(error),
        message: '完整同步失败'
      };
    }
  }

  // 重试同步（带指数退避）
  async retrySyncWithBackoff(operation: () => Promise<any>, maxRetries = 3) {
    return retryWithBackoff(operation, maxRetries);
  }

  // 获取同步状态
  getSyncStatus() {
    const { sync } = store.getState();
    return {
      status: sync.status,
      operation: sync.operation,
      progress: sync.progress,
      lastSyncTime: sync.lastSyncTime,
      error: sync.error,
      backgroundSync: sync.backgroundSync
    };
  }

  // 清除同步错误
  clearSyncError() {
    // 这里可以dispatch一个清除错误的action
    console.log('清除同步错误');
  }
}

// 导出单例实例
export const syncService = new SyncService();
