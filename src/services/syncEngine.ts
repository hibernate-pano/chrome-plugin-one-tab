import { store } from '@/store';
import { UPLOAD_DEBOUNCE_MS } from '@/core/syncTiming';
import { getCurrentUser, setFromCache } from '@/store/slices/authSlice';

/** MV3 SW 中由 chrome.alarms 驱动的延迟上传 alarm。 */
export const SYNC_UPLOAD_ALARM = 'tapstack-scheduled-upload';
// UPLOAD_GUARD_MS 常量与下载前置决策在 core/syncDecision（纯函数，可单测），
// 此处 re-export 供既有引用方不破坏。
export { UPLOAD_GUARD_MS } from '@/core/syncDecision';
import type { TabGroup, UserSettings } from '@/types/tab';
import { storage, invalidateGroupsCache } from '@/utils/storage';
import {
  downloadTabGroups,
  downloadTabGroupsDigest,
  uploadTabGroups,
  markCloudGroupsAsDeleted,
  purgeExpiredCloudTombstones,
} from '@/services/tabGroupSyncService';
import {
  uploadSettings,
  downloadSettings,
  DEVICE_LEVEL_SETTING_KEYS,
} from '@/services/settingsSyncService';
import {
  validateMergeResult,
  decideDownloadPrecheck,
  decideForceRemoteOverwrite,
  hasRemoteChanges,
} from '@/core/syncDecision';
// 合并语义已统一为 mergeOpStamped（OpStamp 全序决胜，组级 LWW 整组覆盖）。
// 这是合并的唯一真相源；旧 LWW 实现已随 2026-10-05 瘦身删除。
import { mergeOpStamped } from '@/core/opStampMerge';
import { checkDeleteFailsafe } from '@/sync-backend/failsafe';
import { readConfiguredBackendId } from '@/sync-backend';
import { isLockedBackendError } from '@/sync-backend/lockedBackendError';
import { dropSyncMergedGroups, removedGroupIds } from '@/core/mutationOps';
import { ensureOpStampMigrated } from '@/background/opStampMigratedGuard';
import { enqueue } from '@/background/mutationQueue';
import { ensureAuthenticated } from '@/core/authGuard';
import { errorHandler } from '@/utils/errorHandler';
import { validateThemeStyle, validateThemeMode } from '@/utils/storage';
import { logError, logInfo, logWarn } from '../utils/log';

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
  /**
   * 失败原因（用户可读）。与 `reason` 分开的原因：
   * `reason` 是**稳定的机器码**（测试、诊断面板按它识别分支），
   * 而这里放的是「云端看起来是空的，已中止以免清空你的数据」这类人话。
   * 两者混在一个字段里，UI 就只能去解析代码字符串来做展示。
   */
  error?: string;
  /** 轻量探活命中（云端无变更，直接返回本地快照）时为 true */
  upToDate?: boolean;
  /**
   * 本轮失败的根因是「自带存储未配置/未解锁」（锁定占位后端抛出）。
   *
   * ── 为什么要与 `reason` 分开 ────────────────────────────────────────
   * `reason` 仍保留**人话**（锁定后端的提示就是用户下一步），UI 原样展示；
   * 而 `locked` 是给后台分类用的机器标记：它是正常用户状态，不是故障，
   * backgroundSync 据此把本轮算作 `yielded`（不进退避、不清 alarm）。
   * 把两者混成「reason === 'backend_locked'」会让人话从 toast 里消失。
   */
  locked?: boolean;
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
  /**
   * 失败根因是「自带存储未配置/未解锁」（锁定占位后端抛出）。
   * 语义与 MergeResult.locked 相同：正常用户状态，后台应让路而不是退避。
   */
  locked?: boolean;
}

export type SyncOperation = 'upload' | 'download' | 'none';

export type SyncProgressCallback = (progress: number, operation: SyncOperation) => void;

