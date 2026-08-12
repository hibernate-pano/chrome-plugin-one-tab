/**
 * SmartSyncService — 智能同步服务（并发锁 + 便捷方法）
 *
 * 仅支持手动同步：核心逻辑委托给 SyncEngine。
 * 已移除所有自动同步功能（自动下载 / 自动上传）。
 */

import { store } from '@/store';
import { setGroups } from '@/store/slices/tabSlice';
import { syncSettingsToCloud, syncSettingsFromCloud } from '@/store/slices/settingsSlice';
import { getCurrentUser } from '@/store/slices/authSlice';
import { downloadTabGroups } from '@/services/tabGroupSyncService';
import { syncEngine } from '@/services/syncEngine';
import { storage } from '@/utils/storage';
import { errorHandler } from '@/utils/errorHandler';

class SmartSyncService {
  private static instance: SmartSyncService;
  private lastSyncTime: string | null = null;
  private isSyncing = false;

  private constructor() {}

  static getInstance(): SmartSyncService {
    if (!SmartSyncService.instance) {
      SmartSyncService.instance = new SmartSyncService();
    }
    return SmartSyncService.instance;
  }

  async initialize() {
    this.lastSyncTime = await storage.getLastSyncTime();
  }

  getLastSyncTime(): string | null {
    return this.lastSyncTime;
  }

  getIsSyncing(): boolean {
    return this.isSyncing || syncEngine.getIsSyncing();
  }

  async hasCloudData() {
    try {
      const cloudGroups = await downloadTabGroups();
      return cloudGroups.length > 0;
    } catch {
      return false;
    }
  }

  async hasLocalData() {
    try {
      const localGroups = await storage.getGroupsOrThrow();
      return localGroups.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * 上传到云端（委托 SyncEngine）
   */
  async uploadToCloud(_background = false, _overwriteCloud = false) {
    const { auth } = store.getState();
    if (!auth.isAuthenticated) {
      return { success: false, error: '用户未登录' };
    }

    if (this.isSyncing || syncEngine.getIsSyncing()) {
      return { success: false, error: '正在同步中' };
    }

    this.isSyncing = true;

    try {
      const result = await syncEngine.upload();
      if (result.success) {
        await store.dispatch(syncSettingsToCloud());
        await storage.setLastSyncTime(new Date().toISOString());
        this.lastSyncTime = new Date().toISOString();
      }
      return result;
    } catch (error) {
      errorHandler.handle(error as Error, {
        showToast: false,
        logToConsole: true,
        severity: 'medium',
        fallbackMessage: '数据上传失败',
      });
      try {
        await store.dispatch(getCurrentUser());
      } catch { /* 忽略 */ }
      return { success: false, error: error instanceof Error ? error.message : '上传失败' };
    } finally {
      this.isSyncing = false;
    }
  }

  /** 从云端下载（委托 SyncEngine） */
  async downloadFromCloud(_background = false, overwriteLocal = false) {
    const { auth } = store.getState();
    if (!auth.isAuthenticated) {
      return { success: false, error: '用户未登录' };
    }

    if (this.isSyncing || syncEngine.getIsSyncing()) {
      return { success: false, error: '正在同步中' };
    }

    this.isSyncing = true;

    try {
      if (overwriteLocal) {
        await store.dispatch(syncSettingsFromCloud());
      }

      const result = await syncEngine.downloadAndMerge({
        forceRemote: overwriteLocal,
      });

      if (result.success) {
        // 更新 Redux 状态
        store.dispatch(setGroups(result.groups));

        await store.dispatch(syncSettingsFromCloud());
        await storage.setLastSyncTime(new Date().toISOString());
        this.lastSyncTime = new Date().toISOString();
      }
      return { success: result.success, error: result.success ? undefined : result.reason };
    } catch (error) {
      errorHandler.handle(error as Error, {
        showToast: false,
        logToConsole: true,
        severity: 'medium',
        fallbackMessage: '从云端下载数据失败',
      });
      try {
        await store.dispatch(getCurrentUser());
      } catch { /* 忽略 */ }
      return { success: false, error: error instanceof Error ? error.message : '下载失败' };
    } finally {
      this.isSyncing = false;
    }
  }

  getSyncStatus() {
    return {
      lastSyncTime: this.lastSyncTime,
      isSyncing: this.isSyncing || syncEngine.getIsSyncing(),
    };
  }
}

export const smartSyncService = SmartSyncService.getInstance();
