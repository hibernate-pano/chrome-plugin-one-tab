import { storage } from '@/shared/utils/storage';
import { sync as supabaseSync } from '@/shared/utils/supabase';
import { store } from '@/app/store';
import { TabGroup } from '@/shared/types/tab';
import { setGroups } from '@/features/tabs/store/tabGroupsSlice';
import { selectIsAuthenticated } from '@/features/auth/store/authSlice';

/**
 * 简化的同步服务
 * 专注于核心需求：10秒内跨浏览器同步，最后修改优先
 */
export class SimpleSyncService {
  private uploadTimer: NodeJS.Timeout | null = null;
  private isUploading = false;
  private readonly UPLOAD_DELAY = 5000; // 5秒防抖，确保认证状态恢复完成
  private readonly MAX_RETRIES = 3;

  /**
   * 用户操作后调用，安排上传
   */
  scheduleUpload() {
    console.log('🔄 SimpleSyncService: scheduleUpload 被调用');

    // 清除之前的定时器
    if (this.uploadTimer) {
      clearTimeout(this.uploadTimer);
      console.log('🔄 SimpleSyncService: 清除之前的定时器');
    }

    // 5秒后上传，确保认证状态恢复完成
    console.log('🔄 SimpleSyncService: 设置5秒后上传定时器');
    this.uploadTimer = setTimeout(() => {
      console.log('🔄 SimpleSyncService: 定时器触发，开始上传');
      this.uploadToCloud();
    }, this.UPLOAD_DELAY);
  }

  /**
   * 上传本地数据到云端
   */
  private async uploadToCloud(retryCount = 0): Promise<void> {
    if (this.isUploading) {
      console.log('🔄 正在上传中，跳过此次请求');
      return;
    }

    const state = store.getState();
    if (!selectIsAuthenticated(state)) {
      // 如果用户未登录，但这是第一次检查，等待2秒后重试一次
      if (retryCount === 0) {
        console.log('🔄 用户未登录，2秒后重试检查认证状态');
        setTimeout(() => {
          this.uploadToCloud(1); // 重试一次
        }, 2000);
        return;
      } else {
        console.log('🔄 用户未登录，跳过上传');
        return;
      }
    }

    try {
      this.isUploading = true;
      console.log('🔄 开始上传本地数据到云端');

      // 获取本地数据
      const localGroups = await storage.getGroups();

      // 添加时间戳，实现"最后修改优先"
      const groupsWithTimestamp = localGroups.map(group => ({
        ...group,
        updatedAt: new Date().toISOString()
      }));

      // 上传到云端
      await supabaseSync.uploadTabGroups(groupsWithTimestamp);

      console.log('✅ 数据上传成功');

    } catch (error) {
      console.error('❌ 数据上传失败:', error);

      // 简单的重试机制
      if (retryCount < this.MAX_RETRIES) {
        console.log(`🔄 ${retryCount + 1}/${this.MAX_RETRIES} 次重试上传`);
        setTimeout(() => {
          this.uploadToCloud(retryCount + 1);
        }, 1000 * (retryCount + 1)); // 递增延迟
      }
    } finally {
      this.isUploading = false;
    }
  }

  /**
   * 从云端下载数据（实时同步触发）
   */
  async downloadFromCloud(): Promise<void> {
    const state = store.getState();
    if (!selectIsAuthenticated(state)) {
      console.log('🔄 用户未登录，跳过下载');
      return;
    }

    try {
      console.log('🔄 开始从云端下载数据');

      // 获取云端数据
      const cloudGroups = await supabaseSync.downloadTabGroups();

      // 获取本地数据进行时间戳比较
      const localGroups = await storage.getGroups();

      // 简单的"最后修改优先"策略
      const mergedGroups = this.mergeWithLastModifiedPriority(localGroups, cloudGroups);

      // 保存到本地
      await storage.setGroups(mergedGroups);

      // 更新Redux状态
      store.dispatch(setGroups(mergedGroups));

      console.log('✅ 数据下载并合并成功');

    } catch (error) {
      console.error('❌ 数据下载失败:', error);
    }
  }

  /**
   * 简单的合并策略：最后修改优先
   */
  private mergeWithLastModifiedPriority(localGroups: TabGroup[], cloudGroups: TabGroup[]): TabGroup[] {
    const mergedMap = new Map<string, TabGroup>();

    // 先添加本地数据
    localGroups.forEach(group => {
      mergedMap.set(group.id, group);
    });

    // 云端数据覆盖本地数据（如果云端更新）
    cloudGroups.forEach(cloudGroup => {
      const localGroup = mergedMap.get(cloudGroup.id);

      if (!localGroup) {
        // 云端独有的组，直接添加
        mergedMap.set(cloudGroup.id, cloudGroup);
      } else {
        // 比较时间戳，使用最新的
        const cloudTime = new Date(cloudGroup.updatedAt).getTime();
        const localTime = new Date(localGroup.updatedAt).getTime();

        if (cloudTime > localTime) {
          console.log(`🔄 使用云端版本的标签组: ${cloudGroup.name}`);
          mergedMap.set(cloudGroup.id, cloudGroup);
        } else {
          console.log(`🔄 保留本地版本的标签组: ${localGroup.name}`);
        }
      }
    });

    return Array.from(mergedMap.values());
  }

  /**
   * 清理资源
   */
  destroy() {
    if (this.uploadTimer) {
      clearTimeout(this.uploadTimer);
      this.uploadTimer = null;
    }
  }
}

// 创建全局实例
export const simpleSyncService = new SimpleSyncService();
