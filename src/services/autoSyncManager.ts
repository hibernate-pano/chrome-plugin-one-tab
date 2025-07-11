import { store } from '@/store';
import { syncService } from '@/services/syncService';
import { storage } from '@/utils/storage';
import { supabase } from '@/utils/supabase';
import { realtimeSync } from '@/services/realtimeSync';

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
    
    // 🔥 初始化实时同步
    await this.initializeRealtimeSync();
  }

  /**
   * 初始化实时同步
   */
  private async initializeRealtimeSync() {
    try {
      const state = store.getState();
      
      if (state.auth.isAuthenticated && state.settings.syncEnabled) {
        console.log('🔄 启用实时同步');
        await realtimeSync.initialize();
      } else {
        console.log('🔄 实时同步条件不满足，跳过');
      }
    } catch (error) {
      console.error('❌ 实时同步初始化失败:', error);
    }
  }

  /**
   * 监听设置变化
   */
  private watchSettingsChanges() {
    let previousSettings = store.getState().settings;
    
    store.subscribe(() => {
      const currentSettings = store.getState().settings;
      const { autoSyncEnabled, syncInterval } = currentSettings;
      
      // 只有在相关设置发生变化时才更新
      if (previousSettings.autoSyncEnabled !== autoSyncEnabled || 
          previousSettings.syncInterval !== syncInterval) {
        
        if (autoSyncEnabled) {
          this.updateSyncInterval(syncInterval);
        } else {
          this.stopPeriodicSync();
        }
        
        previousSettings = currentSettings;
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
        
        // 🔥 用户登录后启用实时同步
        setTimeout(() => {
          this.initializeRealtimeSync();
        }, 3000);
      }
      
      // 用户登出时禁用实时同步
      if (previousAuthState && !currentAuthState) {
        console.log('🔄 用户登出，禁用实时同步');
        realtimeSync.disable();
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
   * 执行自动同步（双向：上传 + 下载检查）
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
      
      console.log(`🔄 开始智能双向同步 (触发：${trigger})`);
      
      // 1. 先检查云端数据是否有更新
      const needDownload = await this.checkCloudDataUpdate();
      
      if (needDownload) {
        console.log('🔄 检测到云端数据更新，开始下载');
        await this.performSmartDownload();
      }
      
      // 2. 再上传本地数据（如果是用户操作触发的）
      if (trigger === 'user_action') {
        console.log('🔄 用户操作触发，上传本地数据');
        const result = await syncService.uploadToCloud(true, true); // background=true, overwrite=true
        
        if (result.success) {
          console.log('✅ 本地数据上传完成');
        } else {
          console.error('❌ 本地数据上传失败:', result.error);
        }
      }
      
      // 3. 定期同步时，根据情况决定是否上传
      if (trigger === 'periodic') {
        // 检查本地是否有未同步的数据
        const hasLocalChanges = await this.checkLocalChanges();
        if (hasLocalChanges) {
          console.log('🔄 检测到本地有未同步数据，开始上传');
          await syncService.uploadToCloud(true, true);
        }
      }
      
      console.log('✅ 智能双向同步完成');
      
      // 显示通知
      if (state.settings.showNotifications) {
        this.showSyncNotification('success', '数据已自动同步');
      }
      
    } catch (error) {
      console.error('❌ 自动同步异常:', error);
      const state = store.getState();
      if (state.settings.showNotifications) {
        this.showSyncNotification('error', '自动同步失败');
      }
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
        // 都有数据，使用覆盖模式确保数据一致性
        await syncService.downloadAndRefresh(true);
        console.log('✅ 登录后自动下载完成（覆盖模式）');
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
    console.log('📊 加载的设置：', {
      autoSyncEnabled: settings.autoSyncEnabled,
      syncInterval: settings.syncInterval,
      syncEnabled: settings.syncEnabled
    });
    
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
   * 检查云端数据是否有更新
   */
  private async checkCloudDataUpdate(): Promise<boolean> {
    try {
      const state = store.getState();
      const { isAuthenticated } = state.auth;
      
      if (!isAuthenticated) {
        return false;
      }

      // 获取云端数据时间戳
      const cloudTimestamp = await this.getCloudDataTimestamp();
      if (!cloudTimestamp) {
        return false;
      }

      // 获取本地数据时间戳
      const localTimestamp = await this.getLocalDataTimestamp();
      if (!localTimestamp) {
        // 本地没有数据，需要下载
        return true;
      }

      // 比较时间戳，云端数据更新时间比本地更新时间新
      const cloudTime = new Date(cloudTimestamp).getTime();
      const localTime = new Date(localTimestamp).getTime();
      
      const needUpdate = cloudTime > localTime;
      
      if (needUpdate) {
        console.log('🔄 云端数据更新时间:', cloudTimestamp, '本地数据更新时间:', localTimestamp);
      }
      
      return needUpdate;
    } catch (error) {
      console.error('检查云端数据更新失败:', error);
      return false;
    }
  }

  /**
   * 获取云端数据最后更新时间
   */
  private async getCloudDataTimestamp(): Promise<string | null> {
    try {
      const { auth } = store.getState();
      if (!auth.isAuthenticated) {
        return null;
      }

      // 直接查询云端数据的最新更新时间
      const { data: groups } = await supabase
        .from('tab_groups')
        .select('updated_at')
        .eq('user_id', auth.user?.id)
        .order('updated_at', { ascending: false })
        .limit(1);

      if (groups && groups.length > 0) {
        return groups[0].updated_at;
      }

      return null;
    } catch (error) {
      console.error('获取云端数据时间戳失败:', error);
      return null;
    }
  }

  /**
   * 获取本地数据最后更新时间
   */
  private async getLocalDataTimestamp(): Promise<string | null> {
    try {
      const localGroups = await storage.getGroups();
      if (localGroups.length === 0) {
        return null;
      }

      // 找到最新的本地数据更新时间
      const latestGroup = localGroups.reduce((latest, group) => {
        const latestTime = new Date(latest.updatedAt).getTime();
        const groupTime = new Date(group.updatedAt).getTime();
        return groupTime > latestTime ? group : latest;
      });

      return latestGroup.updatedAt;
    } catch (error) {
      console.error('获取本地数据时间戳失败:', error);
      return null;
    }
  }

  /**
   * 执行智能下载
   */
  private async performSmartDownload() {
    try {
      // 检查本地是否有数据
      const hasLocal = await syncService.hasLocalData();
      
      if (hasLocal) {
        // 本地有数据，使用覆盖模式确保数据一致性
        await syncService.downloadFromCloud(true, true); // background=true, overwrite=true
        console.log('✅ 智能下载完成（覆盖模式）');
      } else {
        // 本地没有数据，使用覆盖模式
        await syncService.downloadFromCloud(true, true); // background=true, overwrite=true
        console.log('✅ 智能下载完成（覆盖模式）');
      }
    } catch (error) {
      console.error('智能下载失败:', error);
      throw error;
    }
  }

  /**
   * 检查本地是否有未同步的数据
   */
  private async checkLocalChanges(): Promise<boolean> {
    try {
      const state = store.getState();
      const { lastSyncTime } = state.tabs;
      
      if (!lastSyncTime) {
        // 没有同步记录，认为有未同步的数据
        return true;
      }

      // 检查本地数据是否在最后同步时间之后有更新
      const localTimestamp = await this.getLocalDataTimestamp();
      if (!localTimestamp) {
        return false;
      }

      const localTime = new Date(localTimestamp).getTime();
      const syncTime = new Date(lastSyncTime).getTime();
      
      return localTime > syncTime;
    } catch (error) {
      console.error('检查本地变更失败:', error);
      return false;
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
    
    // 🔥 清理实时同步
    realtimeSync.destroy();
    
    console.log('🔄 自动同步管理器已销毁');
  }
}

// 创建全局实例
export const autoSyncManager = new AutoSyncManager();