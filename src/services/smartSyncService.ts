import { store } from '@/store';
import { syncTabsToCloud, syncTabsFromCloud } from '@/store/slices/tabSlice';
import { syncSettingsToCloud, syncSettingsFromCloud } from '@/store/slices/settingsSlice';
import { getCurrentUser } from '@/store/slices/authSlice';
import { downloadTabGroups } from '@/services/tabGroupSyncService';
import { storage } from '@/utils/storage';
import { errorHandler } from '@/utils/errorHandler';
import { cancelPendingSync, hasPendingSync } from '@/utils/syncHelpers';

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
    return this.isSyncing;
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

  async uploadToCloud(background = false, overwriteCloud = false) {
    const { auth } = store.getState();
    if (!auth.isAuthenticated) {
      return { success: false, error: '用户未登录' };
    }

    if (this.isSyncing) {
      return { success: false, error: '正在同步中' };
    }

    this.isSyncing = true;
    cancelPendingSync();

    try {
      await store.dispatch(syncTabsToCloud({ background, overwriteCloud }));
      await store.dispatch(syncSettingsToCloud());

      const syncTime = new Date().toISOString();
      await storage.setLastSyncTime(syncTime);
      this.lastSyncTime = syncTime;

      return { success: true };
    } catch (error) {
      errorHandler.handle(error as Error, {
        showToast: false,
        logToConsole: true,
        severity: 'medium',
        fallbackMessage: '数据上传失败',
      });

      try {
        await store.dispatch(getCurrentUser());
      } catch {
        // 忽略当前用户刷新失败
      }

      return { success: false, error: error instanceof Error ? error.message : '上传失败' };
    } finally {
      this.isSyncing = false;
    }
  }

  async downloadFromCloud(background = false, overwriteLocal = false) {
    const { auth } = store.getState();
    if (!auth.isAuthenticated) {
      return { success: false, error: '用户未登录' };
    }

    if (this.isSyncing) {
      return { success: false, error: '正在同步中' };
    }

    this.isSyncing = true;
    cancelPendingSync();

    try {
      if (overwriteLocal) {
        await store.dispatch(syncSettingsFromCloud());
      }

      await store.dispatch(
        syncTabsFromCloud({ background, forceRemoteStrategy: overwriteLocal })
      );

      const syncTime = new Date().toISOString();
      await storage.setLastSyncTime(syncTime);
      this.lastSyncTime = syncTime;

      return { success: true };
    } catch (error) {
      errorHandler.handle(error as Error, {
        showToast: false,
        logToConsole: true,
        severity: 'medium',
        fallbackMessage: '从云端下载数据失败',
      });

      try {
        await store.dispatch(getCurrentUser());
      } catch {
        // 忽略当前用户刷新失败
      }

      return { success: false, error: error instanceof Error ? error.message : '下载失败' };
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 自动后台下载：App 打开时静默拉取云端数据。
   * 带 2 分钟冷却 + 并发控制，避免与手动同步/自动上传冲突。
   */
  async maybeAutoDownload(): Promise<void> {
    const { auth } = store.getState();
    if (!auth.isAuthenticated) return;
    if (this.isSyncing) return;
    if (hasPendingSync()) return;

    // 冷却检查：2 分钟内有过同步则跳过
    if (this.lastSyncTime) {
      const elapsed = Date.now() - new Date(this.lastSyncTime).getTime();
      if (elapsed < 2 * 60 * 1000) return;
    }

    this.isSyncing = true;
    cancelPendingSync();

    try {
      await store.dispatch(
        syncTabsFromCloud({ background: true, forceRemoteStrategy: false })
      );
      await store.dispatch(syncSettingsFromCloud());

      const syncTime = new Date().toISOString();
      await storage.setLastSyncTime(syncTime);
      this.lastSyncTime = syncTime;
    } catch {
      // 静默失败，不影响用户体验
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 自动后台上传：本地变更时静默推送到云端。
   * 带 2 分钟冷却 + 并发控制。
   */
  async maybeAutoUpload(): Promise<void> {
    const { auth } = store.getState();
    if (!auth.isAuthenticated) return;
    if (this.isSyncing) return;
    if (hasPendingSync()) return;

    // 冷却检查：2 分钟内有过同步则跳过
    if (this.lastSyncTime) {
      const elapsed = Date.now() - new Date(this.lastSyncTime).getTime();
      if (elapsed < 2 * 60 * 1000) return;
    }

    this.isSyncing = true;
    cancelPendingSync();

    try {
      await store.dispatch(syncTabsToCloud({ background: true, overwriteCloud: false }));
      await store.dispatch(syncSettingsToCloud());

      const syncTime = new Date().toISOString();
      await storage.setLastSyncTime(syncTime);
      this.lastSyncTime = syncTime;
    } catch {
      // 静默失败
    } finally {
      this.isSyncing = false;
    }
  }

  getSyncStatus() {
    return {
      lastSyncTime: this.lastSyncTime,
      isSyncing: this.isSyncing,
    };
  }
}

export const smartSyncService = SmartSyncService.getInstance();
