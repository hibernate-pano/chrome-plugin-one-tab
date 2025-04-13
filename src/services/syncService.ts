import { store } from '@/store';
import { syncTabsToCloud, syncTabsFromCloud } from '@/store/slices/tabSlice';
import { syncSettingsToCloud, syncSettingsFromCloud } from '@/store/slices/settingsSlice';
import { getCurrentUser } from '@/store/slices/authSlice';
import { sync as supabaseSync } from '@/utils/supabase';

class SyncService {
  // 初始化同步服务 - 已禁用自动同步
  async initialize() {
    console.log('同步服务初始化：已禁用自动同步功能，仅保留手动同步');
    // 不再自动同步，保证本地操作优先，避免卡顿
  }

  // 后台同步数据
  async backgroundSync() {
    return this.syncAll(true);
  }

  // 同步所有数据
  async syncAll(background = true) {
    const { auth } = store.getState();

    if (!auth.isAuthenticated) {
      console.warn('用户未登录，无法同步数据');
      return;
    }

    try {
      console.log(`开始${background ? '后台' : ''}同步数据...`);

      // 修改同步顺序：先将本地删除操作同步到云端，然后再同步其他数据
      // 这样可以确保删除操作不会被覆盖

      // 先将本地数据同步到云端（包含删除操作）
      console.log('正在将本地数据同步到云端...');
      await store.dispatch(syncTabsToCloud({ background }));
      await store.dispatch(syncSettingsToCloud());

      // 然后从云端同步设置
      console.log('正在从云端同步设置...');
      await store.dispatch(syncSettingsFromCloud());

      // 最后从云端同步标签组
      console.log('正在从云端同步标签组...');
      await store.dispatch(syncTabsFromCloud({ background }));

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

  // 从云端同步数据
  async syncFromCloud(background = true) {
    const { auth } = store.getState();

    if (!auth.isAuthenticated) {
      console.warn('用户未登录，无法从云端同步数据');
      return;
    }

    try {
      console.log(`开始${background ? '后台' : ''}从云端同步数据...`);

      // 从云端同步设置
      console.log('正在从云端同步设置...');
      await store.dispatch(syncSettingsFromCloud());

      // 从云端同步标签组
      console.log('正在从云端同步标签组...');
      await store.dispatch(syncTabsFromCloud({ background }));

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
}

export const syncService = new SyncService();