/** 与旧 settingsSlice.syncSettingsFromCloud 相同的合并/校验逻辑，供引擎内复用 */
async function mergeCloudSettingsIntoLocal(): Promise<void> {
  const cloudSettings = await downloadSettings();
  if (!cloudSettings) return;

  // 合并基准取**存储真值**，不是 store.settings：本函数跑在 SW 里，SW 冷启动时
  // Redux 的 settings 就是代码默认值（同一坑见下面 upload 分支的备注），
  // 云端没有的字段（老版本行、本机新增项）会被整份写成默认值 —— 而这是覆盖
  // 下载，用户以为「以云端为准」，实际连本机偏好一起丢。
  // 读失败才回退 Redux 现值：宁可少合一项，也不把代码默认值写进存储。
  let localSettings: UserSettings;
  try {
    localSettings = await storage.getSettingsForWrite();
  } catch (error) {
    logWarn('[SyncEngine] 覆盖下载前读取本机设置失败，合并基准回退 Redux 现值:', error);
    localSettings = (store.getState() as { settings: UserSettings }).settings;
  }

  // 云端只承载外观与操作偏好；设备级字段（syncBackend / syncEnabled /
  // syncIntervalMinutes）以本机为准，忽略云端给它们的值 —— 云端行里可能
  // 仍留着上传前的老版本写下的这些键（存量行、改设置前推上去的行）。
  // 这与 uploadSettings 侧剔除同一份 DEVICE_LEVEL_SETTING_KEYS，两侧成对。
  const cloudPreferences = { ...cloudSettings };
  for (const key of DEVICE_LEVEL_SETTING_KEYS) delete cloudPreferences[key];

  const convertedSettings: UserSettings = {
    ...localSettings,
    ...cloudPreferences,
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
   *
   * ── 2026-10-05：读失败不再当“没有待上传” ────────────────────────────
   * 原实现在这里 `catch { return false }`，而 false 的语义是「本地没有待上传
   * 的变更」——读失败会被读成「一切正常」，于是后台轮询**跳过上传这一步**。
   * 真实状态若是「有一堆本地变更等着上云」，结果就是它们静默不推送：
   * 云端保持旧状态，下次下载再把本地覆盖回去，用户以为存了其实没存上。
   *
   * 改为向上抛：判据读不到时「先上传还是先下载」这个问题就没有答案，
   * 静默替它答一个「不用传」是这类 bug 最常见的制造方式。
   * backgroundSync 的处理是「读不到就跳过本轮同步并记日志」——
   * 那是诚实的：什么都没做，而不是做了一半还声称做完了。
   */
  async hasPendingUpload(): Promise<boolean> {
    return storage.getPendingUpload();
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
   *
   * 【置位必须先于调用方返回】返回 Promise 让调用方 await：MV3 的 SW 随时可能
   * 在"组已从磁盘移除 / purge 队列已写入"与"pending_upload 置位"之间被回收，
   * 那样后台轮询看到 pendingUpload=false 就不上传，云端行删不掉、并集合并又
   * 把已删的组拉回来——删除被静默撤销。此前 `void storage.setPendingUpload(true)`
   * 是 fire-and-forget，mutationHandlers 里 setGroups 之后紧接着就调度上传，
   * 正好落在这个窗口里。
   *
   * 【快路径必须经单写者队列（1.22.10）】timer 回调里的 upload() 此前直接执行，
   * 绕过了 mutationQueue——而 upload() 内部有两组非原子读-改-写（读广播队列 →
   * markCloudGroupsAsDeleted → 按确认清队；读 groups → 整组覆盖写），与队列内
   * 正在执行的 mutation 交错时，删除广播意图可能被覆盖丢失 → 对端复活。四条上传
   * 路径的 enqueue 分工（谁负责包裹，只有一处，双层包裹 = 内层等外层 settle、
   * 外层 await 内层 = 死锁）：
   *   - popup 手动上传/下载：service-worker 的 SYNC 分支 enqueue(`sync:${op}`)
   *   - 后台轮询：backgroundSync enqueue('sync:upload' / 'sync:download')
   *   - alarm 兜底：service-worker onAlarm enqueue('sync:upload') 包 runScheduledUpload
   *   - timer 快路径：本方法 enqueue('sync:upload') 包 upload() ← 本处
   *   ⛔ 因此 runScheduledUpload 内部绝不能再 enqueue——alarm 路径已经包过了。
   * timer 回调是宏任务、不在任何队列 job 内，入队安全；同名 span 让诊断导出把
   * 四条路径的耗时聚在同一桶里。
   *
   * @param delayMs 延迟毫秒数（默认 3000ms）
   */
  scheduleUpload(delayMs: number = UPLOAD_DEBOUNCE_MS): Promise<void> {
    // ── 2026-10-05：置位失败不再只 logWarn ────────────────────────────────
    // 原来这里是 `.catch(err => logWarn(...))`：置位失败后 alarm 照样创建、
    // timer 照样跑，本次进程内的上传**会**发生。但 pending_upload 标志是
    // 「SW 被杀后重启还能不能记得要上传」的唯一凭据 —— 置位失败意味着
    // 这个凭据没写进磁盘。若这次上传途中 SW 被回收（MV3 常态），
    // 新起的 SW 读到 false，后台轮询会跳过上传，那批本地变更就静默躺平了。
    //
    // 这里不改成 throw：scheduleUpload 是 fire-and-forget 的调度入口，
    // 抛错会让调用方（mutationHandlers 的每个 case、以及 timer 快路径）
    // 全部失败，而「调度本身」其实已经成功了。诚实的做法是：
    //   记 error 级日志（不是 warn——这是会导致数据不上云的故障），
    //   并说明后果，让排障的人能直接定位到这条。
    const marked = storage.setPendingUpload(true).catch(err => {
      logError(
        '[SyncEngine] 置位 pending_upload 失败——本次上传仍会执行，但若 SW 在此期间' +
          '被回收，重启后的后台轮询读到的将是 false 并跳过上传，导致这批本地变更' +
          '不上云（下次下载可能用云端旧数据覆盖本地）。原始错误：',
        err
      );
    });
    if (typeof chrome !== 'undefined' && chrome.alarms) {
      // ponytail: 双驱动——R6 修复。chrome.alarms 最小 delayInMinutes 是 0.5（30s），
      // 仅靠 alarm 会把“点开一个标签”这种 1.5~3s 意图拉伸到 ≥30s，期间本地变更
      // 未推送。setTimeout 在 SW 存活期内 1.5~3s 真触发；alarm 在 SW 被杀后兜底。
      // 两者都清旧，幂等可重复触发（upload() 成功会 cancelPendingUpload 清双驱动）。
      // 快路径
      if (this.uploadTimer) clearTimeout(this.uploadTimer);
      this.uploadTimer = setTimeout(() => {
        this.uploadTimer = null;
        void enqueue('sync:upload', () => this.upload())
          .catch(err => logError('[SyncEngine] 快路径上传失败:', err));
      }, delayMs);
      // 兜底
      void chrome.alarms.clear(SYNC_UPLOAD_ALARM).catch(() => {});
      const delayMinutes = Math.max(0.5, delayMs / 60000);
      chrome.alarms.create(SYNC_UPLOAD_ALARM, { delayInMinutes: delayMinutes });
      return marked;
    }
    // 非扩展运行时 fallback：单测走这里（同样经队列，与快路径保持同一语义）
    if (this.uploadTimer) clearTimeout(this.uploadTimer);
    this.uploadTimer = setTimeout(() => {
      this.uploadTimer = null;
      void enqueue('sync:upload', () => this.upload())
        .catch(err => logError('[SyncEngine] 延迟上传失败:', err));
    }, delayMs);
    return marked;
  }

  /**
   * 由 chrome.alarms.onAlarm 回调。fire-and-forget；错误靠 console.error 报。
   */
  async runScheduledUpload(): Promise<void> {
    try {
      await this.upload();
    } catch (err) {
      logError('[SyncEngine] alarm 驱动上传失败:', err);
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
    //
    // backendId 必须显式传（2026-10-14）：门禁要按后端决定查不查 Supabase 账号。
    // 自带存储的用户没有 Supabase 账号，漏传会让他看到「用户未登录」，
    // 且永远走不到锁定后端那句「去重新解锁」（真机 E2E 抓到的）。
    const authed = await ensureAuthenticated({
      isAuthenticated: () =>
        (store.getState() as { auth: { isAuthenticated: boolean } }).auth.isAuthenticated,
      restoreAuth: () => this.restoreAuth(),
      backendId: await readConfiguredBackendId(),
    });
    if (!authed) {
      return { success: false, groups: [], reason: 'not_authenticated' };
    }
    if (this.isSyncing) {
      return { success: false, groups: [], reason: 'already_syncing' };
    }

    // 合并前兜底：本地实体没有印记时，合并会把它当成全序最小值，
    // 静默输给任何带印记的云端行（用户本地数据无声消失）。幂等，已迁移用户只多读一次标志位。
    //
    // inQueue=true：downloadAndMerge 自身跑在 sync:download 这个 job 内，
    // 单写者队列已经保证了读-改-写串行；此刻再入队会死锁。
    try {
      await ensureOpStampMigrated(true);
    } catch (err) {
      logWarn('[SyncEngine] 印记迁移兜底失败（不阻塞同步）:', err);
    }

    // forceRemote（"从云端下载（覆盖）"）此前完全绕过删除广播队列：本地已物理删除、
    // 还没标记到云端的组，其活跃行仍在云端，覆盖下载会把它连同标签一起拉回来。
    // 覆盖语义 = 云端完全镜像本地：先把队列里的删除意图标记到云端（行保留 is_deleted），
    // 再让覆盖上传用本地全量重建云端。
    if (opts?.forceRemote) {
      try {
        const pendingDeletes = await storage.getPendingDeleteIds();
        if (pendingDeletes.length > 0) {
          await markCloudGroupsAsDeleted(pendingDeletes);
          // 点名本轮实际广播成功的这一批，不整队清空（队列在读走之后还会继续长，
          // 整队清会把没广播过的删除意图连坐抹掉 → 云端行仍活跃 → 复活）。
          // markCloudGroupsAsDeleted 失败会抛给下面的 catch，此时不会走到清队。
          await storage.clearPendingDeleteIds(pendingDeletes);
          logInfo(`[SyncEngine] 覆盖下载前已广播 ${pendingDeletes.length} 条删除意图`);
        }
      } catch (err) {
        // 不阻断覆盖下载：用户明确选了覆盖语义，但要让日志留下"可能复活"的痕迹
        logWarn('[SyncEngine] 覆盖下载前广播删除意图失败（已删组可能被拉回）:', err);
      }
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
        // 2026-10-07 专家团体检 P0-3：这里原本是 fail-open（读不到判据却继续下载），
        // 与同文件 backgroundSync.ts:126-142 对同一判据的 fail-closed 处置**方向相反**。
        //
        // 判据有两个来源：storage.getLastUploadTime()（last_upload_time）与
        // hasPendingUpload()（pending_upload）。两者任何一个读失败，
        // 「本地是否领先云端」这个问题都没有答案，而下载会用云端数据覆盖本地。
        // 若本地其实有未推送的新状态（正是读失败最可能的原因之一：死句柄看门狗
        // 刚 abort、quota 超限、事务 abort），这一轮下载就会把它覆盖掉 ——
        // 用户的修改静默丢失。
        //
        // 日志按实际抛错来源区分，不再写死「读不到 pending_upload 判据」——
        // 运维按文案去查 pending_upload 而实际挂的是 last_upload_time 时，
        // 会被误导到错误的方向。
        //
        // backgroundSync 那侧的注释已把同一判据的处置写死为「与其赌一把，不如什么
        // 都不做」（read-fail-closed）；两处必须同口径，否则同一个故障在后台轮询被
        // 挡住、在 popup 手动/自动同步这条路径却放行。
        const isLastUploadRead =
          e instanceof Error && /last_upload_time/i.test(String(e.message ?? ''));
        const which = isLastUploadRead
          ? '读不到 last_upload_time 判据'
          : e instanceof Error && /pending_upload/i.test(String(e.message ?? ''))
            ? '读不到 pending_upload 判据'
            : '本地同步判据读取失败';
        logWarn(
          `[SyncEngine] ${which}，中止本次下载` +
            '（fail-closed，不写入：本地是否领先云端未知，下载可能覆盖未推送的本地变更）。' +
            '下次 alarm / 手动同步重试。',
          e
        );
        return { success: false, groups: [], reason: 'precheck_unknown' };
      }

      if (decision.action === 'skip') {
        logInfo(`[SyncEngine] 跳过本次下载（${decision.reason}：刚上传过，避免覆盖本地新版本）`);
        return { success: false, groups: [], reason: decision.reason };
      }

      if (decision.action === 'upload_first') {
        logInfo('[SyncEngine] 本地有未上传变更，下载前先推送');
        const upResult = await this.upload({ forcePending: true });
        if (!upResult.success) {
          // 上传失败（如网络断开）时中止下载：此时拉云端只会用旧数据覆盖
          // 本地未推送的新状态。pending flag 已保留，下轮 alarm / 手动同步重试。
          logWarn(`[SyncEngine] 上传未成功，跳过本次下载: ${upResult.error}`);
          return { success: false, groups: [], reason: 'pending_upload_failed' };
        }
      }
    }

    const report = opts?.onProgress || (() => {});
    this.isSyncing = true;
    this.cancelPendingUpload();

    // 1. 快照（P1-4：新鲜读 + 直写，绕过 30s 缓存与 500ms 防抖——SW 可随时被杀）
    //    fail-closed：本地快照读失败时不得拿 snapshot=[] 继续。这是最后一条
    //    「读失败能变成写」的路径——继续跑会把 localGroups 当成空集合，
    //    mergeOpStamped( [], cloud ) 的结果几乎等于 cloud 本身，
    //    再 setGroupsImmediate 写回：一次 IndexedDB 读错误就能把本地整组会话
    //    换成云端快照（合并验证挡不住：local 为空时 validate 恒 valid）。
    let snapshot: TabGroup[] = [];
    try {
      snapshot = await storage.getGroupsFresh();
    } catch (err) {
      logError('[SyncEngine] 本地快照读失败，中止本次下载（fail-closed，不写入）:', err);
      this.isSyncing = false;
      return { success: false, groups: [], reason: 'snapshot_failed' };
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
            logInfo(
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
          logInfo('[SyncEngine] 探活未命中：检测到云端变更，走全量下载合并');
        } catch (err) {
          logWarn('[SyncEngine] 指纹探活失败，走全量下载:', err);
        }
      }
      // 2. 下载云端
      const cloudGroups = await downloadTabGroups();
      report(55, 'download');
      // 3. 空云端闸门（2026-10-17 修 P0）：覆盖下载必须先过这一关。
      //
      // 【为什么这一关不能省】下面第 4 步会把 localGroups 置空（覆盖语义），
      // 于是 validateMergeResult 的规则 2「本地有活跃数据但合并后为空」在
      // 覆盖路径上**恒不可达** —— 那条防线在这里形同不存在。
      // 而「本地有会话 + 云端一个字节都没有」时继续覆盖，等于用空库把本机
      // 全清空且不可逆（1.22.0 起无回收站），UI 还会显示覆盖成功。
      //
      // 【放在哪一步】必须在 cloudGroups 拿到之后、localGroups 置空之前：
      // 判据需要「云端到底有没有行」，而覆盖模式下合并阶段已经看不到本地了。
      //
      // 【为什么不看活跃行】云端只有墓碑行时收敛到空是**合法**的 —— 那正是
      // 「另一台设备把会话都删了」，必须传播。判据用总行数（含墓碑）。
      if (opts?.forceRemote) {
        const gate = decideForceRemoteOverwrite({
          localActiveCount: snapshot.filter(g => !g.isDeleted).length,
          cloudTotalCount: cloudGroups.length,
        });
        if (gate.action === 'refuse') {
          logError('[SyncEngine] 拒绝空云端覆盖:', gate.reason);
          this.isSyncing = false;
          // 不动本地一个字节：refuse 的全部意义就是「什么都不做」。
          return { success: false, groups: snapshot, reason: 'overwrite_empty_cloud_refused' };
        }
      }
      // 4. 确定本地。覆盖模式（forceRemote）= 云端完全镜像本地：本地置空，
      //    merge 退化为「云端活跃行直通」（云端墓碑行被 merge 跳过，永不入库）。
      //    正常模式剥掉本地残留的组级墓碑（老版本写入形状，见上）。
      const localGroups = opts?.forceRemote ? [] : snapshot.filter(g => !g.isDeleted);
      // 5. 合并
      // 无墓碑模型（2026-09-29）：组级 LWW 整组覆盖（语义见 mergeOpStamped 头注释）。
      // 云端 is_deleted 行 = 删除广播：对端活跃副本 stamp 更旧则服从删除；
      // 本地离线修改更新则保留。合并不产生新实体、不铸 mergeStamp。
      const mergedGroups = mergeOpStamped(localGroups, cloudGroups);
      report(80, 'download');
      // 6. 验证
      const validation = validateMergeResult(localGroups, cloudGroups, mergedGroups);
      if (!validation.valid) {
        logError(`[SyncEngine] 合并验证失败: ${validation.reason}`);
        await this.restoreSnapshot(snapshot);
        this.isSyncing = false;
        // P1-5：验证失败回滚后，若本地仍有未上传变更必须重调度上传，
        // 否则删除/点开意图会静默躺在本地直到下一次手动同步。
        await this.rescheduleUploadIfPending();
        return { success: false, groups: snapshot, reason: `validation_failed: ${validation.reason}` };
      }
      // 7. 写入（P1-4：直写落盘，不经过防抖窗口）
      //
      // 【空组规则：同步合并路径锁定豁免】（2026-10-10 缺陷 2 修复）
      // 物理模型下正常合并不产生空组（组是整体进出的），此处仅兜底：
      // 老版本设备写入的空壳/导入的空组随 LWW 赢家到达时不再落地。
      // 未锁定的空组照旧剔除；**锁定但零标签的组一律留下**——它不是垃圾，
      // 而是用户「清空最后一个标签后留着、等着再填」的合法状态（applyRemoveTab
      // 走锁定豁免就会留下这种组）。
      //
      // 【为什么这里必须锁定豁免，而不能用 dropEmptyGroups 的无保护判据】
      // 下面被剔除的 id 会进 pendingDeleteIds → 云端行打 is_deleted 墓碑 →
      // 所有设备上永久消失（v1.22.0 起无回收站）。用户锁定 = 「别自动清掉我」，
      // 若同步合并把锁定的 0 标签组剔掉，等于把「锁定」翻译成「跨设备永久删除」，
      // 下一个 60s 同步周期就发生，用户毫不知情。
      //
      // 【副作用与取舍】锁定空壳会因此在 storage 里留更久。视图层另有过滤
      // （toActiveGroupsView 仍用 isEmptyGroup，不看锁定），所以不会渲染成空卡；
      // 想彻底删掉它的用户走 deleteGroup（用户显式意图，不豁免）。
      const finalGroups = dropSyncMergedGroups(mergedGroups);

      // ── 删除熔断（2026-10-13，WebDAV 阶段 3）────────────────────────────
      // 位置在**写入之前**：熔断的语义是「这一次同步不许造成这么大的删除」，
      // 所以必须发生在 setGroupsImmediate 之前 —— 之后就已经写完了。
      //
      // 【为什么现在才补，它防的是什么】
      // 本项目此前没有这道防线，因为 Supabase 模型下它用不上：本地是 master，
      // 远端读回空/少一半时，合并结果仍以本地为准，不会清空本地。
      // 但文件后端引入两条新的「静默清空」路径：
      //   1) 用户手动在云盘里清空/移动了 groups/ 目录；
      //   2) 服务端分页/限流导致只读到一部分（坚果云单次 750 条上限，
      //      官方文档明确警告「未实现按分页多次加载会出现文件同步不完整」）。
      // 这两条在「下载覆盖本地」的语义下会直接清空用户本机会话，
      // 而本项目 v1.22.0 起**无回收站、删除即物理清除**，不可逆。
      //
      // 【判据用 Floccus 原式】（调研报告 §4.4）：
      //   一次删除 > 总数 20%（且总数 > 5）或 > 1000 条 ⇒ 中止本轮并报错。
      // 判定对象是「本轮相比合并结果被丢弃的会话数」，与
      // dropSyncMergedGroups / removedGroupIds 用同一口径 ——
      // 熔断管的是「合并剔除」，不是「云端删除广播」（后者是用户显式删除，
      // 不该被熔断拦下，那会让用户删不掉）。
      const mergeDropped = removedGroupIds(mergedGroups, finalGroups);
      if (mergeDropped.length > 0) {
        const verdict = checkDeleteFailsafe(
          mergedGroups.filter(g => !g.isDeleted).length,
          mergeDropped.length
        );
        if (!verdict.allowed) {
          logError('[SyncEngine] 删除熔断触发，本轮下载已中止（未写入任何数据）:', verdict.reason);
          this.isSyncing = false;
          // 不回滚也不重排：本地数据**根本没被动过**（熔断在写入之前），
          // 所以不需要 restoreSnapshot。保留 pending_upload 让下轮重试。
          await this.rescheduleUploadIfPending();
          return {
            success: false,
            groups: snapshot,
            reason: 'failsafe_triggered',
            // reason 字段是给 UI/日志看的可读原因，测试与诊断都按它识别
            error: verdict.reason,
          };
        }
      }

      // 3.5 覆盖模式：同步设置（与旧 smartSyncService 的 overwriteLocal 行为一致）
      //
      // ⚠️ 这一步必须排在**全部**中止闸门之后（2026-10-17 修了空云端闸门，
      // 2026-10-18 补上删除熔断与合并验证）。原先它只排在空云端闸门之后，
      // 于是熔断／验证失败时 mergeCloudSettingsIntoLocal 已经把用户的设置
      // （布局/主题/排序/通知开关）从云端覆写进本地了 —— 而熔断的日志写着
      // 「本轮下载已中止（未写入任何数据）」、注释写着「本地数据根本没被动过」，
      // 且 restoreSnapshot 只回滚会话、不回滚设置。那两句话当时是假的。
      //
      // 顺序即是语义：先判定这一轮覆写该不该发生，发生了才轮到附带动作。
      if (opts?.forceRemote && opts?.syncSettings) {
        try {
          await mergeCloudSettingsIntoLocal();
        } catch (err) {
          logWarn('[SyncEngine] 覆盖下载时同步设置失败（不阻塞主流程）:', err);
        }
      }

      await storage.setGroupsImmediate(finalGroups);
      // 广播队列必须伴随 pending_upload 置位，否则入队了也没人执行：
      // backgroundSync 只在 hasPendingUpload() 为真时才上传，而下载路径
      // 从不置这个标志 → 云端行永远标记不到 → 对端复活。
      let deleteQueued = false;
      const droppedIds = removedGroupIds(mergedGroups, finalGroups);
      if (droppedIds.length > 0) {
        try {
          // 批量登记：下载合并可能一次丢弃很多空壳组，逐条登记是 2N 次 KV 往返。
          await storage.addPendingDeleteIds(droppedIds);
        } catch (e) {
          // 写失败时 addPendingDeleteIds 已把整批推进内存兜底，意图仍在，
          // 仍需置位 pending_upload 让下一轮上传尝试广播（否则删除只留在内存）。
          logWarn('[SyncEngine] 登记删除广播队列失败（云端行可能残留复活）:', e);
        }
        deleteQueued = true;
        logInfo(`[SyncEngine] 合并剔除 ${droppedIds.length} 个空组并登记删除广播`);
      }
      if (deleteQueued) {
        try {
          await storage.setPendingUpload(true);
        } catch (e) {
          logWarn('[SyncEngine] 置位 pending_upload 失败（删除广播可能滞留）:', e);
        }
      }
      // 8. 更新同步时间
      await storage.setLastSyncTime(new Date().toISOString());
      // 9. 清除快照
      await storage.clearSyncSnapshot();
      // ponytail: 下载可能掩盖本地未上传变更（合并出“新增”项）。检查持久化
      // pending_upload：若仍 true，表明本地有未传云端的意图，重新调度一次上传
      // 让后台按“下载后上传”顺序把所有本地变更推到云端。避免云端在“删除/点开”
      // 后仍为旧状态供下次下载复活本地。
      try {
        const stillPending = await storage.getPendingUpload();
        if (stillPending) {
          logInfo('[SyncEngine] 下载完成但本地仍有未上传变更，重新调度上传');
          this.scheduleUpload(0);
        }
      } catch (e) {
        // pending 检查失败不阻塞主流程（上传意图仍由持久化 flag 保留）
      }
      report(100, 'none');

      this.isSyncing = false;
      return {
        success: true,
        groups: finalGroups,
        stats: {
          localCount: localGroups.length,
          cloudCount: cloudGroups.length,
          mergedCount: finalGroups.length,
          conflicts: finalGroups.filter(g => g.syncStatus === 'conflict').length,
        },
      };
    } catch (error) {
      logError('[SyncEngine] 下载合并失败:', error);
      await this.restoreSnapshot(snapshot);
      this.isSyncing = false;
      // P1-5：下载抛错/回滚后，若 pending 仍 true 必须重调度上传。
      await this.rescheduleUploadIfPending();
      // locked 标记必须保留：reason 保持人话（UI 原样展示），
      // 机器分类走 locked（backgroundSync 据此把「未配置/未解锁」算让路）。
      return {
        success: false,
        groups: snapshot,
        reason: error instanceof Error ? error.message : 'download_merge_failed',
        ...(isLockedBackendError(error) ? { locked: true } : {}),
      };
    }
  }

  /**
   * 上传本地数据到云端。
   * 无墓碑模型：本地全部是活跃组（老版本残留墓碑见下），删除意图走
   * pendingDeleteIds 队列 → markCloudGroupsAsDeleted（UPDATE is_deleted=true，
   * 行保留 = 对端的删除广播载体）。失败不影响本地数据。
   * @param opts.includeDeleted 是否包含删除广播（false 仅测试用）
   */
  async upload(opts?: {
    includeDeleted?: boolean;
    overwriteCloud?: boolean;
    syncSettings?: boolean;
    onProgress?: SyncProgressCallback;
    // ponytail: 后台轮询同步路径专用——跳过 cancelPendingUpload 短路、跳过
    // isSyncing 检查（backgroundSync 路径互不冲突）。常规 UI 调用无需此参数。
    forcePending?: boolean;
    /**
     * 本次上传是「用户在设置页明确确认了归属之后的首次全量」（2026-10-18 P1#4）。
     *
     * 只有 WebDavSettings 的三选一会传 true。默认 false 的含义是「用户还没
     * 对归属表态」，此时若远端尚无 manifest，全量上传会被降级为增量 ——
     * 见 uploadGroups 的 `suppressFirstSyncFullUpload`。
     */
    explicitFirstSync?: boolean;
  }): Promise<UploadResult> {
    // ponytail: SW 进程是独立执行上下文，store 是新实例——先恢复登录态
    // （与 downloadAndMerge 共用 ensureAuthenticated 守卫）。
    // backendId 必须显式传，理由同上。
    const authed = await ensureAuthenticated({
      isAuthenticated: () =>
        (store.getState() as { auth: { isAuthenticated: boolean } }).auth.isAuthenticated,
      restoreAuth: () => this.restoreAuth(),
      backendId: await readConfiguredBackendId(),
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
      // 老版本设备写入的本地组级墓碑（迁移前的残留形状）：它们的删除意图
      // 已随旧模型上过云，这里兜底再标记一次，标记成功后从本地物理清除
      // （新模型本地不留墓碑，见文件头）。
      const legacyTombstoneIds = allGroups.filter(g => g.isDeleted).map(g => g.id);

      const overwriteCloud = opts?.overwriteCloud || false;
      let skippedOverwrite: UploadResult['skippedOverwrite'];
      // 本次 upsert 已经写上云的墓碑 id（覆盖模式才可能非空）。
      let writtenTombstoneIds: Set<string> = new Set();

      // ── 2026-10-18 P1#4：首次同步归属未决时，自动上传不得走全量 ──────────
      // 背景：切到自带存储后，WebDavSettings 的三选一是**唯一**决定「本地已有
      // 数据怎么上云」的入口。它完成前，用户保存一个新会话会让 TabManager 的
      // scheduleUpload 置 pending_upload，而适配器在远端还没有 manifest 时
      // 走 firstSync = 全量上传 ⇒ **全部旧会话被自动推上去，三选一被绕过**。
      //
      // 为什么拦在 syncEngine 而不是 UI：scheduleUpload / 后台 alarm 两条自动
      // 路径都不经过 WebDavSettings，只有这里是所有上传的必经关口。
      //
      // 为什么只挡「首次全量」而不挡增量：用户没做的决定是「已有的那些会话
      // 归谁」，不是「他刚保存的会话要不要传」。挡住增量会让新保存的会话
      // 静默留在本机，而用户以为它已经同步了 —— 那是另一种撒谎。
      const firstSyncPending = await storage.getFirstSyncPending();
      const explicitFirstSync = firstSyncPending ? !!opts?.explicitFirstSync : true;
      if (firstSyncPending && !explicitFirstSync && !overwriteCloud) {
        logInfo(
          '[SyncEngine] WebDAV 首次同步归属决策未完成：本次只走增量上传，' +
            '已有会话等你到设置里点「检查并推送」后再决定归属'
        );
      }

      if (activeGroups.length > 0) {
        // 覆盖模式把残留墓碑一起交给 uploadTabGroups：覆盖会先删空云端，墓碑必须
        // 随同一次 upsert 写上云（selectRowsForUpload 决定实际写入哪些行），
        // 否则删除意图随覆盖一起丢失，另一端的活跃副本下次合并即复活。
        const up = await uploadTabGroups(
          overwriteCloud ? allGroups : activeGroups,
          overwriteCloud,
          explicitFirstSync
        );
        writtenTombstoneIds = new Set(up?.writtenTombstoneIds ?? []);
      } else if (overwriteCloud) {
        // ponytail: 与旧 uploadTabsToCloudFlow 的空本地保护一致——本地没有任何活跃组时
        // 绝不执行覆盖模式（覆盖 = 先删云端全部再插），否则会把云端数据清空。
        // 该保护本身是对的，但结果必须让调用方看得见（见 UploadResult.skippedOverwrite）：
        // 继续走到 report(70) 并 success 只会让 SyncButton 弹「上传成功」，
        // 而这次覆盖根本没发生。
        logWarn('[SyncEngine] 覆盖上传被跳过：本地没有活跃组（保留云端数据）');
        skippedOverwrite = 'no-active-groups';
      }
      report(70, 'upload');
      // P1：覆盖 upsert 已经把墓碑按「本机印记」写上云了，这些 id 绝不能再来一次
      // markCloudGroupsAsDeleted——它会按云端 OLD.last_op_seq+1 且换成本设备重新
      // UPDATE，同一行被写两遍：
      //   (a) 多 N 次 UPDATE 往返 + 一次读回 SELECT；
      //   (b) 严格 LT 守卫（BEFORE UPDATE）可能把第二次写静默吞掉，与 upsert
      //       写入的印记互相打架 → verifyUploadReadback 的 checkStamp 永远对不上
      //       → 抛错、pending_upload 保留 → 上传永久卡在重试循环。
      // 未被 upsert 写到的墓碑仍然要交回 markCloudGroupsAsDeleted，删除意图一条都不能漏。
      // P0-2：markCloudGroupsAsDeleted 抛错（写失败、读回不一致、未登录跳过）直接
      // 上浮到外层 catch → 本次 upload 整体失败，pending_upload 与删除队列保留，
      // 下轮 alarm 重试。禁止吞错假装成功（云端没标记、下次下载直接复活）。
      const pendingDeleteIds = await storage.getPendingDeleteIds();
      const cloudDeleteIds = [...new Set([
        ...pendingDeleteIds,
        ...legacyTombstoneIds.filter(id => !writtenTombstoneIds.has(id)),
      ])];
      // 广播与清队必须成对：includeDeleted===false 时这一轮**根本没广播**，
      // 此时清队等于把删除意图直接丢弃 —— 方向与 fail-closed 正好相反。
      // 所以清队放进同一个 if，且只在 markCloudGroupsAsDeleted 成功返回后才执行
      // （它失败会抛给外层 catch，整批要么都确认、要么整批留下等下轮）。
      if (cloudDeleteIds.length > 0 && opts?.includeDeleted !== false) {
        await markCloudGroupsAsDeleted(cloudDeleteIds);
        // 按本轮实际广播成功的清单消费队列，而不是整队清空：一轮上传期间队列
        // 还会继续长（读走 A 之后用户又删了 B，B 写 KV 失败只落进内存兜底），
        // 整队清空会把没广播过的 B 连坐抹掉 → 云端行仍活跃 → 下次合并整组复活，
        // 且 v1.22.0 起无回收站、用户无法找回。详见 storage.clearPendingDeleteIds。
        await storage.clearPendingDeleteIds(cloudDeleteIds);
      } else if (cloudDeleteIds.length > 0) {
        logWarn('[SyncEngine] includeDeleted=false：删除意图本轮未广播，队列保留不清理');
      }
      if (legacyTombstoneIds.length > 0) {
        await storage.setGroupsImmediate(activeGroups);
        logInfo(`[SyncEngine] 已广播 ${legacyTombstoneIds.length} 个老版本残留墓碑并从本地清除`);
      }
      // 云端墓碑 TTL：删除广播行的使命是让所有在线设备服从删除；30 天后物理
      // 删除（防云端行只增不减）。30 天未上线的设备其活跃副本会重新出现——
      // 与旧模型「7 天回收站到期」的复活风险同类，且窗口更长。
      // 失败不阻断上传（下轮再试），TTL 只延迟。
      try {
        await purgeExpiredCloudTombstones();
      } catch (err) {
        logWarn('[SyncEngine] 云端墓碑 TTL 清理失败（下轮上传重试）:', err);
      }
      // 设置同步：与旧 smartSyncService.uploadToCloud 一致（上传标签组后总带上传设置）
      // ponytail: 必须从 storage 读——SW 冷启动时 store.settings 是代码默认值，
      // 直接上传会把用户云端设置覆盖成默认值（2026-09-12 审计发现）。
      if (opts?.syncSettings) {
        try {
          // 必须读**真值**（getSettingsForWrite）：settings 读路径带 60s 进程内
          // 缓存，而写方在另一个执行上下文（设置页 / popup），SW 那份可能是用户
          // 改设置之前的快照。这条值的下一站是云端，且 uploadSettings 是无条件
          // upsert（无 stamp / 无 version / 无 LWW）—— 一次陈旧读就把用户云端设置
          // 整行覆盖成旧值（2026-10-18 实测：设置页切成 WebDAV 后推送到云端，
          // 云端 syncBackend 仍是 supabase）。
          await uploadSettings(await storage.getSettingsForWrite());
        } catch (err) {
          logWarn('[SyncEngine] 上传设置失败（不阻塞主流程）:', err);
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
      logError('[SyncEngine] 上传失败:', error);
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
        ...(isLockedBackendError(error) ? { locked: true } : {}),
      };
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
      logWarn('[SyncEngine] 快照为空，跳过回滚（保持本地数据不变）');
      return;
    }
    try {
      // P1-4：回滚直写落盘，不经过防抖窗口（SW 可能在窗口期内被杀导致回滚丢失）。
      await storage.setGroupsImmediate(snapshot);
      logInfo(`[SyncEngine] 已从快照恢复 ${snapshot.length} 个组`);
    } catch (err) {
      logError('[SyncEngine] 快照回滚失败:', err);
      try {
        await storage.setGroupsImmediate(snapshot);
      } catch (retryErr) {
        logError('[SyncEngine] 二次回滚也失败，数据可能丢失:', retryErr);
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
        logInfo('[SyncEngine] 同步失败但本地仍有未上传变更，重新调度上传');
        this.scheduleUpload(0);
      }
    } catch {
      // pending 检查失败不阻塞主流程（上传意图仍由持久化 flag 保留）
    }
  }
}

/** 便捷导出单例 */
export const syncEngine = SyncEngine.getInstance();
