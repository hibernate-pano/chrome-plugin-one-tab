import { store } from '@/store';
import { syncTabsToCloud, syncTabsFromCloud } from '@/store/slices/tabSlice';
import { syncSettingsToCloud, syncSettingsFromCloud } from '@/store/slices/settingsSlice';
import { getCurrentUser } from '@/store/slices/authSlice';
import { sync as supabaseSync } from '@/utils/supabase';
import { storage } from '@/utils/storage';
import { errorHandler } from '@/utils/errorHandler';

/**
 * 简化的同步服务 - 仅支持手动同步
 * 已移除所有自动同步功能（定时同步、变化监听、启动同步）
 */
class SmartSyncService {
  private static instance: SmartSyncService;
  private lastSyncTime: string | null = null;
  private isSyncing = false; // 同步锁：防止并发同步
  
  private constructor() {
    // 初始化
  }
  
  static getInstance(): SmartSyncService {
    if (!SmartSyncService.instance) {
      SmartSyncService.instance = new SmartSyncService();
    }
    return SmartSyncService.instance;
  }
  
  // 初始化同步服务（简化版 - 仅加载最后同步时间）
  async initialize() {
    console.log('同步服务初始化 - 仅支持手动同步');
    
    // 获取最后同步时间
    this.lastSyncTime = await storage.getLastSyncTime();
  }
  
  // 检查云端是否有数据
  async hasCloudData() {
    try {
      const cloudGroups = await supabaseSync.downloadTabGroups();
      return cloudGroups.length > 0;
    } catch (error) {
      errorHandler.handle(error as Error, {
        showToast: false,
        logToConsole: true,
        severity: 'low',
        fallbackMessage: '检查云端数据失败'
      });
      return false;
    }
  }
  
  // 检查本地是否有数据
  async hasLocalData() {
    try {
      const localGroups = await storage.getGroups();
      return localGroups.length > 0;
    } catch (error) {
      errorHandler.handle(error as Error, {
        showToast: false,
        logToConsole: true,
        severity: 'low',
        fallbackMessage: '检查本地数据失败'
      });
      return false;
    }
  }
  
  // 手动上传数据到云端
  async uploadToCloud(background = false, overwriteCloud = false) {
    const { auth } = store.getState();
    
    if (!auth.isAuthenticated) {
      console.warn('[ManualSync] 用户未登录，无法上传数据到云端');
      return { success: false, error: '用户未登录' };
    }
    
    // 检查是否正在同步
    if (this.isSyncing) {
      console.warn('[ManualSync] 正在同步中，请稍后再试');
      return { success: false, error: '正在同步中，请稍后再试' };
    }
    
    // 设置同步锁
    this.isSyncing = true;
    console.log('[ManualSync] 开始手动上传到云端');
    
    try {
      // 上传数据到云端
      await store.dispatch(syncTabsToCloud({ background, overwriteCloud }));
      await store.dispatch(syncSettingsToCloud());
      
      // 更新最后同步时间
      const syncTime = new Date().toISOString();
      await storage.setLastSyncTime(syncTime);
      this.lastSyncTime = syncTime;
      
      console.log('[ManualSync] 上传完成');
      return { success: true };
    } catch (error) {
      errorHandler.handle(error as Error, {
        showToast: false,
        logToConsole: true,
        severity: 'medium',
        fallbackMessage: '数据上传失败'
      });
      
      // 尝试重新获取用户信息，可能是会话过期
      try {
        await store.dispatch(getCurrentUser());
      } catch (e) {
        errorHandler.handle(e as Error, {
          showToast: false,
          logToConsole: true,
          severity: 'low',
          fallbackMessage: '重新获取用户信息失败'
        });
      }
      return { success: false, error: error instanceof Error ? error.message : '上传失败' };
    } finally {
      // 释放同步锁
      this.isSyncing = false;
      console.log('[ManualSync] 上传操作完成，同步锁已释放');
    }
  }
  
  // 手动从云端下载数据
  async downloadFromCloud(background = false, overwriteLocal = false) {
    const { auth } = store.getState();
    
    if (!auth.isAuthenticated) {
      console.warn('[ManualSync] 用户未登录，无法从云端下载数据');
      return { success: false, error: '用户未登录' };
    }
    
    // 检查是否正在同步
    if (this.isSyncing) {
      console.warn('[ManualSync] 正在同步中，请稍后再试');
      return { success: false, error: '正在同步中，请稍后再试' };
    }
    
    // 设置同步锁
    this.isSyncing = true;
    console.log('[ManualSync] 开始手动从云端下载');
    
    try {
      // 从云端下载数据
      if (overwriteLocal) {
        // 覆盖模式：设置与标签全部以云端为主
        await store.dispatch(syncSettingsFromCloud());
      } else {
        // 合并模式：仅合并标签数据，保留本地设置（含主题）
        console.log('[ManualSync] 合并模式：跳过设置同步，保留本地配置');
      }

      await store.dispatch(syncTabsFromCloud({ background, forceRemoteStrategy: overwriteLocal }));
      
      // 更新最后同步时间
      const syncTime = new Date().toISOString();
      await storage.setLastSyncTime(syncTime);
      this.lastSyncTime = syncTime;
      
      console.log('[ManualSync] 下载完成');
      return { success: true };
    } catch (error) {
      errorHandler.handle(error as Error, {
        showToast: false,
        logToConsole: true,
        severity: 'medium',
        fallbackMessage: '从云端下载数据失败'
      });
      
      // 尝试重新获取用户信息，可能是会话过期
      try {
        await store.dispatch(getCurrentUser());
      } catch (e) {
        errorHandler.handle(e as Error, {
          showToast: false,
          logToConsole: true,
          severity: 'low',
          fallbackMessage: '重新获取用户信息失败'
        });
      }
      return { success: false, error: error instanceof Error ? error.message : '下载失败' };
    } finally {
      // 释放同步锁
      this.isSyncing = false;
      console.log('[ManualSync] 下载操作完成，同步锁已释放');
    }
  }
  
  // 获取同步状态
  getSyncStatus() {
    return {
      lastSyncTime: this.lastSyncTime,
      isSyncing: this.isSyncing
    };
  }
}

// 导出单例实例
export const smartSyncService = SmartSyncService.getInstance();
