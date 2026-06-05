/**
 * SmartSyncService — 智能同步服务（冷却控制 + 并发锁）
 *
 * v1.12.0 重构：核心同步逻辑委托给 SyncEngine，
 * SmartSyncService 仅保留冷却窗口、并发控制和便捷方法。
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

  /** 冷却检查：上次同步在 2 分钟内则跳过 */
  private isInCooldown(): boolean {
    if (!this.lastSyncTime) return false;
    const elapsed = Date.now() - new Date(this.lastSyncTime).getTime();
    return elapsed < 2 * 60 * 1000;
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
      const localGroups = await storage.getGroups();
      return localGroups.length > 0;
    } catch {
      return false;
    }
  }

  /** 上传到云端（委托 SyncEngine） */
  async uploadToCloud(_background = false, _overwriteCloud = false) {
    const { auth } = store.getState();
    if (!auth.isAuthenticated) {
      return { success: false, error: '用户未登录' };
    }

    if (this.isSyncing || syncEngine.getIsSyncing()) {
      return { success: false, error: '正在同步中' };
    }

    this.isSyncing = true;
    syncEngine.cancelPendingUpload();

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
    syncEngine.cancelPendingUpload();

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

  /**
   * 自动后台下载：Popup 打开时静默拉取云端数据。
   * 带 2 分钟冷却 + 并发控制 + race 保护。
   */
  async maybeAutoDownload(): Promise<void> {
    const { auth } = store.getState();
    if (!auth.isAuthenticated) return;
    if (this.isSyncing || syncEngine.getIsSyncing()) return;
    if (syncEngine.hasPendingUpload()) return;
    if (this.isInCooldown()) return;

    // race 保护：等待 loadGroups 完成
    const loaded = await syncEngine.waitForGroupsLoaded(5000);
    if (!loaded) {
      console.warn('[SmartSync] 等待 loadGroups 超时，跳过自动下载');
      return;
    }

    this.isSyncing = true;
    syncEngine.cancelPendingUpload();

    try {
      const result = await syncEngine.downloadAndMerge({ forceRemote: false });
      if (result.success) {
        store.dispatch(setGroups(result.groups));
        await store.dispatch(syncSettingsFromCloud());
        await storage.setLastSyncTime(new Date().toISOString());
        this.lastSyncTime = new Date().toISOString();
      }
    } catch {
      // 静默失败
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 自动后台上传：本地变更时静默推送到云端。
   * 由 autoSyncMiddleware 触发。
   */
  async maybeAutoUpload(): Promise<void> {
    const { auth } = store.getState();
    if (!auth.isAuthenticated) return;
    if (this.isSyncing || syncEngine.getIsSyncing()) return;
    if (syncEngine.hasPendingUpload()) return;
    if (this.isInCooldown()) return;

    this.isSyncing = true;
    syncEngine.cancelPendingUpload();

    try {
      await syncEngine.upload();
      await store.dispatch(syncSettingsToCloud());
      await storage.setLastSyncTime(new Date().toISOString());
      this.lastSyncTime = new Date().toISOString();
    } catch {
      // 静默失败
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
