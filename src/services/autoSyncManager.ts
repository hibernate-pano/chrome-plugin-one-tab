import { store } from '@/store';
import { syncService } from '@/services/syncService';
import { storage } from '@/utils/storage';

export interface AutoSyncOptions {
  enabled: boolean;
  interval: number; // 分钟
  onUserActions: boolean; // 是否在用户操作后自动同步
  onLogin: boolean; // 是否在登录后自动同步
}

class AutoSyncManager {
  private intervalId: NodeJS.Timeout | null = null;
  private pendingSync = false;
  private lastSyncTime = 0;
  private debounceTimer: NodeJS.Timeout | null = null;
  private readonly DEBOUNCE_DELAY = 3000; // 3秒防抖
  private readonly MIN_SYNC_INTERVAL = 60000; // 最小同步间隔1分钟

  /**
   * 初始化自动同步管理器
   */
  async initialize() {
    console.log('🔄 初始化智能自动同步管理器');
    
    // 监听设置变化
    this.watchSettingsChanges();
    
    // 监听用户操作
    this.watchUserActions();
    
    // 启动定时同步
    await this.startPeriodicSync();
    
    // 监听用户登录状态
    this.watchAuthState();
  }

  /**
   * 监听设置变化
   */
  private watchSettingsChanges() {
    store.subscribe(() => {
      const state = store.getState();
      const { autoSyncEnabled, syncInterval } = state.settings;
      
      if (autoSyncEnabled) {
        this.updateSyncInterval(syncInterval);
      } else {
        this.stopPeriodicSync();
      }
    });
  }

  /**
   * 监听用户操作（通过Redux store变化）
   */
  private watchUserActions() {
    let previousState = store.getState();
    
    store.subscribe(() => {
      const currentState = store.getState();
      const { autoSyncEnabled, syncEnabled } = currentState.settings;
      const { isAuthenticated } = currentState.auth;
      
      // 只有在启用自动同步且用户已登录时才触发
      if (!autoSyncEnabled || !syncEnabled || !isAuthenticated) {
        return;
      }
      
      // 检查标签组是否发生变化
      const groupsChanged = this.hasGroupsChanged(
        previousState.tabs.groups,
        currentState.tabs.groups
      );
      
      if (groupsChanged) {
        console.log('🔄 检测到标签组变化，触发自动同步');
        this.debouncedSync('user_action');
      }
      
      previousState = currentState;
    });
  }

  /**
   * 监听认证状态变化
   */
  private watchAuthState() {
    let previousAuthState = store.getState().auth.isAuthenticated;
    
    store.subscribe(() => {
      const currentAuthState = store.getState().auth.isAuthenticated;
      const { autoSyncEnabled, syncEnabled } = store.getState().settings;
      
      // 用户刚登录且启用自动同步
      if (!previousAuthState && currentAuthState && autoSyncEnabled && syncEnabled) {
        console.log('🔄 用户登录，触发自动下载同步');
        setTimeout(() => {
          this.performAutoDownload();
        }, 2000); // 登录后延迟2秒同步，确保UI稳定
      }
      
      previousAuthState = currentAuthState;
    });
  }

