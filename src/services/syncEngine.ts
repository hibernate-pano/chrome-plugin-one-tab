/**
 * SyncEngine — 同步层唯一入口
 *
 * 设计原则：
 * 1. 所有云同步操作经过此处（Popup 上下文）
 * 2. Service Worker 不再执行任何同步逻辑
 * 3. 合并前快照 → 合并后验证 → 失败自动回滚
 * 4. 上传使用纯 upsert（无三步覆盖法），删除通过软删标记传播
 *
 * 使用方：
 * - smartSyncService（冷却 + 并发锁）→ 委托 SyncEngine
 * - syncService（手动同步入口）→ 委托 SyncEngine
 * - autoSyncMiddleware（延迟调度）→ syncEngine.scheduleUpload()
 * - AuthProvider（自动下载）→ syncEngine.downloadAndMerge()
 */

import { store } from '@/store';
import type { TabGroup, UserSettings } from '@/types/tab';
import { storage } from '@/utils/storage';
import { downloadTabGroups, uploadTabGroups, markCloudGroupsAsDeleted } from '@/services/tabGroupSyncService';
import { mergeTabGroups, validateMergeResult } from '@/utils/syncUtils';
import { errorHandler } from '@/utils/errorHandler';
import { cleanupCloudTombstones } from '@/utils/tombstoneGc';

// ── 类型 ───────────────────────────────────────────────────────────

export interface MergeResult {
  success: boolean;
  groups: TabGroup[];
  /** 合并统计 */
  stats?: {
    localCount: number;
    cloudCount: number;
    mergedCount: number;
    conflicts: number;
  };
  /** 失败原因（success=false 时） */
  reason?: string;
}

export interface UploadResult {
  success: boolean;
  error?: string;
}

// ── SyncEngine ──────────────────────────────────────────────────────

export class SyncEngine {
  private static instance: SyncEngine;
  private uploadTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingUpload = false;
  private isSyncing = false;

  private constructor() {}

  static getInstance(): SyncEngine {
    if (!SyncEngine.instance) {
      SyncEngine.instance = new SyncEngine();
    }
    return SyncEngine.instance;
  }

  // ── 公开方法 ─────────────────────────────────────────────────────

  /** 当前是否正在同步（供外部并发控制） */
  getIsSyncing(): boolean {
    return this.isSyncing;
  }

  /** 是否有待执行的延迟上传 */
  hasPendingUpload(): boolean {
    return this.pendingUpload;
  }

  /** 取消待执行的延迟上传 */
  cancelPendingUpload(): void {
    if (this.uploadTimer) {
      clearTimeout(this.uploadTimer);
      this.uploadTimer = null;
    }
    this.pendingUpload = false;
  }

