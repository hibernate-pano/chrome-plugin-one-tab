import { store } from '@/store';
import { syncTabsToCloud, syncTabsFromCloud } from '@/store/slices/tabSlice';
import { syncSettingsToCloud, syncSettingsFromCloud } from '@/store/slices/settingsSlice';
import { getCurrentUser } from '@/store/slices/authSlice';

class SyncService {
  private syncIntervalId: number | null = null;
  
  // 初始化同步服务
  async initialize() {
    // 检查用户是否已登录
    await store.dispatch(getCurrentUser());
    const { auth, settings } = store.getState();
    
    if (auth.isAuthenticated && settings.syncEnabled) {
      // 首次同步
      await this.syncAll();
      
      // 设置定时同步
      this.startSyncInterval();
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
      // 从云端同步设置
      await store.dispatch(syncSettingsFromCloud());
      
      // 从云端同步标签组
      await store.dispatch(syncTabsFromCloud());
      
      // 将本地数据同步到云端
      await store.dispatch(syncTabsToCloud());
      await store.dispatch(syncSettingsToCloud());
      
      console.log('数据同步完成');
    } catch (error) {
      console.error('数据同步失败:', error);
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
