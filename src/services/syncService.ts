import { store } from '@/store';
import { setGroups } from '@/store/slices/tabSlice';
import { getCurrentUser } from '@/store/slices/authSlice';
import { sync as supabaseSync } from '@/utils/supabase';
import { realtimeService } from './realtimeService';
import { storage } from '@/utils/storage';
import { TabGroup } from '@/types/tab';

/**
 * 智能合并数据
 * @param localData 本地数据
 * @param cloudData 云端数据
 * @returns 合并后的数据
 */
function mergeData(localData: TabGroup[], cloudData: TabGroup[]): TabGroup[] {
  const mergedMap = new Map<string, TabGroup>();
  const currentTime = new Date().toISOString();

  // 添加所有本地项到映射
  localData.forEach(item => {
    // 标记本地项的同步状态
    const localItem = {
      ...item,
      syncStatus: 'synced' as const,
      lastSyncedAt: currentTime
    };
    mergedMap.set(item.id, localItem);
  });

  // 合并云端项，冲突时使用更新版本
  cloudData.forEach(cloudItem => {
    const localItem = mergedMap.get(cloudItem.id);

    if (!localItem) {
      // 云端独有项，添加它
      const newItem = {
        ...cloudItem,
        syncStatus: 'synced' as const,
        lastSyncedAt: currentTime
      };
      mergedMap.set(cloudItem.id, newItem);
    } else {
      // 项存在于本地，使用更新版本
      const localTime = new Date(localItem.updatedAt).getTime();
      const cloudTime = new Date(cloudItem.updatedAt).getTime();

      if (cloudTime > localTime) {
        // 云端版本更新，使用云端版本
        const updatedItem = {
          ...cloudItem,
          syncStatus: 'synced' as const,
          lastSyncedAt: currentTime
        };
        mergedMap.set(cloudItem.id, updatedItem);
      }
    }
  });

  return Array.from(mergedMap.values());
}

class SyncService {
  // 初始化同步服务 - 优化版本
  async initialize() {
    try {
      console.log('正在初始化同步服务...');
      // 检查用户是否已登录
      await store.dispatch(getCurrentUser());
      const { auth } = store.getState();

      console.log('用户登录状态:', auth.isAuthenticated);

      if (auth.isAuthenticated) {
        console.log('用户已登录，执行初始同步...');

        // 执行初始同步 - 合并本地和云端数据
        await this.performInitialSync();

        // 设置优化的 Realtime 订阅
        console.log('设置优化的 Realtime 订阅...');
        try {
          const subscription = await realtimeService.setupRealtimeSubscription();
          if (subscription) {
            console.log('Realtime 订阅设置成功');
          } else {
            console.warn('Realtime 订阅设置失败');
          }
        } catch (realtimeError) {
          console.error('Realtime 订阅设置失败:', realtimeError);
        }
      } else {
        console.log('用户未登录，跳过同步');
      }
    } catch (error) {
      console.error('初始化同步服务失败:', error);
    }
  }

  // 执行初始同步 - 合并本地和云端数据
  async performInitialSync() {
    try {
      console.log('执行初始同步...');

      // 1. 获取本地数据
      const localGroups = await storage.getGroups();
      const localSettings = await storage.getSettings();

      console.log(`本地数据: ${localGroups.length} 个标签组`);

      // 2. 获取云端数据
      const cloudGroups = await supabaseSync.downloadTabGroups();
      const cloudSettings = await supabaseSync.downloadSettings();

      console.log(`云端数据: ${cloudGroups.length} 个标签组`);

      // 3. 合并数据（保留所有唯一项）
      const mergedGroups = mergeData(localGroups, cloudGroups);
      const mergedSettings = { ...localSettings, ...cloudSettings };

      console.log(`合并后的数据: ${mergedGroups.length} 个标签组`);

      // 4. 保存合并后的数据到本地
      await storage.setGroups(mergedGroups);
      await storage.setSettings(mergedSettings);

      // 更新 Redux 存储
      store.dispatch(setGroups(mergedGroups));

      // 5. 将合并后的数据推送到云端
      console.log('将合并后的数据推送到云端...');
      await supabaseSync.uploadTabGroups(mergedGroups);
      await supabaseSync.uploadSettings(mergedSettings);

      console.log('初始同步完成');
    } catch (error) {
      console.error('执行初始同步失败:', error);
      throw error;
    }
  }

