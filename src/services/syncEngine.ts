import { store } from '@/store';
import { getCurrentUser, setFromCache } from '@/store/slices/authSlice';

/** MV3 SW 中由 chrome.alarms 驱动的延迟上传 alarm。 */
export const SYNC_UPLOAD_ALARM = 'tapstack-scheduled-upload';
// UPLOAD_GUARD_MS 常量与下载前置决策在 syncUtils（纯函数，可单测），
// 此处 re-export 供既有引用方不破坏。
export { UPLOAD_GUARD_MS } from '@/utils/syncUtils';
import type { TabGroup, UserSettings } from '@/types/tab';
import { storage, invalidateGroupsCache } from '@/utils/storage';
import {
  downloadTabGroups,
  downloadTabGroupsDigest,
  uploadTabGroups,
  markCloudGroupsAsDeleted,
  purgeCloudGroups,
} from '@/services/tabGroupSyncService';
import { uploadSettings, downloadSettings } from '@/services/settingsSyncService';
import {
  validateMergeResult,
  decideDownloadPrecheck,
  hasRemoteChanges,
} from '@/utils/syncUtils';
// 阶段二（§5 + §9）：合并语义已统一为 mergeOpStamped（OpStamp 全序决胜）。
// 旧 LWW 合并 mergeTabGroups 已隔离至 @/utils/syncUtils.legacy（⛔禁接回生产）。
import { mergeOpStamped } from '@/utils/opStampMerge';
import { createSeqRegistry, maxObservedSeq } from '@/utils/seqRegistry';
import { ensureOpStampMigrated } from '@/background/opStampMigratedGuard';
import { getDeviceId } from '@/utils/deviceUtils';
import { ensureAuthenticated } from '@/utils/authGuard';
import { kvGet, kvSet } from '@/storage/storageAdapter';
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
  /** 轻量探活命中（云端无变更，直接返回本地快照）时为 true */
  upToDate?: boolean;
}

