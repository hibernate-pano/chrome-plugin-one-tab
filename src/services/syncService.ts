import { store } from '@/store';
import { syncTabsToCloud, syncTabsFromCloud } from '@/store/slices/tabSlice';
import { syncSettingsToCloud, syncSettingsFromCloud } from '@/store/slices/settingsSlice';
import { getCurrentUser } from '@/store/slices/authSlice';
import { sync as supabaseSync } from '@/utils/supabase';
import { storage } from '@/utils/storage';

class SyncService {
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
    const { auth } = store.getState();

    if (!auth.isAuthenticated) {
      console.warn('用户未登录，无法上传数据到云端');
      return { success: false, error: '用户未登录' };
    }

    try {
      // 上传数据到云端
      await store.dispatch(syncTabsToCloud({ background, overwriteCloud }));
      await store.dispatch(syncSettingsToCloud());
      return { success: true };
    } catch (error) {
      console.error('数据上传失败:', error);
      // 尝试重新获取用户信息，可能是会话过期
      try {
        await store.dispatch(getCurrentUser());
      } catch (e) {
        console.error('重新获取用户信息失败:', e);
      }
      return { success: false, error: error instanceof Error ? error.message : '上传失败' };
    }
  }

  // 从云端下载数据
  async downloadFromCloud(background = false, overwriteLocal = false) {
    const { auth } = store.getState();

    if (!auth.isAuthenticated) {
      console.warn('用户未登录，无法从云端下载数据');
      return { success: false, error: '用户未登录' };
    }

    try {
      // 从云端下载数据
      await store.dispatch(syncSettingsFromCloud());
      await store.dispatch(syncTabsFromCloud({ background, forceRemoteStrategy: overwriteLocal }));
      return { success: true };
    } catch (error) {
      console.error('从云端下载数据失败:', error);
      // 尝试重新获取用户信息，可能是会话过期
      try {
        await store.dispatch(getCurrentUser());
      } catch (e) {
        console.error('重新获取用户信息失败:', e);
      }
      return { success: false, error: error instanceof Error ? error.message : '下载失败' };
    }
  }

  // 同步所有数据
  async syncAll(background = true) {
    const { auth } = store.getState();

    if (!auth.isAuthenticated) {
      console.warn('用户未登录，无法同步数据');
      return { success: false, error: '用户未登录' };
    }

    try {
      // 同步数据
      await store.dispatch(syncTabsToCloud({ background }));
      await store.dispatch(syncSettingsToCloud());
      await store.dispatch(syncSettingsFromCloud());
      await store.dispatch(syncTabsFromCloud({ background, forceRemoteStrategy: true }));
      return { success: true };
    } catch (error) {
      console.error('数据同步失败:', error);
      // 尝试重新获取用户信息，可能是会话过期
      try {
        await store.dispatch(getCurrentUser());
      } catch (e) {
        console.error('重新获取用户信息失败:', e);
      }
      return { success: false, error: error instanceof Error ? error.message : '同步失败' };
    }
  }

  // 从云端同步数据
  async syncFromCloud(background = true) {
    return this.downloadFromCloud(background);
  }

  // 下载数据
  async downloadAndRefresh(overwriteLocal = false) {
    const { auth } = store.getState();

    if (!auth.isAuthenticated) {
      console.warn('用户未登录，无法从云端下载数据');
      return { success: false, error: '用户未登录' };
    }

    try {
      // 下载数据
      await store.dispatch(syncSettingsFromCloud());
      await store.dispatch(syncTabsFromCloud({ background: false, forceRemoteStrategy: overwriteLocal }));

      // 返回成功结果，不再刷新页面
      return {
        success: true
      };

    } catch (error) {
      console.error('下载数据失败:', error);
      // 尝试重新获取用户信息，可能是会话过期
      try {
        await store.dispatch(getCurrentUser());
      } catch (e) {
        console.error('重新获取用户信息失败:', e);
      }
      return { success: false, error: error instanceof Error ? error.message : '下载失败' };
    }
  }
}

export const syncService = new SyncService();