  /**
   * 下载云端数据并与本地合并
   *
   * 安全流水线：
   *   快照 → 下载 → 合并 → 验证 → 写入
   *   任一步骤失败 → 自动回滚到快照
   *
   * @param opts.forceRemote 是否强制使用云端数据（覆盖本地）
   */
  async downloadAndMerge(opts?: { forceRemote?: boolean }): Promise<MergeResult> {
    const { auth } = store.getState();
    if (!auth.isAuthenticated) {
      return { success: false, groups: [], reason: 'not_authenticated' };
    }

    if (this.isSyncing) {
      return { success: false, groups: [], reason: 'already_syncing' };
    }

    this.isSyncing = true;
    this.cancelPendingUpload();

    // 1. 快照
    let snapshot: TabGroup[] = [];
    try {
      snapshot = await storage.getGroups();
      await storage.setSyncSnapshot(snapshot);
      console.log(`[SyncEngine] 快照已保存: ${snapshot.length} 个组`);
    } catch (err) {
      console.error('[SyncEngine] 快照保存失败:', err);
      // 快照失败不阻塞——继续执行，但无法回滚
    }

    try {
      // 2. 下载云端数据
      const cloudGroups = await downloadTabGroups();
      console.log(`[SyncEngine] 云端: ${cloudGroups.length} 个组`);

      // 3. 确定本地数据
      const localGroups = opts?.forceRemote ? [] : snapshot;
      console.log(`[SyncEngine] 本地: ${localGroups.length} 个组`);

      // 4. 合并
      const settings = store.getState().settings as UserSettings;
      const mergedGroups = mergeTabGroups(
        localGroups,
        cloudGroups,
        settings.syncStrategy || 'newest'
      );
      console.log(`[SyncEngine] 合并后: ${mergedGroups.length} 个组`);

      // 5. 验证
      const validation = validateMergeResult(localGroups, cloudGroups, mergedGroups);
      if (!validation.valid) {
        console.error(`[SyncEngine] 合并验证失败: ${validation.reason}`);

        // 回滚到快照（直接用本地 snapshot 变量，不依赖存储二次读取）
        await this.restoreSnapshot(snapshot);

        this.isSyncing = false;
        return {
          success: false,
          groups: snapshot,
          reason: `validation_failed: ${validation.reason}`,
        };
      }

      // 6. 写入本地存储
      await storage.setGroups(mergedGroups);

      // 7. 更新同步时间
      const syncTime = new Date().toISOString();
      await storage.setLastSyncTime(syncTime);

      // 8. 清除快照（写入成功）
      await storage.clearSyncSnapshot();

      console.log(`[SyncEngine] 下载合并完成: ${mergedGroups.length} 个组`);
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

      // 回滚到快照（直接用本地 snapshot 变量）
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
   * 上传本地数据到云端
   *
   * 流程：
   *   读取 → 分离活跃组和软删 ID → 上传活跃组 → 标记云端软删
   *   失败不影响本地数据
   *
   * @param opts.includeDeleted 是否包含软删标记（deleteAllGroups 场景）
   */
  async upload(opts?: { includeDeleted?: boolean }): Promise<UploadResult> {
    const { auth } = store.getState();
    if (!auth.isAuthenticated) {
      return { success: false, error: '用户未登录' };
    }

    if (this.isSyncing) {
      return { success: false, error: '正在同步中' };
    }

    this.isSyncing = true;
    this.cancelPendingUpload();

    try {
      const allGroups = await storage.getGroups();

      // 分离：活跃组（未软删）和软删组 ID
      const activeGroups = allGroups.filter(g => !g.isDeleted);
      const deletedIds = allGroups.filter(g => g.isDeleted).map(g => g.id);

      console.log(
        `[SyncEngine] 上传: ${activeGroups.length} 活跃 + ${deletedIds.length} 软删`
      );

      // 上传活跃组（纯 upsert，不删云端现有数据）
      if (activeGroups.length > 0) {
        await uploadTabGroups(activeGroups, false);
      }

      // 标记云端软删
      if (deletedIds.length > 0 && opts?.includeDeleted !== false) {
        try {
          await markCloudGroupsAsDeleted(deletedIds);
          console.log(`[SyncEngine] 已标记 ${deletedIds.length} 个云端组为软删`);
        } catch (err) {
          console.error('[SyncEngine] 标记云端软删失败（不阻塞主流程）:', err);
        }
      }

      // 更新同步时间
      const syncTime = new Date().toISOString();
      await storage.setLastSyncTime(syncTime);

      // Tombstone GC：异步清理自己设备的、超过 30 天的过期 tombstone。
      // fire-and-forget：不阻塞主流程，失败也不影响上传结果。
      void cleanupCloudTombstones().catch(err =>
        console.warn('[SyncEngine] tombstone GC failed:', err)
      );

      console.log('[SyncEngine] 上传完成');
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

      return {
        success: false,
        error: error instanceof Error ? error.message : '上传失败',
      };
    }
  }

  /**
   * 调度延迟上传
   * autoSyncMiddleware 调用此方法，带优先级防抖
   *
   * @param delayMs 延迟毫秒数（默认 3000ms）
   */
  scheduleUpload(delayMs: number = 3000): void {
    // 取消已有的 timer
    if (this.uploadTimer) {
      clearTimeout(this.uploadTimer);
    }

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
   * 等待本地 groups 加载完成（Race condition 保护）
   * 用于 maybeAutoDownload 场景：
   *   Popup 打开后 2 秒触发自动下载，
   *   如果此时 loadGroups 还没把本地数据写回 Redux，
   *   则等待直到 lastLoadedAt 非空。
   *
   * @param timeoutMs 超时毫秒数
   * @returns 是否在超时前加载完成
   */
  async waitForGroupsLoaded(timeoutMs: number = 5000): Promise<boolean> {
    if (store.getState().tabs.lastLoadedAt !== null) return true;

    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => {
        unsubscribe();
        resolve(false);
      }, timeoutMs);

      const unsubscribe = store.subscribe(() => {
        if (store.getState().tabs.lastLoadedAt !== null) {
          clearTimeout(timer);
          unsubscribe();
          resolve(true);
        }
      });
    });
  }

  // ── 私有方法 ─────────────────────────────────────────────────────

  /**
   * 回滚本地数据到指定快照
   *
   * 直接使用内存中的 snapshot 数组写入存储（不依赖之前可能失败的
   * storage.setSyncSnapshot 写入），确保验证失败或异常时数据不丢失。
   */
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
      // 最后防线：再次尝试
      try {
        await storage.setGroups(snapshot);
        console.log('[SyncEngine] 二次回滚成功');
      } catch (retryErr) {
        console.error('[SyncEngine] 二次回滚也失败，数据可能丢失:', retryErr);
      }
    }
  }
}

/** 便捷导出单例 */
export const syncEngine = SyncEngine.getInstance();
