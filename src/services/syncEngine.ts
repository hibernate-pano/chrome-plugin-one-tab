import { store } from '@/store';
import { getCurrentUser, setFromCache } from '@/store/slices/authSlice';
import type { TabGroup, UserSettings } from '@/types/tab';
import { storage } from '@/utils/storage';
import {
  downloadTabGroups,
  uploadTabGroups,
  markCloudGroupsAsDeleted,
} from '@/services/tabGroupSyncService';
import { uploadSettings, downloadSettings } from '@/services/settingsSyncService';
import { mergeTabGroups, validateMergeResult } from '@/utils/syncUtils';
import { errorHandler } from '@/utils/errorHandler';
import { validateThemeStyle, validateThemeMode } from '@/utils/storage';

// ── 类型 ───────────────────────────────────────────────────────────

export interface MergeResult {
  success: boolean;
  groups: TabGroup[];
  stats?: {
    localCount: number;
    cloudCount: number;
    mergedCount: number;
    conflicts: number;
  };
  reason?: string;
}

export interface UploadResult {
  success: boolean;
  error?: string;
}

export type SyncOperation = 'upload' | 'download' | 'none';

export type SyncProgressCallback = (progress: number, operation: SyncOperation) => void;

/** 与旧 settingsSlice.syncSettingsFromCloud 相同的合并/校验逻辑，供引擎内复用 */
async function mergeCloudSettingsIntoLocal(): Promise<void> {
  const cloudSettings = await downloadSettings();
  if (!cloudSettings) return;

  const state = store.getState() as { settings: UserSettings };
  const updatedDefault = state.settings;
  const convertedSettings: UserSettings = {
    ...updatedDefault,
    ...cloudSettings,
    themeStyle: validateThemeStyle(cloudSettings.themeStyle),
    themeMode: validateThemeMode(cloudSettings.themeMode),
  } as UserSettings;
  await storage.setSettings(convertedSettings);
}

// ── SyncEngine ──────────────────────────────────────────────────────

/**
 * SyncEngine — 同步层唯一入口。
 *
 * 设计原则：
 * 1. 所有云同步操作汇聚一处（Popup 上下文托管）
 * 2. 下载走「快照 → 下载 → 合并 → 验证 → 写入」，失败自动回滚到快照
 * 3. 上传把活跃组纯 upsert、软删组标记云端删除，永不无故删本地
 * 4. 由 autoSyncMiddleware 延迟调度，或由手动同步入口直接调用
 */
export class SyncEngine {
  private static instance: SyncEngine;
  private uploadTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingUpload = false;
  private isSyncing = false;

  private constructor() {}

  static getInstance(): SyncEngine {
    if (!SyncEngine.instance) SyncEngine.instance = new SyncEngine();
    return SyncEngine.instance;
  }

  getIsSyncing(): boolean {
    return this.isSyncing;
  }

  hasPendingUpload(): boolean {
    return this.pendingUpload;
  }

  cancelPendingUpload(): void {
    if (this.uploadTimer) {
      clearTimeout(this.uploadTimer);
      this.uploadTimer = null;
    }
    this.pendingUpload = false;
  }

  /**
   * 调度延迟上传。autoSyncMiddleware 调用此方法，带优先级防抖。
   * @param delayMs 延迟毫秒数（默认 3000ms）
   */
  scheduleUpload(delayMs: number = 3000): void {
    if (this.uploadTimer) clearTimeout(this.uploadTimer);
    this.pendingUpload = true;
    this.uploadTimer = setTimeout(async () => {
      try {
        await this.upload();
      } catch (err) {
        console.error('[SyncEngine] 延迟上传失败:', err);
      } finally {
        this.uploadTimer = null;
        this.pendingUpload = false;
      }
    }, delayMs);
  }

