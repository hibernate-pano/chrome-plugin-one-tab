import { store } from '@/store';
import { syncTabsToCloud, syncTabsFromCloud } from '@/store/slices/tabSlice';
import { syncSettingsToCloud, syncSettingsFromCloud } from '@/store/slices/settingsSlice';
import { getCurrentUser } from '@/store/slices/authSlice';

class SyncService {
  private syncIntervalId: number | null = null;

  // 初始化同步服务
  async initialize() {
    try {
      console.log('正在初始化同步服务...');
      // 检查用户是否已登录
      await store.dispatch(getCurrentUser());
      const { auth, settings } = store.getState();

      console.log('用户登录状态:', auth.isAuthenticated);
      console.log('同步设置状态:', settings.syncEnabled);

      if (auth.isAuthenticated && settings.syncEnabled) {
        console.log('用户已登录且同步已启用，开始同步...');
        // 首次同步
        await this.syncAll();

        // 设置定时同步
        this.startSyncInterval();
      } else {
        console.log('用户未登录或同步未启用，跳过同步');
      }
    } catch (error) {
      console.error('初始化同步服务失败:', error);
    }
  }

  // 同步所有数据
  async syncAll() {
    const { auth } = store.getState();

    if (!auth.isAuthenticated) {
      console.warn('用户未登录，无法同步数据');
      return;
    }

    try {
      console.log('开始同步数据...');

      // 修改同步顺序：先将本地删除操作同步到云端，然后再同步其他数据
      // 这样可以确保删除操作不会被覆盖

      // 先将本地数据同步到云端（包含删除操作）
      console.log('正在将本地数据同步到云端...');
      await store.dispatch(syncTabsToCloud());
      await store.dispatch(syncSettingsToCloud());

      // 然后从云端同步设置
      console.log('正在从云端同步设置...');
      await store.dispatch(syncSettingsFromCloud());

      // 最后从云端同步标签组
      console.log('正在从云端同步标签组...');
      await store.dispatch(syncTabsFromCloud());

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

  // 开始定时同步
  startSyncInterval() {
    const { settings } = store.getState();

    // 清除现有的定时器
    this.stopSyncInterval();

    // 设置新的定时器
    const intervalMinutes = settings.syncInterval || 1;
    const intervalMs = intervalMinutes * 60 * 1000;

    this.syncIntervalId = window.setInterval(() => {
      this.syncAll();
    }, intervalMs);

    console.log(`已设置定时同步，间隔 ${intervalMinutes} 分钟`);
  }

  // 停止定时同步
  stopSyncInterval() {
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
      console.log('已停止定时同步');
    }
  }

  // 更新同步间隔
  updateSyncInterval() {
    const { settings, auth } = store.getState();

    if (auth.isAuthenticated && settings.syncEnabled) {
      this.startSyncInterval();
    } else {
      this.stopSyncInterval();
    }
  }
}

export const syncService = new SyncService();
