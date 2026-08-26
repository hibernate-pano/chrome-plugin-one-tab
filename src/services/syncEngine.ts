import { store } from '@/store';
import { getCurrentUser, setFromCache } from '@/store/slices/authSlice';

/** MV3 SW 中由 chrome.alarms 驱动的延迟上传 alarm。 */
export const SYNC_UPLOAD_ALARM = 'tapstack-scheduled-upload';

/**
 * 上传保护窗口。本地刚刚完成上传的时间窗口内，后台下载合并跳过——避免
 * MV3 SW 中 chrome.alarms 的上传（30s）与轮询（60s）偶尔同时触发时下载
 * 在上传完成前用云端旧版本覆盖本地新版本。forceRemote 手动下载不受限。
 */
export const UPLOAD_GUARD_MS = 35_000;
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
  // ponytail: pending_upload 状态完全由 storage 持久化（跨进程跨 SW 重启保留），
  // 不再需要内存字段。hasPendingUpload() async 版本读 storage。
  private isSyncing = false;

  private constructor() {}

  static getInstance(): SyncEngine {
    if (!SyncEngine.instance) SyncEngine.instance = new SyncEngine();
    return SyncEngine.instance;
  }

  getIsSyncing(): boolean {
    return this.isSyncing;
  }

  /**
   * ponytail: 读持久化 pending_upload。MV3 popup 失焦销毁后内存实例消失，
   * storage 中的标志仍在——下一次后台 alarm 起来的 SW 能读到这个事实
   * 先上传。backgroundSync.performBackgroundSync 调用此方法决定是否
   * “先上传后下载”。
   */
  async hasPendingUpload(): Promise<boolean> {
    try {
      return await storage.getPendingUpload();
    } catch {
      return false;
    }
  }

  cancelPendingUpload(): void {
    // ponytail: 仅取消当前 timer/alarm，不动持久化 pending_upload 标志——
    // “本地有未上传变更”这个事实跨进程跨 SW 重启仍应保留，否则 downloadAndMerge
    // 会清掉所有上传意图、云端旧版本被合并后本地新版本被覆盖（“复活”）。
    if (this.uploadTimer) {
      clearTimeout(this.uploadTimer);
      this.uploadTimer = null;
    }
    if (typeof chrome !== 'undefined' && chrome.alarms) {
      void chrome.alarms.clear(SYNC_UPLOAD_ALARM).catch(() => {});
    }
  }

  /**
   * 调度延迟上传。autoSyncMiddleware 调用此方法，带优先级防抖。
   * @param delayMs 延迟毫秒数（默认 3000ms）
   */
  scheduleUpload(delayMs: number = 3000): void {
    // ponytail: MV3 SW 可能在 idle 后被杀，setTimeout 会永远丢——手动“点开
    // 一个标签”这类操作可能上传不到云端，然后后台 60s 轮询下来云端仍为旧版本，
    // 本地新版本被“复活”。同时持久化“本地有变更”标志，让 downloadAndMerge
    // 后能重新调度，backgroundSync 也能在下载前先上传。
    // chrome.alarms 最小 delayInMinutes 是 0.5（30s），足够合并同 tick 多次调度。
    void storage.setPendingUpload(true);
    if (typeof chrome !== 'undefined' && chrome.alarms) {
      void chrome.alarms.clear(SYNC_UPLOAD_ALARM).catch(() => {});
      const delayMinutes = Math.max(0.5, delayMs / 60000);
      chrome.alarms.create(SYNC_UPLOAD_ALARM, { delayInMinutes: delayMinutes });
      return;
    }
    // 非扩展运行时 fallback：单测可走这里
    if (this.uploadTimer) clearTimeout(this.uploadTimer);
    this.uploadTimer = setTimeout(() => {
      this.uploadTimer = null;
      void this.upload().catch(err => console.error('[SyncEngine] 延迟上传失败:', err));
    }, delayMs);
  }

  /**
   * 由 chrome.alarms.onAlarm 回调。fire-and-forget；错误靠 console.error 报。
   */
  async runScheduledUpload(): Promise<void> {
    try {
      await this.upload();
    } catch (err) {
      console.error('[SyncEngine] alarm 驱动上传失败:', err);
    }
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

    // ponytail: 上传窗口保护。chrome.alarms 驱动上传 30s 最小间隔内，
    // 如果后台 60s 轮询 alarm 也几乎同时触发，可能在上传完成前先下载并
    // 用云端旧版本覆盖本地新版本。这里检查最近上传时间戳，若窗口内则跳过
    // 下载合并（除非 forceRemote 显式要求覆盖）。
    if (!opts?.forceRemote) {
      try {
        const lastUp = await storage.getLastSyncTime();
        if (lastUp) {
          const sinceUp = Date.now() - new Date(lastUp).getTime();
          // UPLOAD_GUARD_MS 窗口内的轮询跳过（上传在背景运行，让它先完成）
          if (sinceUp >= 0 && sinceUp < UPLOAD_GUARD_MS) {
            console.log(`[SyncEngine] 最近 ${Math.round(sinceUp / 1000)}s 内刚上传过，跳过本次下载（避免覆盖本地新版本）`);
            this.isSyncing = false;
            return { success: false, groups: [], reason: 'recent_upload_guard' };
          }
        }
      } catch (e) {
        // storage 读失败不阻塞主流程
      }
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
      // ponytail: 下载可能掩盖本地未上传变更（合并出“新增”项）。检查持久化
      // pending_upload：若仍 true，表明本地有未传云端的意图，重新调度一次上传
      // 让后台按“下载后上传”顺序把所有本地变更推到云端。避免云端在“删除/点开”
      // 后仍为旧状态供下次下载复活本地。
      try {
        const stillPending = await storage.getPendingUpload();
        if (stillPending) {
          console.log('[SyncEngine] 下载完成但本地仍有未上传变更，重新调度上传');
          this.scheduleUpload(0);
        }
      } catch {}
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
    // ponytail: 后台轮询同步路径专用——跳过 cancelPendingUpload 短路、跳过
    // isSyncing 检查（backgroundSync 路径互不冲突）。常规 UI 调用无需此参数。
    forcePending?: boolean;
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
    // ponytail: 后台轮询路径可带 forcePending 绕过 isSyncing 检查；
    // 但仅在不与当前下载合并冲突时调用（backgroundSync 已先检查）。
    if (this.isSyncing && !opts?.forcePending) {
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
      const now = new Date().toISOString();
      await storage.setLastUploadTime(now);
      // ponytail: 上传成功才清持久化 pending_upload。失败时保留，下一轮
      // alarm / 后台轮询重新尝试。cancelPendingUpload 不清这个标志——
      // “本地有变更”这个事实在 upload 真正成功前都成立。
      await storage.setPendingUpload(false);
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