  /**
   * 从云端下载并合并到本地。
   * 安全流水线：快照 → 下载 → 合并 → 验证 → 写入；任一步失败自动回滚。
   * @param opts.forceRemote 是否强制用云端数据覆盖本地
   */
  async downloadAndMerge(opts?: {
    forceRemote?: boolean;
    syncSettings?: boolean;
    onProgress?: SyncProgressCallback;
  }): Promise<MergeResult> {
    const state = store.getState() as { auth: { isAuthenticated: boolean }; settings: UserSettings };
    if (!state.auth.isAuthenticated) {
      return { success: false, groups: [], reason: 'not_authenticated' };
    }
    if (this.isSyncing) {
      return { success: false, groups: [], reason: 'already_syncing' };
    }

    const report = opts?.onProgress || (() => {});
    this.isSyncing = true;
    this.cancelPendingUpload();

    // 1. 快照
    let snapshot: TabGroup[] = [];
    try {
      snapshot = await storage.getGroups();
      await storage.setSyncSnapshot(snapshot);
    } catch (err) {
      console.error('[SyncEngine] 快照保存失败:', err);
    }

    try {
      report(10, 'download');
      // 2. 下载云端
      const cloudGroups = await downloadTabGroups();
      report(55, 'download');
      // 3. 确定本地
      const localGroups = opts?.forceRemote ? [] : snapshot;
      // 3.5 覆盖模式：同步设置（与旧 smartSyncService 的 overwriteLocal 行为一致）
      if (opts?.forceRemote && opts?.syncSettings) {
        try {
          await mergeCloudSettingsIntoLocal();
        } catch (err) {
          console.warn('[SyncEngine] 覆盖下载时同步设置失败（不阻塞主流程）:', err);
        }
      }
      // 4. 合并
      const mergedGroups = mergeTabGroups(
        localGroups,
        cloudGroups,
        state.settings.syncStrategy || 'newest'
      );
      report(80, 'download');
      // 5. 验证
      const validation = validateMergeResult(localGroups, cloudGroups, mergedGroups);
      if (!validation.valid) {
        console.error(`[SyncEngine] 合并验证失败: ${validation.reason}`);
        await this.restoreSnapshot(snapshot);
        this.isSyncing = false;
        return { success: false, groups: snapshot, reason: `validation_failed: ${validation.reason}` };
      }
      // 6. 写入
      await storage.setGroups(mergedGroups);
      // 7. 更新同步时间
      await storage.setLastSyncTime(new Date().toISOString());
      // 8. 清除快照
      await storage.clearSyncSnapshot();
      report(100, 'none');

      this.isSyncing = false;
      return {
        success: true,
        groups: mergedGroups,
        stats: {
          localCount: localGroups.length,
          cloudCount: cloudGroups.length,
          mergedCount: mergedGroups.length,
          conflicts: mergedGroups.filter(g => g.syncStatus === 'conflict').length,
        },
      };
    } catch (error) {
      console.error('[SyncEngine] 下载合并失败:', error);
      await this.restoreSnapshot(snapshot);
      this.isSyncing = false;
      return {
        success: false,
        groups: snapshot,
        reason: error instanceof Error ? error.message : 'download_merge_failed',
      };
    }
  }