  /**
   * 检查标签组是否发生变化
   */
  private hasGroupsChanged(prevGroups: any[], currentGroups: any[]): boolean {
    if (prevGroups.length !== currentGroups.length) {
      return true;
    }
    
    // 简单检查：比较组数量和最后更新时间
    for (let i = 0; i < currentGroups.length; i++) {
      const prevGroup = prevGroups.find(g => g.id === currentGroups[i].id);
      if (!prevGroup || prevGroup.updatedAt !== currentGroups[i].updatedAt) {
        return true;
      }
      
      // 检查标签页数量
      if (prevGroup.tabs.length !== currentGroups[i].tabs.length) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * 防抖同步
   */
  private debouncedSync(trigger: 'user_action' | 'periodic' | 'login') {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    
    this.debounceTimer = setTimeout(() => {
      this.performAutoSync(trigger);
    }, this.DEBOUNCE_DELAY);
  }

  /**
   * 执行自动同步
   */
  private async performAutoSync(trigger: string) {
    const currentTime = Date.now();
    
    // 检查最小同步间隔
    if (currentTime - this.lastSyncTime < this.MIN_SYNC_INTERVAL) {
      console.log('🔄 同步间隔过短，跳过此次自动同步');
      return;
    }
    
    const state = store.getState();
    const { autoSyncEnabled, syncEnabled } = state.settings;
    const { isAuthenticated } = state.auth;
    const { syncStatus } = state.tabs;
    
    // 检查前置条件
    if (!autoSyncEnabled || !syncEnabled || !isAuthenticated || syncStatus === 'syncing') {
      return;
    }
    
    if (this.pendingSync) {
      console.log('🔄 已有同步任务在进行，跳过此次自动同步');
      return;
    }
    
    try {
      this.pendingSync = true;
      this.lastSyncTime = currentTime;
      
      console.log(`🔄 开始自动同步 (触发：${trigger})`);
      
      // 使用智能上传（合并模式，静默进行）
      const result = await syncService.uploadToCloud(true, false); // background=true, overwrite=false
      
      if (result.success) {
        console.log('✅ 自动同步完成');
        // 可选：显示简单通知
        if (state.settings.showNotifications) {
          this.showSyncNotification('success', '数据已自动同步');
        }
      } else {
        console.error('❌ 自动同步失败:', result.error);
        // 只在关键错误时通知用户
        if (!result.error?.includes('网络') && state.settings.showNotifications) {
          this.showSyncNotification('error', '自动同步失败');
        }
      }
      
    } catch (error) {
      console.error('❌ 自动同步异常:', error);
    } finally {
      this.pendingSync = false;
    }
  }

  /**
   * 执行自动下载（登录后）
   */
  private async performAutoDownload() {
    const state = store.getState();
    const { autoSyncEnabled, syncEnabled } = state.settings;
    const { isAuthenticated } = state.auth;
    const { syncStatus } = state.tabs;
    
    if (!autoSyncEnabled || !syncEnabled || !isAuthenticated || syncStatus === 'syncing') {
      return;
    }
    
    try {
      console.log('🔄 开始自动下载同步');
      
      // 检查是否有本地数据
      const hasLocal = await syncService.hasLocalData();
      const hasCloud = await syncService.hasCloudData();
      
      if (hasCloud && !hasLocal) {
        // 云端有数据，本地无数据，直接下载
        await syncService.downloadAndRefresh(true);
        console.log('✅ 登录后自动下载完成（覆盖模式）');
      } else if (hasCloud && hasLocal) {
        // 都有数据，使用合并模式
        await syncService.downloadAndRefresh(false);
        console.log('✅ 登录后自动下载完成（合并模式）');
      }
      
      if (state.settings.showNotifications && hasCloud) {
        this.showSyncNotification('success', '云端数据已同步');
      }
      
    } catch (error) {
      console.error('❌ 自动下载失败:', error);
    }
  }

  /**
   * 启动定期同步
   */
  private async startPeriodicSync() {
    const settings = await storage.getSettings();
    if (settings.autoSyncEnabled) {
      this.updateSyncInterval(settings.syncInterval);
    }
  }

  /**
   * 更新同步间隔
   */
  private updateSyncInterval(intervalMinutes: number) {
    this.stopPeriodicSync();
    
    if (intervalMinutes > 0) {
      const intervalMs = intervalMinutes * 60 * 1000;
      console.log(`🔄 设置定期同步间隔: ${intervalMinutes} 分钟`);
      
      this.intervalId = setInterval(() => {
        this.debouncedSync('periodic');
      }, intervalMs);
    }
  }

  /**
   * 停止定期同步
   */
  private stopPeriodicSync() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('🔄 停止定期同步');
    }
  }

  /**
   * 显示同步通知
   */
  private showSyncNotification(type: 'success' | 'error', message: string) {
    // 使用简单的浏览器通知
    if ('Notification' in window) {
      const iconUrl = chrome.runtime.getURL('icons/icon48.png');
      new Notification(`OneTab Plus - ${type === 'success' ? '✅' : '❌'}`, {
        body: message,
        icon: iconUrl,
        silent: true,
      });
    }
  }

  /**
   * 手动触发同步
   */
  async triggerManualSync() {
    await this.performAutoSync('manual');
  }

  /**
   * 销毁管理器
   */
  destroy() {
    this.stopPeriodicSync();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    console.log('🔄 自动同步管理器已销毁');
  }
}

// 创建全局实例
export const autoSyncManager = new AutoSyncManager();