  // 后台同步数据 - 优化版本
  async backgroundSync() {
    return this.syncAll(true);
  }

  // 同步所有数据 - 优化版本
  async syncAll(background = true) {
    const { auth } = store.getState();

    if (!auth.isAuthenticated) {
      console.warn('用户未登录，无法同步数据');
      return;
    }

    try {
      console.log(`开始${background ? '后台' : ''}同步数据...`);

      // 1. 获取本地数据
      const localGroups = await storage.getGroups();
      const localSettings = await storage.getSettings();

      // 2. 获取云端数据
      const cloudGroups = await supabaseSync.downloadTabGroups();
      const cloudSettings = await supabaseSync.downloadSettings();

      // 3. 合并数据
      const mergedGroups = mergeData(localGroups, cloudGroups);
      const mergedSettings = { ...localSettings, ...cloudSettings };

      // 4. 保存合并后的数据到本地
      await storage.setGroups(mergedGroups);
      await storage.setSettings(mergedSettings);

      // 更新 Redux 存储
      store.dispatch(setGroups(mergedGroups));

      // 5. 将合并后的数据推送到云端
      await supabaseSync.uploadTabGroups(mergedGroups);
      await supabaseSync.uploadSettings(mergedSettings);

      console.log('数据同步完成！');
    } catch (error) {
      console.error('数据同步失败:', error);
      // 尝试重新获取用户信息，可能是会话过期
      try {
        await store.dispatch(getCurrentUser());
      } catch (e) {
        console.error('重新获取用户信息失败:', e);
      }
    }
  }

  // 从云端同步数据 - 优化版本
  async syncFromCloud(background = true) {
    const { auth } = store.getState();

    if (!auth.isAuthenticated) {
      console.warn('用户未登录，无法从云端同步数据');
      return;
    }

    try {
      console.log(`开始${background ? '后台' : ''}从云端同步数据...`);

      // 1. 获取云端数据
      const cloudGroups = await supabaseSync.downloadTabGroups();
      const cloudSettings = await supabaseSync.downloadSettings();

      // 2. 获取本地数据
      const localGroups = await storage.getGroups();
      const localSettings = await storage.getSettings();

      // 3. 合并数据，优先使用云端数据
      const mergedGroups = mergeData(localGroups, cloudGroups);
      const mergedSettings = { ...localSettings, ...cloudSettings };

      // 4. 保存合并后的数据到本地
      await storage.setGroups(mergedGroups);
      await storage.setSettings(mergedSettings);

      // 更新 Redux 存储
      store.dispatch(setGroups(mergedGroups));

      console.log('从云端同步数据完成！');
    } catch (error) {
      console.error('从云端同步数据失败:', error);
      // 尝试重新获取用户信息，可能是会话过期
      try {
        await store.dispatch(getCurrentUser());
      } catch (e) {
        console.error('重新获取用户信息失败:', e);
      }
    }
  }

  // 同步单个标签组到云端
  async syncGroupToCloud(group: TabGroup) {
    const { auth } = store.getState();

    if (!auth.isAuthenticated) {
      console.warn('用户未登录，无法同步数据');
      return false;
    }

    try {
      console.log(`同步标签组 ${group.id} 到云端...`);

      // 上传单个标签组
      await supabaseSync.uploadTabGroups([group]);

      console.log(`标签组 ${group.id} 同步完成`);
      return true;
    } catch (error) {
      console.error(`同步标签组 ${group.id} 失败:`, error);
      return false;
    }
  }
}

export const syncService = new SyncService();
