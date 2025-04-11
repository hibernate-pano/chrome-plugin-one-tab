import { store } from '@/store';
import { syncTabsToCloud, syncTabsFromCloud } from '@/store/slices/tabSlice';
import { syncSettingsToCloud, syncSettingsFromCloud } from '@/store/slices/settingsSlice';
import { getCurrentUser } from '@/store/slices/authSlice';

class SyncService {
  // 初始化同步服务
  async initialize() {
    try {
      console.log('正在初始化同步服务...');
      // 检查用户是否已登录
      await store.dispatch(getCurrentUser());
      const { auth } = store.getState();

      console.log('用户登录状态:', auth.isAuthenticated);

      if (auth.isAuthenticated) {
        console.log('用户已登录，从云端获取最新数据...');
        // 首次同步，从云端获取数据，使用后台同步模式
        await this.syncFromCloud(true);
      } else {
        console.log('用户未登录，跳过同步');
      }
    } catch (error) {
      console.error('初始化同步服务失败:', error);
    }
  }

  // 后台同步数据
  async backgroundSync() {
    return this.syncAll(true);
  }

  // 同步所有数据
  async syncAll(background = false) {
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
  async syncFromCloud(background = false) {
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