export interface UploadResult {
  success: boolean;
  error?: string;
  /**
   * 本次确实没有执行的操作（success 仍为 true：墓碑/purge/设置等其他环节照常完成）。
   * 上传入口据此区分「已覆盖云端」与「空本地保护跳过覆盖」，避免给用户报假的成功。
   * 目前只有一种：本地无活跃组时跳过覆盖上传（绝不拿空本地清空云端）。
   */
  skippedOverwrite?: 'no-active-groups';
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
   * 调度延迟上传。mutationHandlers / autoSyncMiddleware 调用此方法。
   * 双驱动：setTimeout 为 SW 存活期内的快路径（1.5~3s 真延迟，R6 修复）；
   * chrome.alarms 为 SW 被杀后的兜底（≥30s）。upload() 成功路径会
   * cancelPendingUpload() 清双驱动。
   * @param delayMs 延迟毫秒数（默认 3000ms）
   */
  scheduleUpload(delayMs: number = 3000): void {
    void storage.setPendingUpload(true);
    if (typeof chrome !== 'undefined' && chrome.alarms) {
      // ponytail: 双驱动——R6 修复。chrome.alarms 最小 delayInMinutes 是 0.5（30s），
      // 仅靠 alarm 会把“点开一个标签”这种 1.5~3s 意图拉伸到 ≥30s，期间本地变更
      // 未推送。setTimeout 在 SW 存活期内 1.5~3s 真触发；alarm 在 SW 被杀后兜底。
      // 两者都清旧，幂等可重复触发（upload() 成功会 cancelPendingUpload 清双驱动）。
      // 快路径
      if (this.uploadTimer) clearTimeout(this.uploadTimer);
      this.uploadTimer = setTimeout(() => {
        this.uploadTimer = null;
        void this.upload().catch(err => console.error('[SyncEngine] 快路径上传失败:', err));
      }, delayMs);
      // 兜底
      void chrome.alarms.clear(SYNC_UPLOAD_ALARM).catch(() => {});
      const delayMinutes = Math.max(0.5, delayMs / 60000);
      chrome.alarms.create(SYNC_UPLOAD_ALARM, { delayInMinutes: delayMinutes });
      return;
    }
    // 非扩展运行时 fallback：单测走这里
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
   * 安全流水线：上传窗口守卫 → 未推送变更先上传 → 快照 → 下载 → 合并 →
   * 验证 → 写入；任一步失败自动回滚。
   * @param opts.forceRemote 是否强制用云端数据覆盖本地（跳过上传守卫与先传后拉）
   */
  async downloadAndMerge(opts?: {
    forceRemote?: boolean;
    syncSettings?: boolean;
    onProgress?: SyncProgressCallback;
  }): Promise<MergeResult> {
    // ponytail: 冷 SW 的 store 未恢复登录态（SW 是独立执行上下文）——
    // 先尝试从持久化 session 恢复一次，否则 popup 发起的下载会一律
    // not_authenticated（upload 已有同等恢复，download 曾缺失）。
    const authed = await ensureAuthenticated({
      isAuthenticated: () =>
        (store.getState() as { auth: { isAuthenticated: boolean } }).auth.isAuthenticated,
      restoreAuth: () => this.restoreAuth(),
    });
    if (!authed) {
      return { success: false, groups: [], reason: 'not_authenticated' };
    }
    if (this.isSyncing) {
      return { success: false, groups: [], reason: 'already_syncing' };
    }

    // 合并前兜底：本地实体没有印记时，合并会把它当成全序最小值，
    // 静默输给任何带印记的云端行（用户本地数据无声消失）。幂等，已迁移用户只多读一次标志位。
    try {
      await ensureOpStampMigrated();
    } catch (err) {
      console.warn('[SyncEngine] 印记迁移兜底失败（不阻塞同步）:', err);
    }

    // ponytail: 下载前置保护（决策逻辑见 decideDownloadPrecheck 单测）：
    // 1) 刚上传过 → 跳过下载（云端已是本地新状态）
    // 2) 有未推送变更 → 先上传再下载，否则「删除书签后 upload alarm 未到
    //    就触发下载」会让云端旧数据先合并回来（复活），事后的 re-schedule
    //    再把复活后的状态推上去，删除意图彻底丢失。
    if (!opts?.forceRemote) {
      let decision: ReturnType<typeof decideDownloadPrecheck>;
      try {
        const [lastUpload, pending] = await Promise.all([
          storage.getLastUploadTime(),
          this.hasPendingUpload(),
        ]);
        decision = decideDownloadPrecheck({
          forceRemote: false,
          lastUploadTime: lastUpload,
          pendingUpload: pending,
          now: Date.now(),
        });
      } catch (e) {
        // storage 读失败不阻塞主流程，走正常下载
        decision = { action: 'proceed' };
      }

      if (decision.action === 'skip') {
        console.log(`[SyncEngine] 跳过本次下载（${decision.reason}：刚上传过，避免覆盖本地新版本）`);
        return { success: false, groups: [], reason: decision.reason };
      }

      if (decision.action === 'upload_first') {
        console.log('[SyncEngine] 本地有未上传变更，下载前先推送');
        const upResult = await this.upload({ forcePending: true });
        if (!upResult.success) {
          // 上传失败（如网络断开）时中止下载：此时拉云端只会用旧数据覆盖
          // 本地未推送的新状态。pending flag 已保留，下轮 alarm / 手动同步重试。
          console.warn(`[SyncEngine] 上传未成功，跳过本次下载: ${upResult.error}`);
          return { success: false, groups: [], reason: 'pending_upload_failed' };
        }
      }
    }

    const report = opts?.onProgress || (() => {});
    this.isSyncing = true;
    this.cancelPendingUpload();

    // 1. 快照（P1-4：新鲜读 + 直写，绕过 30s 缓存与 500ms 防抖——SW 可随时被杀）
    let snapshot: TabGroup[] = [];
    try {
      snapshot = await storage.getGroupsFresh();
      await storage.setSyncSnapshot(snapshot);
    } catch (err) {
      console.error('[SyncEngine] 快照保存失败:', err);
    }

    try {
      report(10, 'download');
      // 2.0 轻量探活：全量下载前先拉指纹列，无变更直接返回本地快照。
      // 短路条件：非 forceRemote（forceRemote 必须绕过探活）且本地非空
      // （首次同步本地为空必须全量下载）。探活失败 fail-open 走原全量流程。
      if (!opts?.forceRemote && snapshot.length > 0) {
        try {
          const digest = await downloadTabGroupsDigest();
          if (!hasRemoteChanges(snapshot, digest)) {
            console.log(
              `[SyncEngine] 探活命中：云端无变更（${digest.length} 行指纹一致），跳过全量下载`
            );
            report(100, 'none');
            await storage.setLastSyncTime(new Date().toISOString());
            this.isSyncing = false;
            return {
              success: true,
              groups: snapshot,
              stats: {
                localCount: snapshot.length,
                cloudCount: digest.length,
                mergedCount: snapshot.length,
                conflicts: 0,
              },
              reason: 'up_to_date',
              upToDate: true,
            };
          }
          console.log('[SyncEngine] 探活未命中：检测到云端变更，走全量下载合并');
        } catch (err) {
          console.warn('[SyncEngine] 指纹探活失败，走全量下载:', err);
        }
      }
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
      // 阶段二·§5：合并语义切换到 mergeOpStamped（OpStamp 全序决胜）。
      // mergeStamp 取本设备 nextSeq：合并设备产生的 URL 去重败者盖本设备 stamp，
      // 由此下载本身成为本设备的一次「合并操作」，与用户操作共享全序空间。
      const deviceId = await getDeviceId();
      const seqRegistry = createSeqRegistry({
        kvGet, kvSet,
        getGroups: () => storage.getGroups(),
      });
      // 合并印记必须大于「本地 + 云端」观察到的所有印记：seqRegistry.current() 只读
      // 合并前的本地快照，而本次合并产生的墓碑（§5.4 URL 败者）若不大于刚下载到的
      // 云端印记，下次合并就会被云端那条更新的记录原样复活。
      const observed = maxObservedSeq([...localGroups, ...cloudGroups]);
      let mergeSeq = await seqRegistry.nextSeq();
      if (observed !== null && observed >= mergeSeq) {
        mergeSeq = await seqRegistry.bumpSeqIfLower(observed + 1);
      }
      const mergedGroups = mergeOpStamped(localGroups, cloudGroups, {
        mergeStamp: { d: deviceId, s: mergeSeq },
      });
      report(80, 'download');
      // 5. 验证
      const validation = validateMergeResult(localGroups, cloudGroups, mergedGroups);
      if (!validation.valid) {
        console.error(`[SyncEngine] 合并验证失败: ${validation.reason}`);
        await this.restoreSnapshot(snapshot);
        this.isSyncing = false;
        // P1-5：验证失败回滚后，若本地仍有未上传变更必须重调度上传，
        // 否则删除/点开意图会静默躺在本地直到下一次手动同步。
        await this.rescheduleUploadIfPending();
        return { success: false, groups: snapshot, reason: `validation_failed: ${validation.reason}` };
      }
      // 6. 写入（P1-4：直写落盘，不经过防抖窗口）
      await storage.setGroupsImmediate(mergedGroups);
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
      } catch (e) {
        // pending 检查失败不阻塞主流程（上传意图仍由持久化 flag 保留）
      }
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
      // P1-5：下载抛错/回滚后，若 pending 仍 true 必须重调度上传。
      await this.rescheduleUploadIfPending();
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
    // ponytail: SW 进程是独立执行上下文，store 是新实例——先恢复登录态
    // （与 downloadAndMerge 共用 ensureAuthenticated 守卫）。
    const authed = await ensureAuthenticated({
      isAuthenticated: () =>
        (store.getState() as { auth: { isAuthenticated: boolean } }).auth.isAuthenticated,
      restoreAuth: () => this.restoreAuth(),
    });
    if (!authed) {
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
      // P1-4：上传读取本地前先失效缓存——同一进程内 mutation 刚写完（防抖窗口期）
      // 就触发上传时，不能读到 30s 缓存里的旧快照（否则把旧状态推上云覆盖新数据）。
      invalidateGroupsCache();
      const allGroups = await storage.getGroups();
      const activeGroups = allGroups.filter(g => !g.isDeleted);
      const deletedIds = allGroups.filter(g => g.isDeleted).map(g => g.id);

      const overwriteCloud = opts?.overwriteCloud || false;
      let skippedOverwrite: UploadResult['skippedOverwrite'];
      if (activeGroups.length > 0) {
        // 覆盖模式把墓碑一起交给 uploadTabGroups：覆盖会先删空云端，墓碑必须
        // 随同一次 upsert 写上云（selectRowsForUpload 决定实际写入哪些行），
        // 否则删除意图随覆盖一起丢失，另一端的活跃副本下次合并即复活。
        // 合并模式仍只传活跃组（墓碑走 markCloudGroupsAsDeleted）。
        await uploadTabGroups(overwriteCloud ? allGroups : activeGroups, overwriteCloud);
      } else if (overwriteCloud) {
        // ponytail: 与旧 uploadTabsToCloudFlow 的空本地保护一致——本地没有任何活跃组时
        // 绝不执行覆盖模式（覆盖 = 先删云端全部再插），否则会把云端数据清空。
        // 该保护本身是对的，但结果必须让调用方看得见（见 UploadResult.skippedOverwrite）：
        // 继续走到 report(70) 并 success 只会让 SyncButton 弹「上传成功」，
        // 而这次覆盖根本没发生。
        console.warn('[SyncEngine] 覆盖上传被跳过：本地没有活跃组（保留云端数据）');
        skippedOverwrite = 'no-active-groups';
      }
      report(70, 'upload');
      if (deletedIds.length > 0 && opts?.includeDeleted !== false) {
        // P0-2：软删失败必须阻断上传成功。markCloudGroupsAsDeleted 抛错（写失败、
        // 读回不一致、未登录跳过）直接上浮到外层 catch → 本次 upload 整体失败，
        // pending_upload 保留、lastUploadTime 不刷，下轮 alarm 重试。
        // 禁止在此 try/catch 吞掉只 console.error（那会清 pending 假装成功，
        // 云端没删、下次下载直接复活）。
        await markCloudGroupsAsDeleted(deletedIds);
      }
      // P1-6：本地已 purge 的组，云端墓碑行必须同步彻底删除，否则下次下载
      // 以 remote-only 复活。删后才 clear 队列；抛错则阻断本次上传成功、下轮重试。
      const pendingPurgeIds = await storage.getPendingPurgeIds();
      if (pendingPurgeIds.length > 0) {
        await purgeCloudGroups(pendingPurgeIds);
        await storage.clearPendingPurgeIds();
      }
      // 设置同步：与旧 smartSyncService.uploadToCloud 一致（上传标签组后总带上传设置）
      // ponytail: 必须从 storage 读——SW 冷启动时 store.settings 是代码默认值，
      // 直接上传会把用户云端设置覆盖成默认值（2026-09-12 审计发现）。
      if (opts?.syncSettings) {
        try {
          await uploadSettings(await storage.getSettings());
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
      return { success: true, ...(skippedOverwrite ? { skippedOverwrite } : {}) };
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

  /** 从 chrome.storage.local 里的持久化 supabase session 恢复 SW store 登录态。 */
  private async restoreAuth(): Promise<boolean> {
    const user = await store.dispatch(getCurrentUser()).unwrap().catch(() => null);
    if (!user) return false;
    store.dispatch(setFromCache({ user, isAuthenticated: true }));
    return true;
  }

  private async restoreSnapshot(snapshot: TabGroup[]): Promise<void> {
    if (snapshot.length === 0) {
      console.warn('[SyncEngine] 快照为空，跳过回滚（保持本地数据不变）');
      return;
    }
    try {
      // P1-4：回滚直写落盘，不经过防抖窗口（SW 可能在窗口期内被杀导致回滚丢失）。
      await storage.setGroupsImmediate(snapshot);
      await storage.clearSyncSnapshot();
      console.log(`[SyncEngine] 已从快照恢复 ${snapshot.length} 个组`);
    } catch (err) {
      console.error('[SyncEngine] 快照回滚失败:', err);
      try {
        await storage.setGroupsImmediate(snapshot);
      } catch (retryErr) {
        console.error('[SyncEngine] 二次回滚也失败，数据可能丢失:', retryErr);
      }
    }
  }

  /**
   * P1-5：失败路径重调度。若 pending_upload 仍为 true（本地有未上传意图），
   * 重新排一次上传，避免删除/点开意图在下载失败后静默躺平。
   * 调用方保证 isSyncing 已置 false（scheduleUpload 的 timer 回调走 upload()，
   * isSyncing 为 true 会拒绝非 force 调用）。失败检查本身不抛错。
   */
  private async rescheduleUploadIfPending(): Promise<void> {
    try {
      if (await storage.getPendingUpload()) {
        console.log('[SyncEngine] 同步失败但本地仍有未上传变更，重新调度上传');
        this.scheduleUpload(0);
      }
    } catch {
      // pending 检查失败不阻塞主流程（上传意图仍由持久化 flag 保留）
    }
  }
}

/** 便捷导出单例 */
export const syncEngine = SyncEngine.getInstance();