  /**
   * 上传本地数据到云端。
   * 流程：读取 → 分离活跃组/软删 ID → 上传活跃组 → 标记云端软删。
   * 失败不影响本地数据。
   * @param opts.includeDeleted 是否包含软删标记（deleteAllGroups 场景）
   */
  async upload(opts?: {
    includeDeleted?: boolean;
    overwriteCloud?: boolean;
    syncSettings?: boolean;
    onProgress?: SyncProgressCallback;
  }): Promise<UploadResult> {
    let state = store.getState() as { auth: { isAuthenticated: boolean; user: { id: string; email: string } | null }; settings: UserSettings };
    // ponytail: SW 进程是独立执行上下文，store 是新实例。TabManager.saveAllTabs 后
    // 自动调 scheduleUpload() 时 SW store 中 isAuthenticated 仍为 false——
    // 这里懒恢复一次登录态（从 chrome.storage.local 里的 supabase session 读）。
    // backgroundSync.performBackgroundSync 先调过一次，此处二次调用是 no-op。
    if (!state.auth.isAuthenticated) {
      const user = await store.dispatch(getCurrentUser()).unwrap().catch(() => null);
      if (user) store.dispatch(setFromCache({ user, isAuthenticated: true }));
      state = store.getState() as typeof state;
    }
    if (!state.auth.isAuthenticated) {
      return { success: false, error: '用户未登录' };
    }
    if (this.isSyncing) {
      return { success: false, error: '正在同步中' };
    }

    const report = opts?.onProgress || (() => {});
    this.isSyncing = true;
    this.cancelPendingUpload();

    try {
      report(15, 'upload');
      const allGroups = await storage.getGroups();
      const activeGroups = allGroups.filter(g => !g.isDeleted);
      const deletedIds = allGroups.filter(g => g.isDeleted).map(g => g.id);

      const overwriteCloud = opts?.overwriteCloud || false;
      if (activeGroups.length > 0) {
        await uploadTabGroups(activeGroups, overwriteCloud);
      } else if (overwriteCloud) {
        // ponytail: 与旧 uploadTabsToCloudFlow 的空本地保护一致——本地没有任何活跃组时
        // 绝不执行覆盖模式（覆盖 = 先删云端全部再插），否则会把云端数据清空。
        console.warn('[SyncEngine] 覆盖上传被跳过：本地没有活跃组（保留云端数据）');
      }
      report(70, 'upload');
      if (deletedIds.length > 0 && opts?.includeDeleted !== false) {
        try {
          await markCloudGroupsAsDeleted(deletedIds);
        } catch (err) {
          console.error('[SyncEngine] 标记云端软删失败（不阻塞主流程）:', err);
        }
      }
      // 设置同步：与旧 smartSyncService.uploadToCloud 一致（上传标签组后总带上传设置）
      if (opts?.syncSettings) {
        try {
          await uploadSettings(state.settings);
        } catch (err) {
          console.warn('[SyncEngine] 上传设置失败（不阻塞主流程）:', err);
        }
      }
      report(95, 'upload');

      await storage.setLastSyncTime(new Date().toISOString());
      report(100, 'none');
      this.isSyncing = false;
      return { success: true };
    } catch (error) {
      console.error('[SyncEngine] 上传失败:', error);
      this.isSyncing = false;
      errorHandler.handle(error as Error, {
        showToast: false,
        logToConsole: true,
        severity: 'medium',
        fallbackMessage: '数据上传失败',
      });
      return { success: false, error: error instanceof Error ? error.message : '上传失败' };
    }
  }

  /**
   * 等本地 groups 加载完成（Race condition 保护）。
   * popup 打开后触发自动下载时，若 loadGroups 尚未把本地数据写回 Redux，则等待。
   */
  async waitForGroupsLoaded(timeoutMs: number = 5000): Promise<boolean> {
    if (!store.getState().tabs.isLoading) return true;
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => {
        unsubscribe();
        resolve(false);
      }, timeoutMs);
      const unsubscribe = store.subscribe(() => {
        if (!store.getState().tabs.isLoading) {
          clearTimeout(timer);
          unsubscribe();
          resolve(true);
        }
      });
    });
  }

  // ── 私有 ─────────────────────────────────────────────────────────

  private async restoreSnapshot(snapshot: TabGroup[]): Promise<void> {
    if (snapshot.length === 0) {
      console.warn('[SyncEngine] 快照为空，跳过回滚（保持本地数据不变）');
      return;
    }
    try {
      await storage.setGroups(snapshot);
      await storage.clearSyncSnapshot();
      console.log(`[SyncEngine] 已从快照恢复 ${snapshot.length} 个组`);
    } catch (err) {
      console.error('[SyncEngine] 快照回滚失败:', err);
      try {
        await storage.setGroups(snapshot);
      } catch (retryErr) {
        console.error('[SyncEngine] 二次回滚也失败，数据可能丢失:', retryErr);
      }
    }
  }
}

/** 便捷导出单例 */
export const syncEngine = SyncEngine.getInstance();
