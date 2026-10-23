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
  downloadTabGroupsDigest,
  uploadTabGroups,
  markCloudGroupsAsDeleted,
  purgeExpiredCloudTombstones,
} from '@/services/tabGroupSyncService';
// 「读到的 + 读不出来而被整组跳过的」一次性读取（2026-10-20 D-6）。
// 为什么不用裸的 downloadTabGroups：只拿「读到的」会让引擎把「云端那份
// 没读到」误判成「云端没有这一组」—— 覆盖下载时那会把本机那份物理删除，
// 而删除熔断与删除广播都看不见它。详见该文件头。
import { downloadGroupsWithSkipped } from '@/services/downloadWithSkippedGroups';
import {
  uploadSettings,
  downloadSettings,
  stripNonPortableSettings,
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
// 「登记的待传集合」与「本轮上行的集合」的对账判据（2026-10-20 D-3）。
// 纯函数、后端无关：两个后端走的是同一段引擎代码 ⇒ 判据只有一份。
import {
  reconcileUploadCoverage,
  decideRegistryAfterUpload,
  decideRegistryAfterRegistryWrite,
  // 「本轮能消费掉哪些增量登记」与「消费之后还有没有没传完的」
  // （2026-10-23 审计 DS-43-19）。纯函数：判据不许散在 IO 层。
  decideConsumableRegistryIds,
  decidePendingAfterRegistryConsume,
} from '@/core/uploadCoverage';
import { checkDeleteFailsafe, type FailsafeVerdict } from '@/core/deleteFailsafe';
// 覆盖下载的删除计划（DS-2）：这次覆盖会物理清除本机哪些会话。
// 纯函数、判据只有一份（闸门与熔断用的是同一个函数）。
import { planOverwriteDeletion } from '@/core/overwriteGuard';
import { preservedLocalGroups } from '@/core/overwriteDownloadPreserve';
import { readConfiguredBackendId } from '@/sync-backend';
import type { SyncBackendId } from '@/sync-backend';
import { isLockedBackendError } from '@/sync-backend/lockedBackendError';
import { isBackendUnavailableError } from '@/core/backendUnavailable';
import { backendUnavailableCopy } from '@/components/sync/backendUnavailableCopy';
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
  /**
   * 合并的**数字摘要**（只给日志用）。
   *
   * ⚠️ 这里**曾经**有 `conflicts: number`（2026-10-23 审计 DS-43-18 删掉）。
   *
   * 为什么删：它数的是 `syncStatus === 'conflict'` 的组数，而**没有任何一处**
   * 会把组标成 `'conflict'`（合并是整组 LWW，见 src/core/opStampMerge.ts）
   * ⇒ 这个数字**恒为 0**，而全仓**零消费**（只有 backgroundSync 拼日志时提到它）。
   * 一个恒为 0 的统计量对外宣称「本产品会统计冲突」，而它其实不统计，
   * 也不提示（败方新增的标签会丢且零提示，README「整组覆盖」如实写着）。
   *
   * 要有真的冲突数，得先有**共同祖先**（三方合并的基线）才能区分
   * 「云端只是更新了」与「两边同时改了、有一边被覆盖」——那是协议级改动。
   * 在那之前，这里宁可**没有**这个数字，也不要一个恒为 0 的假数字。
   */
  stats?: {
    localCount: number;
    cloudCount: number;
    mergedCount: number;
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
  /**
   * 本轮失败的根因是「**云端项目被限制 / 服务端不可用**」（2026-10-22，402 收口）。
   *
   * 语义与 UploadResult.backendUnavailable 相同：故障且**重试无用**，
   * 后台据此停止推进退避阶梯（而不是每 5 分钟烧一次 egress 配额）。
   *
   * 字段缺失（老调用方 / 本轮没有这个问题）⇒ 没有这件事。
   */
  backendUnavailable?: boolean;
  /**
   * 本轮云端有 N 个会话**读不出来**而被整组跳过（2026-10-20 D-6）。
   *
   * 这些会话的**云端行仍在**（一个字节都没被动过），但本机这一轮拿不到它们。
   * 引擎必须在覆盖模式下**保住本机那几份**（云端那份没拿到 ⇒「云端说了算」
   * 这条规则不适用），并把这件事如实上报 —— 否则界面报「同步成功」，而用户
   * 只看到「列表变短了」（v1.22.0 起无回收站 ⇒ 不可逆）。
   *
   * 字段缺失（老后端 / 测试替身 / 本轮没跳过任何会话）⇒ 没有这件事。
   */
  skippedRemoteGroups?: { count: number; ids: string[] };
}

export interface UploadResult {
  success: boolean;
  error?: string;
  /**
   * 本次确实没有执行的操作（success 仍为 true：墓碑/purge/设置等其他环节照常完成）。
   * 上传入口据此区分「已覆盖云端」与「覆盖被跳过」，避免给用户报假的成功。
   *
   * 已知取值：
   *   · `no-active-groups` —— 本地没有任何活跃组时跳过覆盖上传
   *     （绝不拿空本地清空云端）。
   *   · `no-account-groups` —— 换账号后本机没有属于当前账号的会话，账号闸门
   *     放行 0 个（2026-10-23 回归审计 R-1）：覆盖会先删空云端却什么都不会写
   *     ⇒ 纯数据丢失 ⇒ 跳过，云端原样保留。
   */
  skippedOverwrite?: 'no-active-groups' | 'no-account-groups';
  /**
   * 失败根因是「自带存储未配置/未解锁」（锁定占位后端抛出）。
   * 语义与 MergeResult.locked 相同：正常用户状态，后台应让路而不是退避。
   */
  locked?: boolean;
  /**
   * 失败根因是「**云端项目被限制 / 服务端不可用**」（2026-10-22，402 收口）。
   *
   * ── 为什么与 `locked` 分开 ────────────────────────────────────────────
   * `locked` = 「用户还没配置/解锁」——**正常用户状态**，后台据此让路
   * （不进退避、按用户档位重排）。
   * 本字段 = 「**服务端出问题了**」——故障，且**重试无用**（项目被封禁时
   * 重试一万次结果一样）。后台据此**停止推进退避阶梯**、把间隔大幅拉长，
   * 而不是每 5 分钟重试一次（那是在烧 egress 配额，而配额正是封禁的原因）。
   *
   * 两者混在一起 ⇒ 要么把故障当正常状态（永不重试 ⇒ 恢复后也不自愈），
   * 要么把正常状态当故障（用户没配云盘就疯狂重试）。
   *
   * 字段缺失（老调用方 / 本轮没有这个问题）⇒ 没有这件事。
   */
  backendUnavailable?: boolean;
  /**
   * 本轮**登记了但没上传上去**的会话数（2026-10-20 D-3）。
   *
   * ── 为什么需要这个字段 ──────────────────────────────────────────────────
   * 「上传成功」在这台机器上曾经意味着两件不同的事：
   *   · 「这一批改动确实到了云端」；
   *   · 「这一轮流程没有抛错」。
   * 修复前这两件事被混为一谈：归属待决期的白名单里全是不存在的 id 时，
   * 上传集合是空集，流程照样走完并 `success: true` ⇒
   * 用户看到「上传成功」，而那 20 个导入的会话**一个都没上云**。
   *
   * 这个字段是**事实**，不是文案：>0 ⇒ 确实有会话没同步。
   * UI 必须据此告诉用户「N 个会话尚未同步」（见 syncEngine.upload 的调用点）。
   */
  skippedGroups?: number;
  /**
   * 上面 skippedGroups 对应的会话 id（诊断用；UI 通常只报数量）。
   */
  skippedGroupIds?: string[];
  /**
   * 本轮**无法确认「全部已同步」**（2026-10-20 D-10）。
   *
   * ── 为什么需要这个字段 ──────────────────────────────────────────────────
   * 「有没有东西没传上去」与「能不能证明东西都传上去了」是**两件事**：
   * 登记失败过的那一轮，登记集合可能与上行集合**完全对得上**（skippedGroups=0），
   * 而「没漏」这件事**无从证明**（漏登记的改动压根没记下 id）。
   *
   * 旧代码只按 skippedGroups>0 决定要不要告诉用户 ⇒ 这种情况界面报
   * 「上传成功」—— 那是在**撒谎**。这个字段是那件事的**事实**：
   * 为 true ⇒ 调用方（SW 的 SYNC 回包）必须把 ok 置 false ⇒ 界面弹提示，
   * 而不是弹「同步成功」。
   *
   * 字段缺失（老调用方 / 本轮一切正常）⇒ 没有这件事。
   */
  cannotConfirmAllSynced?: boolean;
}

export type SyncOperation = 'upload' | 'download' | 'none';

/**
 * 「首次同步归属待决期是否抑制全量上传」的判据（纯函数）。
 *
 * 抽成纯函数的原因：`upload()` 在读到 null 时会提前 return，所以
 * 「读不到设置时抑制仍然生效」这一态**在运行时不可达**，只能对这个判据
 * 直接打行为断言（本仓库没有 DOM 测试环境，也禁止为此装依赖）。
 *
 * ⚠️ 最后一项必须是「不等于 supabase」而不是「等于 webdav」（2026-10-18 B 组）：
 * configuredBackendId 为 null（读不到设置）时，「等于 webdav」为 false ⇒
 * 抑制关闭 ⇒ changedGroupIds 变 null ⇒ 上传清单退回全量 activeGroups。
 * 若此刻后端确实是自带存储、远端又恰好没有 manifest，归属待决期的历史会话
 * 会被整批推上用户的云盘 —— 2026-10-18 P1#4 明令禁止的「多传」，不可回滚。
 * 反过来（读不到 ⇒ 保守抑制）错的代价只是「少传」：会话留在本机等用户决定。
 */
export function decideSuppressFullUpload(args: {
  firstSyncPending: boolean;
  explicitFirstSync: boolean;
  overwriteCloud: boolean;
  configuredBackendId: SyncBackendId | null;
}): boolean {
  return (
    args.firstSyncPending &&
    !args.explicitFirstSync &&
    !args.overwriteCloud &&
    args.configuredBackendId !== 'supabase'
  );
}

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
  // 2026-10-20 审计 A-21：改用共用函数 stripNonPortableSettings ——
  // 「上云 / 云端合并 / 导入备份 / 导出备份」四条路径同一张剔除表。
  // （已退役键此前在这一侧没剔，靠 storage.setSettings 兜底剔掉；
  //   结果一样，但多走一步且「谁负责剔」不清楚。）
  const cloudPreferences = stripNonPortableSettings(cloudSettings);

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
   * @param changedGroupIds 本次操作改动过的会话 id（2026-10-18 P1#4 第二半）。
   *   WebDAV 归属待决期只允许上传这些会话 —— 保存路径知道它刚写了哪个组，
   *   mutation 命令也带着受影响的 id（见 core/mutationAffectedGroups）。
   *   不传 = 本次没有会话被改动（只置 pending_upload，不改增量白名单）。
   */
  scheduleUpload(
    delayMs: number = UPLOAD_DEBOUNCE_MS,
    changedGroupIds?: readonly string[]
  ): Promise<void> {
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
    // 增量白名单必须与 pending_upload 一起落盘（同样 await）：待决期的上传靠它
    // 决定「允许传哪些会话」，漏写就等于这次改动在待决期传不上去（fail-closed，
    // 不会多传；但用户会以为已同步）。与置位同样只记 error 级日志、不抛 ——
    // scheduleUpload 是 fire-and-forget 的调度入口。
    //
    // ⚠️ 2026-10-20 D-3：登记失败**不能只记日志**。
    // 登记失败的后果不是「少传几个」，而是「**不知道漏了哪几个**」——
    // 于是「白名单与上行集合对得上账」这个判据失去意义（对得上只说明
    // 「登记到的都传了」，没说明「没登记的也没漏」）。
    // 所以这里把「登记不可信」这个事实**持久化**：上传流程读到它就
    // 不会清 pending_upload、不会宣称「全部同步」（见 core/uploadCoverage）。
    //
    // ── 2026-10-20 D-10：这里也是标志的**复位**入口之一 ─────────────────
    // 标志原先只被「上传对账通过」清（写在 upload 的 canClearPending 分支里），
    // 而那个判据里又含「标志为假」⇒ **自锁**：标志一旦置上就永不复位
    // ⇒ pending_upload 永远清不掉 ⇒ 每轮后台同步都在重跑上传，界面还报
    // 「同步成功」（界面撒谎的原因：skippedGroups 恒为 undefined）。
    //
    // 复位条件必须**与上传对账无关**，否则就是同一个自指。
    // 这里给出的是其中一条**与对账完全无关**的路径：
    //   「**本次登记成功**」⇒ 登记机制此刻是好的 ⇒ 「不可信」这个事实不再成立
    //   （注意：只清「不可信」这一位，**不清**「漏登记的那批还没补传」——
    //    那一位只能由「一次全量提交」清，见 core/uploadCoverage 的注释）。
    // 依据是**写方的事实**（noteGroupsChanged 这次没抛错），与上传无关 ⇒ 不自指。
    //
    // 判据本身在纯函数里（decideRegistryAfterRegistryWrite）：存储层只负责
    // 忠实落盘，两处不许各写一套（漂移过一次的后果是「漏登记永远补不上」）。
    const noted = changedGroupIds && changedGroupIds.length > 0
      ? storage.noteGroupsChanged(changedGroupIds).then(
          () => this.applyRegistryWriteOutcome(true),
          err => {
            logError(
              '[SyncEngine] 登记「本次改动的会话 id」失败——若此刻正处于 WebDAV 归属待决期，' +
                '这批改动本轮不会被上传（不会多传，只会留在本机等你完成归属决策）。原始错误：',
              err
            );
            // 登记失败 → 记下「登记不可信」。这个标记本身写失败也只能记日志
            // （已经在一个失败路径上了，不能再抛）。
            //
            // ⚠️ 这里用的是**直接置位**而不是纯函数那条路：置位就是
            // 「unreliable=true + gapOpen=true」，没有取舍可做。
            // 纯函数那条路（decideRegistryAfterRegistryWrite）服务的是
            // **复位**——「登记成功 ⇒ 只清 unreliable、保留 gapOpen」
            // （顺手把 gapOpen 也清了 ⇒ 漏登记的那批永远补不上）。
            return storage.setPendingUploadRegistryUnreliable(true).catch(err2 => {
              logError(
                '[SyncEngine] 标记「增量白名单登记不可信」也失败了——' +
                  '本轮可能误判「全部已同步」而清掉 pending_upload。原始错误：',
                err2
              );
            });
          }
        )
      : Promise.resolve();
    if (typeof chrome !== 'undefined' && chrome.alarms) {
      // ponytail: 双驱动——R6 修复。chrome.alarms 最小 delayInMinutes 是 0.5（30s），
      // 仅靠 alarm 会把“点开一个标签”这种 1.5~3s 意图拉伸到 ≥30s，期间本地变更
      // 未推送。setTimeout 在 SW 存活期内 1.5~3s 真触发；alarm 在 SW 被杀后兜底。
      // 两者都清旧，幂等可重复触发（upload() 成功会 cancelPendingUpload 清双驱动）。
      // 快路径
      if (this.uploadTimer) clearTimeout(this.uploadTimer);
      this.uploadTimer = setTimeout(() => {
        this.uploadTimer = null;
        // 等增量白名单落盘再上传：否则待决期的上传可能读到还没写全的 id 列表。
        void noted
          .then(() => enqueue('sync:upload', () => this.upload()))
          .catch(err => logError('[SyncEngine] 快路径上传失败:', err));
      }, delayMs);
      // 兜底
      void chrome.alarms.clear(SYNC_UPLOAD_ALARM).catch(() => {});
      const delayMinutes = Math.max(0.5, delayMs / 60000);
      chrome.alarms.create(SYNC_UPLOAD_ALARM, { delayInMinutes: delayMinutes });
      return Promise.all([marked, noted]).then(() => undefined);
    }
    // 非扩展运行时 fallback：单测走这里（同样经队列，与快路径保持同一语义）
    if (this.uploadTimer) clearTimeout(this.uploadTimer);
    this.uploadTimer = setTimeout(() => {
      this.uploadTimer = null;
      void noted
        .then(() => enqueue('sync:upload', () => this.upload()))
        .catch(err => logError('[SyncEngine] 延迟上传失败:', err));
    }, delayMs);
    return Promise.all([marked, noted]).then(() => undefined);
  }

  /**
   * 写方侧：把「本次登记成功 / 失败」这个**事实**落进「登记不可信」标志。
   *
   * 判据在纯函数里（core/uploadCoverage 的 decideRegistryAfterRegistryWrite），
   * 这里只负责**忠实落盘** —— 存储层与纯函数不许各写一套判据：漂移过一次
   * 的后果是「纯函数说保留 gapOpen、落盘却把整个键删了」⇒ 漏登记的那批
   * 永远补不上（静默丢失）。
   *
   * ⚠️ 写失败只记日志，不抛：登记本身已经成功了（或已经失败了），
   * 标志写不进去只是让它多留一轮（下一轮登记成功会再清一次），
   * 不该让整个调度失败。
   */
  private async applyRegistryWriteOutcome(writeSucceeded: boolean): Promise<void> {
    if (!writeSucceeded) {
      // 失败路径：直接置位（unreliable + gapOpen）。调用方已经处理了日志。
      return;
    }
    try {
      const before = await storage.getPendingUploadRegistryState();
      const decision = decideRegistryAfterRegistryWrite({ before, writeSucceeded: true });
      if (!decision.changed) return; // 状态没变 ⇒ 不写（幂等）
      await storage.setPendingUploadRegistryStateIfUnchanged(before.gen, decision.after);
    } catch (err) {
      logWarn('[SyncEngine] 标记「登记已恢复可信」失败（下轮登记成功时再清）:', err);
    }
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
    //
    // ⚠️ null（读不到设置）必须**在这里**判掉，不能流进门禁（2026-10-18 B 组）。
    // 门禁里 `backendId === 'webdav'` 对 null 为 false ⇒ 走 restoreAuth() 查
    // Supabase session ⇒ 恰好复现 2026-10-14 那个症状（自带存储用户看到
    // 「用户未登录」，且到不了锁定后端那句提示）。「本轮不知道传向哪儿」
    // 不是「没登录」，所以它有自己的机器码 backend_unknown。
    const gateBackendId = await readConfiguredBackendId();
    if (gateBackendId === null) {
      logError('[SyncEngine] 读不到本机设置，本轮无法判断同步后端，已中止下载');
      return { success: false, groups: [], reason: 'backend_unknown' };
    }
    // ── 2026-10-22（402）：账号闸门必须**就地**处理「服务端不可用」──────
    // 这一段原本是裸的 `await ensureAuthenticated(...)`，而它**位于 try 块之外**
    // （try 在下面第 657 行）。而生产实测里**账号校验（/auth/v1/user）就是最先
    // 402 的地方** —— 也就是说，最常走的那条路上，BackendUnavailableError
    // 会**绕过**本方法末尾那个 catch，直接冒到 SW 的
    // `.catch(err => sendResponse({ok:false, error: err?.message}))`：
    // 机器标记在那一层被吞掉 ⇒ 界面拿不到 backendUnavailable ⇒ 用户看到的
    // 仍是「上传失败，请重试」（而重试无用）。
    //
    // ── 2026-10-23（第 50 轮）：闸门返回**四档判定**（core/authGuard.ts）──
    // 三种「不许放行」各有各的下一步：
    //   · `not_authenticated` ⇒ **核到**没登录 ⇒ 「请去登录」；
    //   · `backend_unavailable` ⇒ 服务端不可用 ⇒ 「等我们恢复」；
    //   · `unknown` ⇒ **核不到**（断网等）⇒ 「现在联系不上云端」。
    // ⚠️ 第三档绝不能落成 `not_authenticated`：用户会以为要重新输密码，
    // 而断网时重新登录**必然失败** ⇒ 死循环。
    const gate = await ensureAuthenticated({
      isAuthenticated: () =>
        (store.getState() as { auth: { isAuthenticated: boolean } }).auth.isAuthenticated,
      restoreAuth: () => this.restoreAuth(),
      backendId: gateBackendId,
    });
    if (!gate.allowed) {
      if (gate.kind === 'backend_unavailable') {
        return {
          success: false,
          groups: [],
          reason: backendUnavailableCopy('download'),
          backendUnavailable: true,
        };
      }
      return {
        success: false,
        groups: [],
        reason: gate.kind === 'unknown' ? 'auth_unknown' : 'not_authenticated',
      };
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
        // 这里读到的队列就是**此刻**队列里的内容（读完立刻广播，窗口极小）。
        // 2026-10-22 审计 P0-4：撤销「恢复即消费」会把那条 id 从队列里摘掉，
        // 所以「读到时还在队列里」就是「此刻仍有效的删除意图」。
        const pendingDeletes = await storage.getPendingDeleteIds();
        if (pendingDeletes.length > 0) {
          // ⚠️ 只清**真的广播成功**的那几条（2026-10-23 审计 R-1）：账号闸门
          // 会挡下属于本机另一个账号的删除意图 ⇒ 它们没写进当前账号的云端 ⇒
          // 清队就会把这条删除意图永久丢掉（那条会话在对端复活，零提示）。
          const broadcastResult = await markCloudGroupsAsDeleted(pendingDeletes);
          // 点名本轮实际广播成功的这一批，不整队清空（队列在读走之后还会继续长，
          // 整队清会把没广播过的删除意图连坐抹掉 → 云端行仍活跃 → 复活）。
          // markCloudGroupsAsDeleted 失败会抛给下面的 catch，此时不会走到清队。
          await storage.clearPendingDeleteIds(broadcastResult.broadcastIds);
          logInfo(
            `[SyncEngine] 覆盖下载前已广播 ${broadcastResult.broadcastIds.length} 条删除意图` +
              (broadcastResult.blockedIds.length > 0
                ? `（另有 ${broadcastResult.blockedIds.length} 条属于本机上的另一个账号，未写云端、保留在队列里）`
                : '')
          );
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
          // ── 2026-10-22（402）：这一支**不能**把机器标记丢了 ──────────────
          // 原先固定返回 `reason: 'pending_upload_failed'`。而后台把这个
          // reason 归入「**保护性跳过 ⇒ 让路**」（不进退避、不通知）——
          // 于是在「云端项目被限制」时，后台会**静默地什么都不做**：
          // 既不报故障、也不推进退避、更不通知用户。而它恰恰是**真故障**，
          // 且是**不可重试**的那一类（重试无用且烧配额）。
          //
          // 保留 reason（后台靠它认「这是上传失败引起的跳过」），
          // 同时把机器标记带出去 ⇒ 后台据此归类成「云端不可用」。
          return {
            success: false,
            groups: [],
            reason: 'pending_upload_failed',
            ...(upResult.backendUnavailable
              ? { reason: backendUnavailableCopy('download'), backendUnavailable: true }
              : {}),
          };
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
      //
      // 【为什么必须连「读不出来的那几组」一起拿】（2026-10-20 D-6）
      // 云端下行时有些会话**整组读不出来**会被跳过（形状不可恢复 / 还原率
      // 不达标 / tabs 表被网关截断 / 单组处理异常）。它们的**云端行仍在**，
      // 只是**不在下载结果里**。
      //
      // 只拿「读到的」⇒ 引擎会把「云端那份没读到」误判成「云端没有这一组」：
      //   · 覆盖下载把 localGroups 整体置空 ⇒ 本机那一份被物理删除；
      //   · 删除熔断量的是「合并结果里被剔除的」⇒ 压根没进合并结果 ⇒ 熔断看不见；
      //   · droppedIds 为空 ⇒ 不登记删除广播 ⇒ 云端行也不会被标记；
      //   · success: true ⇒ 界面报成功 ⇒ 用户唯一可见信号是「列表变短了」。
      // 而 1.22.0 起删除即物理清除、无回收站 ⇒ 一次覆盖下载就足以永久清掉
      // 用户仅存于本机的那一份。
      //
      // 自带存储后端在同样情形下是 fail-closed 的（整轮抛错中止，见
      // sync-backend/webdav/adapter.ts）—— 只有云端后端是「静默少读」。
      // 读法与清单在服务层一次完成（同一轮、同一端口实例），见
      // services/downloadWithSkippedGroups.ts。
      const { groups: cloudGroups, skipped: skippedRemote } =
        await downloadGroupsWithSkipped();
      report(55, 'download');
      // 本轮被整组跳过的会话 id（云端行仍在、未写回、未登记墓碑）。
      const skippedIds = new Set(skippedRemote.map(s => s.id));
      if (skippedRemote.length > 0) {
        logWarn(
          `[SyncEngine] 云端有 ${skippedRemote.length} 个会话这轮读不出来（整组跳过）：` +
            `${skippedRemote.map(s => s.id).slice(0, 5).join('、')}` +
            `${skippedRemote.length > 5 ? ' 等' : ''}。云端那些行未被改动；` +
            '覆盖下载时本机对应的几份会被保住。'
        );
      }
      // 3. 空云端闸门（2026-10-17 修 P0）：覆盖下载必须先过这一关。
      //
      // 【为什么这一关不能省】下面第 4 步会把 localGroups 置空（覆盖语义），
      // 于是 validateMergeResult 的规则 3「合并后组数不得低于预期最小值」
      // 在覆盖路径上**恒不可达** —— 那条防线在这里形同不存在。
      // 而「本地有会话 + 云端一个字节都没有」时继续覆盖，等于用空库把本机
      // 全清空且不可逆（1.22.0 起无回收站），UI 还会显示覆盖成功。
      //
      // 【放在哪一步】必须在 cloudGroups 拿到之后、localGroups 置空之前：
      // 判据需要「云端到底有没有行」，而覆盖模式下合并阶段已经看不到本地了。
      //
      // 【为什么不看活跃行】云端只有墓碑行时收敛到空是**合法**的 —— 那正是
      // 「另一台设备把会话都删了」，必须传播。判据用总行数（含墓碑）。
      //
      // 【云端真实行数 = 读到的 + 跳过的】（2026-10-20 D-6）
      // 「云端只有 1 组、而那 1 组读不出来」时，cloudGroups.length === 0 ⇒
      // 闸门会说「云端没有任何数据」⇒ 拒绝覆盖 —— **那句文案是假的**：
      // 云端有 1 组，只是我们没拿到。
      //
      // 这个等式是**精确**的，不是近似：云端跳过路径**从不写云端**
      // （读不出来的那些行一个字节都没被动过），所以云端行数既不增也不减。
      // 墓碑行也在「读到的」里（isDeleted: true）⇒ 也在计数内。
      //
      // ── DS-2：闸门还要拦住「云端这次只读到一部分」────────────────────
      //
      // 【为什么空云端这一关挡不住它】云端只读到 1 条时 cloudTotalCount = 1
      // ≠ 0 ⇒ 闸门放行 ⇒ 而这次覆盖会把本机 49 条**物理清空**
      // （1.22.0 起无回收站、无撤销）。原缺陷更狠：删除熔断的实参取的是
      // 「合并时空壳剔除了几个」，而覆盖路径下被云端替换掉的本机会话
      // **在进合并之前就已经不在了** ⇒ 那个数恒为 0 ⇒ 熔断也看不见。
      //
      // 【判据：问后果，不猜完整性】「云端真的空了」与「云端只读到一部分」
      // 在引擎层**无法可靠区分**（端口不暴露云端总行数；两个后端的下载层
      // 各自已是 fail-closed）。所以这里不问「云端完整吗」，而问
      // **「这次覆盖会清掉本机多少个会话」** —— 那是可以算出来的事实。
      // 判据与阈值都只有一份（core/overwriteGuard.ts + core/deleteFailsafe.ts）。
      //
      // 【为什么墓碑造成的消失不计入】墓碑 = 别的设备上用户**显式删掉**了它
      // ⇒ 删除本就该传播（云端只有墓碑行 = 合法清空）⇒ 计入就变成「用户删不掉」。
      //
      // 【这里的数是合并前的估计】精确值在下面第 8 步（合并后）再算一次，
      // 那里才是最终裁决（空壳清理会让实际删除数更大）。两处同源、同阈值，
      // 且这里算出的数不大于精确值 ⇒ 这里放行的下面仍可能拦下，反之不会。
      if (opts?.forceRemote) {
        // ⚠️ 判据与下载预览**同一个函数**（core/overwriteDownloadPreserve.ts）——
        // 否则预览会预告一个与实际落盘结果相反的结果（2026-10-23 第 51 轮修的就是
        // 这个：预览把「云端读不出来、本机有副本」的那几份算成了「会被删除」）。
        const preservedBySkip = preservedLocalGroups(snapshot, skippedIds);
        const overwritePlanBeforeMerge = planOverwriteDeletion({
          localActiveIds: snapshot.filter(g => !g.isDeleted).map(g => g.id),
          // 覆盖后本机会有的会话 = 云端读到的活跃组 + 被云端「读不出来」
          // 而特意保留下来的本机组（D-6）。
          survivingActiveIds: [
            ...cloudGroups.filter(g => !g.isDeleted).map(g => g.id),
            ...preservedBySkip.map(g => g.id),
          ],
          cloudTombstoneIds: cloudGroups.filter(g => g.isDeleted).map(g => g.id),
        });
        const gate = decideForceRemoteOverwrite({
          localActiveCount: overwritePlanBeforeMerge.beforeActive,
          cloudTotalCount: cloudGroups.length + skippedRemote.length,
          overwriteDeletion: {
            beforeActive: overwritePlanBeforeMerge.beforeActive,
            wouldDelete: overwritePlanBeforeMerge.wouldDelete,
          },
        });
        if (gate.action === 'refuse') {
          this.isSyncing = false;
          // 不动本地一个字节：refuse 的全部意义就是「什么都不做」。
          if (gate.code === 'empty_cloud') {
            logError('[SyncEngine] 拒绝空云端覆盖:', gate.reason);
            return {
              success: false,
              groups: snapshot,
              reason: 'overwrite_empty_cloud_refused',
            };
          }
          // 拒绝码必须是 'failsafe_triggered'：UI 上那条文案（REASON_COPY）
          // 说的是「会丢弃过多会话，已中止以保护你的本地数据」，与这里的事实
          // 一致；若报成「云端没有任何数据」那句就是假的（云端明明有 1 条）。
          logError('[SyncEngine] 覆盖会清掉过多本机会话，已中止:', gate.reason);
          // 与下面那道熔断同处置：保留 pending_upload 让下轮重试
          // （本地数据没被动过，但本地的改动仍需要传上去）。
          await this.rescheduleUploadIfPending();
          return {
            success: false,
            groups: snapshot,
            reason: 'failsafe_triggered',
            error: gate.reason,
          };
        }
      }
      // 4. 确定本地。覆盖模式（forceRemote）= 云端完全镜像本地：本地置空，
      //    merge 退化为「云端活跃行直通」（云端墓碑行被 merge 跳过，永不入库）。
      //    正常模式剥掉本地残留的组级墓碑（老版本写入形状，见上）。
      //
      //    ⚠️ 覆盖模式下**例外**：被云端「读不出来」的那几组，本机那一份
      //    **必须保留**（2026-10-20 D-6）。
      //
      //    为什么：覆盖语义是「云端说了算」，而「说了算」的前提是**我们确实
      //    拿到了云端那一份**。读不出来 ⇒ 我们对那几组一无所知 ⇒ 把本机那份
      //    一并清掉是在拿「不知道」冒充「云端没有」。
      //
      //    为什么这不是「保护做过头」：
      //      · 被跳过的组**不在 cloudGroups 里** ⇒ mergeOpStamped 走
      //        「只有本地」分支 ⇒ 保留本地（与合并模式同一条路径）；
      //      · 它**不会**进 removedGroupIds ⇒ **不会**被登记进
      //        pendingDeleteIds ⇒ 云端行不动（云端行原封保留）；
      //      · 真正「云端说它没了」的组（墓碑行 is_deleted=true）是**另一件事**：
      //        那不是跳过，那是删除广播，照常执行（见下面 mergeOpStamped 的
      //        墓碑分支）。
      //
      //    代价（已知且可接受）：被保住的那份，其印记可能比云端旧。若云端
      //    那一行始终读不出来，两边各有一份、内容可能不同 ⇒ 不会自动收敛。
      //    那是「暂时不一致」换「永久丢失」—— 与 D-6 的设计意图一致。
      // ── 2026-10-20 D-8：剥掉本机老版本墓碑组时**必须登记删除广播** ─────────
      //
      // 缺陷形态：本地有个老版本写入的墓碑组（isDeleted=true，v1.21 的残留形状），
      // 云端那一行是**活跃**的。本机在合并前把它 filter 掉了（本地不留墓碑，
      // 见文件头「无墓碑模型」），但**没有**登记一次删除广播 ⇒
      // 云端那一行仍然是活跃的 ⇒ 下一轮下载合并时它以「云端有、本地无」的身份
      // **整组复活** ⇒ 那个「本机已经删掉的会话」在所有设备上又回来了。
      //
      // 为什么它躲过了既有的删除广播登记：
      // 登记走的是 `removedGroupIds(mergedGroups, finalGroups)` ——
      // 而墓碑组在**进合并之前**就被 filter 掉了，它压根不在 mergedGroups 里 ⇒
      // removedGroupIds 看不见它 ⇒ 队列里永远没有它 ⇒ 广播永远不发。
      //
      // 修法：剥掉的那一刻就把 id 收进「本轮要登记的删除广播」清单。
      // 登记的**时机**仍然在写入之后（与空壳剔除同一批），保证「队列已落盘」
      // 与「本地已写入」这两件事的顺序与既有路径一致。
      //
      // ⚠️ 方向为什么是「登记删除广播」而不是「保留本地那份」：
      // 本地那份是**墓碑**（用户已经删了它，或老版本已经标记了它）。
      // 保留它 = 让一个已删的会话继续存在 ⇒ 下一个本地清理才删它 ⇒
      // 用户看到「我明明删了，它又出现了」。而登记广播 = 把删除意图送到云端
      // ⇒ 下一轮云端那一行也变成墓碑 ⇒ 两边一致，且**符合用户意图**。
      //
      // 【为什么「剥掉」本身就是一次删除意图的证据】
      // 本机这个组是**墓碑**（isDeleted=true）——它是老模型（v1.21）在本地盖的
      // 删除标记。用户（或老版本设备）当时表达过「这个会话删掉」。
      // 云端那一行仍是活跃的，只说明**那份删除意图从未送达云端**。
      // 所以「本机把它剥掉」不等于「这个会话还活着」，恰恰相反：它是唯一
      // 还留着的删除证据。剥掉它之前不把意图送去云端，这条证据就随写盘
      // 一起消失了 —— 而云端那一行仍然是活跃的 ⇒ 下一轮它整组回来。
      //
      // 【与 D-6 的「被跳过组」不是一回事】
      // D-6 保护的是「本机那一份是活的，只是云端这份这轮读不出来」——
      // 那种情况下我们对云端的态度一无所知，所以不能把「读不出来」翻译成
      // 「已删除」。而本机这份是**墓碑**：删除意图有本机证据，与云端读不读得
      // 出来无关。所以这里不按 skippedIds 豁免。
      //
      // 【一个必须守住的例外】
      // 若同一个 id **同时**存在一个活跃的本机组（老版本的脏数据可能留下
      // 两条），那活跃那份才是真相（合并结果里它会胜出并留在本机）——
      // 此时把墓碑的删除意图广播出去 = 把用户还想要的会话永久删掉。
      // 所以：只登记「没有活跃副本」的墓碑 id。
      const activeLocalIds = new Set(
        snapshot.filter(g => !g.isDeleted).map(g => g.id)
      );
      const legacyLocalTombstoneIds = [
        ...new Set(
          snapshot
            .filter(g => g.isDeleted && !activeLocalIds.has(g.id))
            .map(g => g.id)
        ),
      ];
      const localGroups = opts?.forceRemote
        ? preservedLocalGroups(snapshot, skippedIds)
        : snapshot.filter(g => !g.isDeleted);
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
      //
      // ⚠️【被跳过的组必须豁免空壳剔除】（2026-10-20 D-6）
      // 被跳过的组是以「本机那一份」进入合并结果的（见上面第 4 步；合并模式下
      // 它本来就在合并结果里）。若本机那一份恰好是**零标签**（老版本残留形状 /
      // 用户清空后留下的空壳），dropSyncMergedGroups 会把它当垃圾剔掉 ⇒
      // 它进了 removedGroupIds ⇒ **被登记进 pendingDeleteIds** ⇒
      // 云端那一行被打上墓碑 ⇒ 那个「云端只是这轮没读到」的会话被**永久删除**
      // （1.22.0 起无回收站）。
      //
      // 也就是说：保护它不被「整份覆盖写」物理删除还不够，它也绝不能被
      // 「空壳清理」这条路登记成删除广播。**两道门都要守住**（合并模式同样要守：
      // 那里它进 pendingDeleteIds 的路径与覆盖模式是同一条）。
      //
      // 做法：先按既有判据剔除空壳，再把「被跳过的」那几组**放回去**。
      // 用「放回去」而不是「剔除前先排除」是为了保住**原有顺序**
      // （finalGroups 的顺序即合并结果的顺序）。
      const shellDropped = dropSyncMergedGroups(mergedGroups);
      const shellDroppedIds = new Set(removedGroupIds(mergedGroups, shellDropped));
      const finalGroups = mergedGroups.filter(
        g => !shellDroppedIds.has(g.id) || skippedIds.has(g.id)
      );

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
      //
      // ── DS-2 续：覆盖路径的实参必须换掉 ───────────────────────────────
      // 合并剔除量（mergeDropped）在覆盖路径下**恒为 0**：被云端替换掉的
      // 本机会话在**进合并之前**就被过滤掉了（见上面第 4 步），压根不在
      // mergedGroups 里 ⇒ 熔断看不见这次覆盖 ⇒ 「本机 50 条、云端 1 条」
      // 一次覆盖就物理清空 49 条（无回收站、无撤销、界面还报成功）。
      //
      // 所以熔断在覆盖路径下问的是**另一个问题**（两道闸门，各问各的）：
      //   ① 合并剔除：合并结果里被剔掉的会话数（两条路径都有，判据不变）；
      //   ② 覆盖清空：**这次覆盖会物理清除本机多少个会话**
      //      （覆盖路径专有；分母是「覆盖前本机活跃会话数」，
      //        与 ① 的分母「合并结果里的活跃组数」不是同一个量，
      //        所以不能把两个数塞进同一个实参 —— 那会让百分比变成
      //        「删了多少 / 一堆不相干的会话数」，文案会说假话）。
      const mergeDropped = removedGroupIds(mergedGroups, finalGroups);
      let verdict: FailsafeVerdict = mergeDropped.length > 0
        ? checkDeleteFailsafe(
            mergedGroups.filter(g => !g.isDeleted).length,
            mergeDropped.length
          )
        : { allowed: true };
      if (verdict.allowed && opts?.forceRemote) {
        // 精确值：合并之后才知道（空壳清理还会再剔掉一些）。
        // 「云端说了它被删掉」（墓碑行）不算这次覆盖的删除 ——
        // 那是别的设备上的显式删除，本就该传播（拦下就是「用户删不掉」）。
        const overwritePlan = planOverwriteDeletion({
          localActiveIds: snapshot.filter(g => !g.isDeleted).map(g => g.id),
          survivingActiveIds: finalGroups.filter(g => !g.isDeleted).map(g => g.id),
          cloudTombstoneIds: cloudGroups.filter(g => g.isDeleted).map(g => g.id),
        });
        if (overwritePlan.wouldDelete > 0) {
          verdict = checkDeleteFailsafe(overwritePlan.beforeActive, overwritePlan.wouldDelete);
        }
      }
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

      // ── D-8 登记：本机老版本墓碑组的删除意图（**必须早于写盘**）────────
      //
      // 顺序不是洁癖，是崩溃窗口的取舍：
      //   先登记后写盘 ⇒ 崩在中间时意图仍在队列里（多广播一次，幂等）；
      //   先写盘后登记 ⇒ 崩在中间时本机墓碑已被物理抹掉、意图**永久丢失**
      //                    ⇒ 云端那一行仍是活跃的 ⇒ 下一轮整组复活（= 本缺陷）。
      let deleteQueued = false;
      if (legacyLocalTombstoneIds.length > 0) {
        try {
          await storage.addPendingDeleteIds(legacyLocalTombstoneIds);
          deleteQueued = true;
          logInfo(
            `[SyncEngine] 登记删除广播 ${legacyLocalTombstoneIds.length} 个` +
              '本机老版本墓碑组（它们马上会被写盘抹掉；不登记的话云端那一行' +
              '仍是活跃的，下一轮整组复活）'
          );
        } catch (e) {
          // 写失败时 addPendingDeleteIds 已把整批推进内存兜底，意图仍在，
          // 仍需置位 pending_upload 让下一轮上传尝试广播（否则删除只留在内存）。
          logWarn('[SyncEngine] 登记删除广播队列失败（云端行可能残留复活）:', e);
          deleteQueued = true;
        }
      }
      await storage.setGroupsImmediate(finalGroups);
      // 广播队列必须伴随 pending_upload 置位，否则入队了也没人执行：
      // backgroundSync 只在 hasPendingUpload() 为真时才上传，而下载路径
      // 从不置这个标志 → 云端行永远标记不到 → 对端复活。
      // D-8：本机老版本墓碑组（上面已登记）+ 合并剔除的空壳组 —— 两类都要广播。
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
        },
        // ── 2026-10-20 D-6：如实上报「云端有 N 组这轮读不出来」────────────
        //
        // 为什么 success 仍然是 true：这一轮**没有硬失败**，重试也不会变好
        // （云端那行还是读不出来）。说成失败 ⇒ 界面弹「下载失败，请重试」
        // ⇒ 用户一直点重试 ⇒ 那是**误导性失败**，比谎报成功更糟。
        // 仓库已有先例：UploadResult 的 D-3 修法就是 success:true + skippedGroups。
        //
        // 为什么覆盖模式下不能只报数字：界面需要区分「合并」与「覆盖」两种
        // 事实（合并时本机那份一直都在；覆盖时那几份是被**特意保住**的），
        // 所以把 id 清单也带出去（界面按 count 出文案，id 供诊断）。
        ...(skippedRemote.length > 0
          ? {
              skippedRemoteGroups: {
                count: skippedRemote.length,
                ids: skippedRemote.map(s => s.id),
              },
            }
          : {}),
      };
    } catch (error) {
      logError('[SyncEngine] 下载合并失败:', error);
      await this.restoreSnapshot(snapshot);
      this.isSyncing = false;
      // P1-5：下载抛错/回滚后，若 pending 仍 true 必须重调度上传。
      await this.rescheduleUploadIfPending();
      // locked 标记必须保留：reason 保持人话（UI 原样展示），
      // 机器分类走 locked（backgroundSync 据此把「未配置/未解锁」算让路）。
      //
      // ── 2026-10-22（402）：下载侧同样要带机器判据 ────────────────────────
      // 与上传侧同形：reason 若是英文原文，UI 的中文判定会把它当机器串吞掉
      // （纯英文 ⇒ 命中「不含 CJK」）⇒ 用户看到「下载失败，请重试」。
      // 而「云端项目被限制」时重试无用 ⇒ 措辞必须说清「等恢复」。
      //
      // ⚠️ 本地数据**没有**被动过（快照已回滚，且下载的写盘发生在最后），
      // 所以「本地会话没丢」这句承诺在下载侧同样成立。
      const backendUnavailable = isBackendUnavailableError(error);
      return {
        success: false,
        groups: snapshot,
        reason: backendUnavailable
          ? backendUnavailableCopy('download')
          : error instanceof Error
            ? error.message
            : 'download_merge_failed',
        ...(isLockedBackendError(error) ? { locked: true } : {}),
        ...(backendUnavailable ? { backendUnavailable: true } : {}),
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
    // backendId 必须显式传，理由同上；null（同上）也必须在这里判掉：
    // 让它流进门禁 = 去查 Supabase session = 自带存储用户看到「用户未登录」。
    const gateBackendId = await readConfiguredBackendId();
    if (gateBackendId === null) {
      logError('[SyncEngine] 读不到本机设置，本轮无法判断同步后端，已中止上传');
      return { success: false, error: '读不到本机设置，已中止同步以免把数据传到错误的后端' };
    }
    // ── 2026-10-22（402）：账号闸门必须**就地**处理「服务端不可用」──────
    // 与 downloadAndMerge 同形：这一段位于 try 块之外（try 在下面），
    // 而生产实测**账号校验（/auth/v1/user）就是最先 402 的地方** ——
    // 也就是说，最常走的那条路上「服务端不可用」会**绕过**本方法末尾的
    // catch，直接冒到 SW 的通用 `.catch`，机器标记在那一层被吞掉，
    // 界面于是又看到「上传失败，请重试」（而重试无用）。
    //
    // ── 2026-10-23（第 50 轮）：闸门返回**四档判定**（core/authGuard.ts）──
    // 上传方向与下载方向必须**同一口径**：`not_authenticated`（核到没登录）
    // 与 `unknown`（核不到）是两件事，措辞也不同。
    const gate = await ensureAuthenticated({
      isAuthenticated: () =>
        (store.getState() as { auth: { isAuthenticated: boolean } }).auth.isAuthenticated,
      restoreAuth: () => this.restoreAuth(),
      backendId: gateBackendId,
    });
    if (!gate.allowed) {
      if (gate.kind === 'backend_unavailable') {
        return {
          success: false,
          error: backendUnavailableCopy('upload'),
          backendUnavailable: true,
        };
      }
      // ⚠️ `auth_unknown` 与 `not_authenticated` 分开：前者是「核不到」
      // （本地数据没丢、检查网络即可），后者是「核到没登录」（要去登录）。
      return {
        success: false,
        error: gate.kind === 'unknown' ? 'auth_unknown' : 'not_authenticated',
      };
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
      // 抑制是**自带存储专属**的概念（只有 webdav 适配器会走「远端无 manifest ⇒ 全量」
      // 那条路）。这里显式判一次后端：一个残留的待决标志（用户切回 TapStack 云端后
      // 没人清它）不该让云端上传也按白名单过滤 —— 那份白名单早被清空了，
      // 结果是「什么都传不上去」，而用户以为在同步。
      //
      // 判据本身在 decideSuppressFullUpload（纯函数）：读不到设置时它保持
      // 抑制，理由与变异判据见那里的注释（M1）。
      const configuredBackendId = await readConfiguredBackendId();
      const suppressFullUpload = decideSuppressFullUpload({
        firstSyncPending,
        explicitFirstSync,
        overwriteCloud,
        configuredBackendId,
      });

      // ── 2026-10-18 P1#4 第二半：待决期只上传**本次操作改动过的会话** ────────
      // 光靠适配器的 `selectDirty(groups, 水位)` 拦不住：远端还没有 manifest 时
      // 水位恒为 0，全部历史会话都被判成脏，于是「只保存一个标签页」照样把
      // 全部历史推上用户的云盘（抑制是死代码，2026-10-18 实测抑制前后内容逐字相同）。
      // 判据因此换成写方一路记下来的 id（保存路径 + mutation 命令，见
      // core/mutationAffectedGroups）；读不到 ⇒ 空集 ⇒ 什么都不传（fail-closed：
      // 待决期少传只是「留在本机等用户决定」，多传才是违约）。
      // ── 2026-10-23（DS-43-19）：白名单快照**每一轮都要读** ─────────────────
      // 待决期它决定「本轮允许传哪些会话」；普通轮次它决定「本轮能消费掉哪些
      // 登记」（见本轮末尾的结案分支）。
      //
      // 为什么普通轮次也要读：白名单是**共享可变状态**，写方随时在往里加 id。
      // 清理时若不知道「轮次开始时里面有哪些」，就只能整表清 ⇒ 会把「读完之后
      // 才登记进来的」一起抹掉 ⇒ 那批改动永远没人再传（DS-43-19）。
      //
      // ⚠️ 读失败 ⇒ 空集（getPendingUploadGroupIds 的 fail-closed 方向）：
      // 待决期什么都不传（少传只是「留本机等用户决定」，多传才是违约）；
      // 普通轮次则「消费不到任何登记」⇒ 白名单原样保留 ⇒ 下一轮再清。
      const registrySnapshotIds = await storage.getPendingUploadGroupIds();
      const changedGroupIds = suppressFullUpload ? new Set(registrySnapshotIds) : null;
      // ── 2026-10-20 D-10：「登记不可信」标志的**完整状态** ───────────────
      // 标志是**持久化**的：写入失败可能发生在**上一次**上传之前，
      // 那一轮的失败不能因为进程重启就消失。
      //
      // 两个位（见 core/uploadCoverage 的 decideRegistryAfterUpload）：
      //   · unreliable —— 登记机制此刻不可信（最近一次登记失败了）；
      //   · gapOpen —— 之前漏登记的那批改动**至今没被全量补传过**。
      //
      // 轮次开始时先读一次（快照）：轮次结束时要判断「本轮是否补上了漏登记
      // 的那批」⇒ 需要一个「本轮提交的是不是全量」的事实。
      const registryStateBefore = await storage.getPendingUploadRegistryState();
      // gapOpen ⇒ 漏登记的那批 id 已经不知道 ⇒ 唯一的兜底是「全量传一次」。
      const needsFullScope = registryStateBefore.gapOpen;
      if (needsFullScope) {
        logWarn(
          '[SyncEngine] 此前有一次「本次改动的会话 id」登记失败，漏登记的那批改动' +
            '尚未补传：本次若走全量（归属待决期之外）就会被一并带上去；' +
            '若正处于归属待决期则本轮不许全量（不能替用户做归属决定），' +
            '缺口会保留到用户完成归属决策的那一次上传。'
        );
      }
      // ── 2026-10-20 D-10：漏登记的那批改动**靠一次全量补上** ─────────────
      // 登记失败 ⇒ 那批改动的 id 压根没记下来 ⇒ 事后无法枚举它们
      // ⇒ 唯一的兜底是「把本机有的全传一遍」（多传无害：后端按印记幂等）。
      //
      // ⚠️ 但**不许**为了补这个缺口而绕过归属决策：归属待决期（suppressFullUpload）
      // 禁止自动全量 —— 那正是「用户还没决定历史会话归谁」的保护。
      // 那种情况下本轮**不能**全量 ⇒ 缺口保持开着 ⇒ 本轮如实上报
      // 「无法确认全部已同步」⇒ 用户完成归属决策的那一次上传（explicitFirstSync
      // ⇒ 全量）自然把缺口补上。
      //
      // ℹ️ 这里**不需要**一条「强制全量」的分支：白名单过滤只在归属待决期
      // 生效（changedGroupIds !== null ⟺ suppressFullUpload），而那一期
      // 本来就不许自动全量 ⇒ 其它轮次**天然就是全量**（activeGroups）⇒
      // 缺口在下一轮普通上传里自然被补上。写一条「强制全量」分支只会是
      // 永远走不到的死代码（它的每个前置条件都与另一条互斥）。
      const groupsForUpload = overwriteCloud
        ? allGroups
        : changedGroupIds
          ? activeGroups.filter(g => changedGroupIds.has(g.id))
          : activeGroups;
      // 本轮的上传清单是不是**由登记集合（白名单）决定**的（结构事实）。
      // 它决定「登记不可信」这个标志**是否影响本轮结论**（见 uploadCoverage 的
      // scopeDerivedFromRegistry）：白名单过滤 ⇒ 登记漏了就是真漏了；
      // 全量 ⇒ 登记漏没漏都不影响本轮传了什么。
      const scopeDerivedFromRegistry = changedGroupIds !== null;
      if (suppressFullUpload) {
        logInfo(
          '[SyncEngine] WebDAV 首次同步归属决策未完成：本次只上传本次操作改动过的 ' +
            `${groupsForUpload.length} 个会话（本机共 ${activeGroups.length} 个），` +
            '其余会话等你到设置里点「检查并推送」后再决定归属'
        );
      }
      // ── 2026-10-20 D-3：本轮**登记了**的待传会话 id（白名单快照）────────
      // 这份快照是本轮结束时的对账基准：只有「登记的 ⊆ 上行的 ∪ 已删除结案的」
      // 才允许清 pending_upload 与白名单（判据见 core/uploadCoverage）。
      // 登记集合在**上传前**取快照：上传期间新登记的改动属于下一轮，
      // 混进来会让本轮永远对不上账（每一轮都有新登记 ⇒ 永远不清）。
      const registeredGroupIds = changedGroupIds ? [...changedGroupIds] : [];
      // 本轮真的提交给后端裁决的会话 id（后端认输的也算「已裁决」）。
      let submittedGroupIds: string[] = [];
      // 本轮被账号闸门挡下的会话（属于本机上的另一个账号，2026-10-22 DS-1 收口）。
      // 它们**不算已提交、也不算未同步**（见 core/uploadCoverage.ts 的注释）。
      let blockedByAccountScope = new Set<string>();
      // 闸门仍按**活跃组**判（不是按过滤后的清单）：覆盖模式下的「本地一个活跃组都没有
      // ⇒ 绝不覆盖」是既有保护，不能因为待决期把清单过滤空了就改判成「跳过覆盖」。
      // 清单为空时连适配器都不必调（省一次读 manifest + 解锁，也避免在空远端上写出
      // 一份「零会话」的 manifest）。
      if (activeGroups.length > 0 && groupsForUpload.length > 0) {
        // 覆盖模式把残留墓碑一起交给 uploadTabGroups：覆盖会先删空云端，墓碑必须
        // 随同一次 upsert 写上云（selectRowsForUpload 决定实际写入哪些行），
        // 否则删除意图随覆盖一起丢失，另一端的活跃副本下次合并即复活。
        const up = await uploadTabGroups(
          groupsForUpload,
          overwriteCloud,
          explicitFirstSync
        );
        // 「提交给后端裁决」的集合 = 本轮交给适配器的清单。
        // 后端可能**认输**（远端更新 → 本地不上行，等下次下载合并物理替换），
        // 认输是「已裁决」而不是「没传上去」—— 把它算成未同步会让 pending_upload
        // 永远清不掉、上传陷入无限重试。
        //
        // ⚠️ 账号闸门拦下的那批**不在**这个集合里（2026-10-22 DS-1 收口）：
        // 它们根本没进上行集合 ⇒ 不算「已提交」⇒ 必须从清单里剔出去。
        // 不剔的后果有两条，都很坏：
        //   ① 用户看不到「还有 N 个会话没同步」（对账认为它们传上去了）；
        //   ② 「本轮是全量」被误判成 true ⇒ 漏登记的那批改动被当成已补上
        //      ⇒ 可能永远补不回来。
        const blockedIds = up?.blockedAccountIds ?? [];
        blockedByAccountScope = new Set(blockedIds);
        submittedGroupIds = groupsForUpload
          .map(g => g.id)
          .filter(id => !blockedByAccountScope.has(id));
        writtenTombstoneIds = new Set(up?.writtenTombstoneIds ?? []);
        // ── 2026-10-23 回归审计 R-1：后端说「覆盖没发生」，这里必须信它 ──────
        //
        // 覆盖 = 「先 DELETE 掉云端该账号的全部行，再把本机的写上去」。当账号
        // 闸门放行 0 个（换账号后本机会话都属于上一个账号）时：
        //   旧行为 = DELETE 照做、upsert 写 0 行 ⇒ 当前账号的云端被**整个删空**，
        //            而界面上报的是「上传成功」—— 数据丢失 + 谎报成功。
        //   现在   = 后端跳过覆盖（云端原样保留）并把「跳过了」如实报上来。
        //
        // 引擎这一层要做的只有一件：**把这件事透出去**，让界面不要说「已覆盖」。
        // 注意 `up.overwroteRemote` 回答的是「请求是不是覆盖模式」，
        // **不能**用它判断「覆盖有没有发生」。
        if (up?.overwriteSkipped) {
          logWarn(
            `[SyncEngine] 覆盖上传被跳过（${up.overwriteSkipped}）：云端数据原样保留，` +
              '本轮没有覆盖云端。'
          );
          skippedOverwrite = up.overwriteSkipped;
        }
        // 2026-10-20 修 P0：云端索引丢过（indexRebuilt）或本机水位线把某些
        // 会话误判成「已上传」（recoveredIds）—— 这是**要告诉用户**的异常，
        // 不是常规增量。如实上报，不让修复悄悄发生。
        if (up?.indexRebuilt) {
          logWarn(
            '[SyncEngine] 云端索引（manifest）曾丢失，本轮已从云盘分片目录重建并写回。' +
              '如果其它设备上的会话「消失了」，先重新同步一次。'
          );
        }
        if (up?.recoveredIds && up.recoveredIds.length > 0) {
          logWarn(
            `[SyncEngine] 有 ${up.recoveredIds.length} 个会话曾被水位线误判为「已上传」` +
              '（云端索引与实际内容脱节），本轮已强制补传。'
          );
        }
      } else if (overwriteCloud) {
        // ponytail: 与旧 uploadTabsToCloudFlow 的空本地保护一致——本地没有任何活跃组时
        // 绝不执行覆盖模式（覆盖 = 先删云端全部再插），否则会把云端数据清空。
        // 该保护本身是对的，但结果必须让调用方看得见（见 UploadResult.skippedOverwrite）：
        // 继续走到 report(70) 并 success 只会让 SyncButton 弹「上传成功」，
        // 而这次覆盖根本没发生。
        logWarn('[SyncEngine] 覆盖上传被跳过：本地没有活跃组（保留云端数据）');
        skippedOverwrite = 'no-active-groups';
      } else if (suppressFullUpload) {
        // 待决期本次没有任何「本次改动过的会话」可传（例如刚保存的会话又被删了）。
        // 什么都不传是正确行为；删除意图走 pendingDeleteIds 那条独立广播路径。
        logInfo('[SyncEngine] 待决期本次没有改动过的会话需要上传');
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
      //
      // ── 2026-10-22 审计 P0-4：只广播「此刻仍在队列里」的删除意图 ──────
      //
      // 队列里的一条删除意图，随时可能被**撤回**：「恢复即消费」被撤销时，
      // 撤销动作会把那条 id 从队列里摘掉（storage.retractPendingDeleteIds）。
      //
      // 【为什么队列必须在这里读，而不是用本轮开头读到的那份清单】
      // 若写墓碑用的是**读队列时**那份清单，就会给一条**已经被撤回**的意图
      // 写墓碑：墓碑的印记是写墓碑这一刻才取的 ⇒ 必然比撤销写下的记录**新**
      // ⇒ 撤销被静默推翻（本地卡片回来了，别的设备上却没了），而用户看到的
      // 是「撤销成功了」—— 这是最坏的一种骗人。
      // 在写墓碑前重读队列 ⇒ 撤掉了就不写。墓碑不写 ⇒ 云端那一行仍是活跃行 ⇒
      // 下一轮上传把恢复出来的记录写上去（印记更新）⇒ 撤销在所有设备上都成立。
      //
      // 【为什么「上传期间发生的撤销」也不会漏】
      // 上传与语义命令在 SW 的**单写者队列**里串行（background/mutationQueue.ts）：
      // 撤销要么整块排在上传之前（意图已撤回 ⇒ 这里读到的队列里没有它），
      // 要么整块排在上传之后（墓碑已写 ⇒ 撤销取**更新的印记**把云端行复位）。
      // 两种顺序都不会出现「墓碑写在撤销之后、印记却比撤销旧」的分叉。
      //
      // 【为什么不按「本机还有这条记录就别写墓碑」那种判据】
      // 那条判据是错的：下载合并会把**云端的活跃副本**带进本机
      // （老版本墓碑组被剥掉后，云端那一行仍是活跃的，本机因此又有了这条
      // 记录）—— 此时删除意图**必须**照写，否则那条「本机已经删掉的会话」
      // 下一轮又从云端回来（tests/legacyTombstoneDeleteBroadcast 守的就是它）。
      // 判据得是「意图还在不在队列里」，而不是「记录在不在本机」。
      //
      // ⚠️【队列这一支**不能**套 writtenTombstoneIds 那个过滤器】
      // 那个过滤器的语义是「这条墓碑本轮 upsert 已经写上云了，别再写一遍」。
      // 而端口的 writtenIds 在两个后端含义不同：Supabase 只报墓碑 id，
      // WebDAV 报的是**本轮写上远端的全部 id**（含活跃行）—— 于是「本轮刚
      // 写成活跃行的那个 id」也会被当成「墓碑已写」⇒ 它的删除意图被跳过 ⇒
      // 云端行刚被写成活跃就再也不会标墓碑 ⇒ 已删会话在别的设备上复活
      // （= tests/legacyTombstoneDeleteBroadcast 守的那个缺陷）。
      // 所以队列这一支保持「不筛选」，只按「此刻还在不在队列里」判定。
      const pendingDeleteIds = await storage.getPendingDeleteIds();
      const cloudDeleteIds = [...new Set([
        ...pendingDeleteIds,
        ...legacyTombstoneIds.filter(id => !writtenTombstoneIds.has(id)),
      ])];
      // 本轮**真的广播成功**的删除 id（只有这些才算「已结案」）。
      // 广播失败会抛给外层 catch ⇒ 根本走不到对账；
      // includeDeleted=false（仅测试）时压根没广播 ⇒ 不能算结案。
      let broadcastDeleteIds: string[] = [];
      // 广播与清队必须成对：includeDeleted===false 时这一轮**根本没广播**，
      // 此时清队等于把删除意图直接丢弃 —— 方向与 fail-closed 正好相反。
      // 所以清队放进同一个 if，且只在 markCloudGroupsAsDeleted 成功返回后才执行
      // （它失败会抛给外层 catch，整批要么都确认、要么整批留下等下轮）。
      if (cloudDeleteIds.length > 0 && opts?.includeDeleted !== false) {
        // ── 2026-10-23 审计 R-1：清队必须按**真的广播成功**的那几条 ──────
        // 账号闸门（后端内部，utils/supabase/upload.ts 的 markCloudGroupsAsDeleted）
        // 会挡下一部分：它们属于本机上的**另一个账号** ⇒ 不能写进当前账号的
        // 云端（越权写），而且读回校验会把「云端没有这行」判成「意图已达成」
        // ⇒ 清队就把这条删除意图**永久丢掉** ⇒ 那条会话在它真正的主人账号下
        // **复活**（零提示，v1.22.0 起无回收站不可逆）。
        //
        // ⇒ 只清 `broadcastIds`（真的写上云端、读回确认过的），被挡下的那几条
        // 留在队列里，等用户登录到那个账号时再广播。
        const broadcastResult = await markCloudGroupsAsDeleted(cloudDeleteIds);
        broadcastDeleteIds = broadcastResult.broadcastIds;
        if (broadcastResult.blockedIds.length > 0) {
          logWarn(
            `[SyncEngine] ${broadcastResult.blockedIds.length} 条删除意图属于本机上的另一个账号，` +
              '本轮没有写进当前账号的云端，删除意图保留在队列里（登录到那个账号时再广播）'
          );
        }
        // 按本轮实际广播成功的清单消费队列，而不是整队清空：一轮上传期间队列
        // 还会继续长（读走 A 之后用户又删了 B，B 写 KV 失败只落进内存兜底），
        // 整队清空会把没广播过的 B 连坐抹掉 → 云端行仍活跃 → 下次合并整组复活，
        // 且 v1.22.0 起无回收站、用户无法找回。详见 storage.clearPendingDeleteIds。
        await storage.clearPendingDeleteIds(broadcastDeleteIds);
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

      // ── 2026-10-20 D-3：清 pending_upload 必须**对过账** ────────────────
      // 修复前这里是「无条件清」：不管本轮到底传上去多少，pending_upload 与
      // 增量白名单一律清掉。归属待决期的白名单里全是不存在的 id 时
      // （导入路径登记的是备份文件里的 id，而落盘时 id 被重新生成），
      // 上传集合是空集、流程照样走完 ⇒ 20 个导入的会话永远到不了云盘，
      // alarm 与 60s 轮询也不再重试（pending_upload 已是 false），界面毫无提示。
      //
      // 现在：清标志的**前提**是「登记的待传集合 ⊆ 本轮上行的 ∪ 已删除结案的」。
      // 不满足 ⇒ **保留** pending_upload（下一轮继续重试）并把事实报给调用方。
      // ── 2026-10-20 D-10：标志的复位**搬出**对账分支 ─────────────────────
      // 原来的复位写在 `if (coverage.canClearPending)` 之内 ⇒ 标志为真 ⇒
      // 判据为假 ⇒ 复位永远执行不到（**自锁**）：标志一旦置上就永不复位 ⇒
      // pending_upload 永远清不掉 ⇒ 每轮后台同步都在重跑上传，界面还报
      // 「同步成功」。
      //
      // 现在的复位判据（decideRegistryAfterUpload）依据的是**一件事实**，
      // 与「对账是否通过」**完全无关**：
      //   「本轮提交出去的是**全量**」⇒ 漏登记的那批就在这份全量里 ⇒ 缺口补上
      //   ⇒ 标志整体清掉。
      //
      // ⚠️ 写方侧还有**另一条**独立的复位路径（「本次登记成功」，
      // 见 scheduleUpload）—— 两条都依据事实，都不自指。
      //
      // 「全量」在这里是**数出来的**，不是推断的：本轮提交出去的会话 id
      // 必须**覆盖本机全部活跃会话**。只靠「清单是不是 activeGroups」来判，
      // 会在「本机有会话但一个都没提交」时误判成全量（空集 ⊆ 全集）⇒
      // 缺口被错误地清掉 ⇒ 漏登记的那批永远补不回来。
      //
      // ⚠️ 本机一个活跃会话都没有时，「覆盖全部」是**空真**——这是对的：
      // 本机没有会话 ⇒ 漏登记的那批（若有）只能是已被删掉的那些 ⇒ 它们走
      // 删除广播那条路（pendingDeleteIds），不归上传管。若在这里判成 false，
      // 缺口会永远开着 ⇒ pending_upload 永远清不掉 ⇒ 又变成无限重试。
      // 「本轮是不是全量」的判据范围 = **当前账号的**活跃会话。
      //
      // ⚠️ 属于别的账号的会话（账号闸门挡下）必须排除（2026-10-22 DS-1 收口）：
      // 它们**永远**不会进上行集合 ⇒ 把它们算进「活跃会话」的话，
      // 「本轮覆盖了全部活跃会话」永远为 false ⇒ 「漏登记的那批已被全量补上」
      // 这个缺口永远关不上 ⇒ pending_upload 永远清不掉 ⇒ 无限重试。
      const activeIds = new Set(activeGroups.map(g => g.id));
      const submittedIdSet = new Set(submittedGroupIds);
      const submittedCoversAllActive = [...activeIds]
        .filter(id => !blockedByAccountScope.has(id))
        .every(id => submittedIdSet.has(id));
      const registryDecision = decideRegistryAfterUpload({
        before: registryStateBefore,
        // 本轮提交的是不是全量（本机每一个活跃会话都在提交清单里）。
        submittedFullScope: submittedCoversAllActive,
      });
      // 落盘标志的**新状态** —— 判据由纯函数给出（decideRegistryAfterUpload），
      // 存储层只负责**忠实落盘**（不许自己另有一套判据：两处漂移过一次，
      // 后果是「纯函数说保留 gapOpen、存储层把键删了」⇒ 漏登记的那批永远
      // 补不上 ⇒ 静默丢失）。
      // ⚠️ 带 gen 并发保护：轮次进行中若又发生一次登记失败（gen 变了），
      // 那批改动**不在**本轮提交的全量里 ⇒ 不许复位（否则它永远补不回来）。
      let registryStateAfter = registryDecision.after;
      if (registryDecision.changed) {
        registryStateAfter = await storage
          .setPendingUploadRegistryStateIfUnchanged(registryStateBefore.gen, registryDecision.after)
          .catch(err => {
            logWarn('[SyncEngine] 更新「登记不可信」标记失败（下轮上传再更新）:', err);
            return registryStateBefore;
          });
        if (registryStateAfter.unreliable || registryStateAfter.gapOpen) {
          logWarn(
            '[SyncEngine] 「登记不可信」标记未清除：本轮上传期间又发生了一次登记失败' +
              '（那一批改动不在本轮提交的全量里），标记继续保留，下一轮全量补传。'
          );
        }
      }

      const coverage = reconcileUploadCoverage({
        registeredIds: registeredGroupIds,
        submittedIds: submittedGroupIds,
        uploadPerformed: submittedGroupIds.length > 0,
        // 用**本轮结束后的真实状态**（不是「期望状态」）：并发保护可能拒绝复位
        // （轮次进行中又失败了一次）⇒ 那时缺口仍开着 ⇒ 本轮不得宣称「都传了」。
        registryUnreliable: registryStateAfter.unreliable,
        registryGapOpen: registryStateAfter.gapOpen,
        // 本轮的清单是不是**由白名单**决定的（缺省 true = 保守）。
        scopeDerivedFromRegistry,
        // 本轮以删除结案的会话：它们**不该**被上行（本地已经没有这个会话），
        // 所以不能算「未同步」—— 它们的删除意图走 pendingDeleteIds 那条路径。
        //
        // ⚠️ 只算**真的广播成功**的那些（broadcastDeleteIds），而不是队列里的
        // 全部（cloudDeleteIds）：广播失败会抛到外层 catch（走不到这里），
        // 而 includeDeleted=false 时压根没广播 —— 那种情况下把队列里的 id
        // 当成「已结案」会让「删了但没广播出去」的会话被算作「没问题」，
        // 白名单被清掉，删除意图就永远丢了。
        deletedIds: broadcastDeleteIds,
        // 属于别的账号的那批（账号闸门挡下）：不参与本账号的对账 ——
        // 它们不是「没传上去」，是「不该传给这个账号」。
        notThisAccountIds: [...blockedByAccountScope],
      });

      await storage.setLastSyncTime(new Date().toISOString());
      const now = new Date().toISOString();
      await storage.setLastUploadTime(now);
      // ponytail: 上传成功才清持久化 pending_upload。失败时保留，下一轮
      // alarm / 后台轮询重新尝试。cancelPendingUpload 不清这个标志——
      // “本地有变更”这个事实在 upload 真正成功前都成立。
      //
      // ⚠️ 2026-10-20 D-3：清位现在**以对账结果为前提**。
      // 对不上账 ⇒ 保留标志（本轮有东西没传上去）⇒ 下一轮会重试。
      //
      // ⚠️ 2026-10-20 D-10：「登记不可信」标志的复位**不在**这个分支里
      // （它曾经在这里 ⇒ 自锁）。它在上面按「写方登记成功 / 本轮是全量」
      // 这两条与对账无关的事实独立复位。
      // ── 2026-10-23（DS-43-19）：结案 = **按确认逐条消费** + **残余说了算** ──
      //
      // 原实现：`setPendingUpload(false)` + **整表清**白名单（kvRemove）。
      // 两个动作各自都能把「还有没传完的东西」清成「都传完了」：
      //   · 整表清把「本轮期间才登记进来的」一起抹掉；
      //   · 清标志用的判据是「**轮次开始时**的快照」，看不见那批新登记。
      // ⇒ 结果：改动留在本机、永远不上云，而界面报「同步成功」。
      //
      // 现在：
      //   ① **按确认逐条消费**（storage.consumePendingUploadGroupIds）：
      //      只删「轮次开始时的快照 ∩ 本轮真的结案」的那批 ⇒ 晚到的登记活下来
      //      （形状与删除广播队列的 clearPendingDeleteIds 一致，见那里的理由）。
      //   ② **残余说了算**：消费完重新读，剩下的就是「真的还没传完的」⇒
      //      待传标志按残余置位 ⇒ 下一轮会接着传。
      //   ③ 消费失败 ⇒ 按「还有东西没传完」处理（fail-closed：宁可多传一轮）。
      //
      // ⚠️ 为什么「消费」这一步的判据在纯函数里（decideConsumableRegistryIds）：
      // 「本轮能消费掉哪些 id」是纯集合运算；放纯函数才不会在
      // 「存储层顺手清一遍」与「引擎点名消费」之间漂移一次。
      let residualIds: string[] = [];
      let consumeFailed = false;
      if (coverage.canClearPending) {
        const consumable = decideConsumableRegistryIds({
          snapshotIds: registrySnapshotIds,
          // 本轮真的结案的：上行成功 ∪ 删除已广播 ∪ 不属于当前账号（被闸门挡下）。
          settledIds: [
            ...submittedGroupIds,
            ...broadcastDeleteIds,
            ...blockedByAccountScope,
          ],
          submittedFullScope: submittedCoversAllActive,
        });
        try {
          residualIds = await storage.consumePendingUploadGroupIds(consumable);
        } catch (err) {
          consumeFailed = true;
          logWarn(
            '[SyncEngine] 消费「本次改动的会话 id」失败（保守：保留待传队列，下轮重试）:',
            err
          );
        }
        const settle = decidePendingAfterRegistryConsume({ residualIds, consumeFailed });
        // 残余非空 ⇒ 「本轮期间还有改动登记进来」⇒ 待传标志必须留着
        // （清掉它就等于宣布「都传完了」，而那批改动还没上去）。
        await storage.setPendingUpload(settle.keepPending);
        if (settle.keepPending) {
          logInfo(
            `[SyncEngine] 本轮上传期间又登记了 ${residualIds.length} 个会话的改动` +
              '（不在本轮开始时的快照里 ⇒ 本轮没传它们）' +
              '，已保留待传队列，下一轮会自动补传。'
          );
        }
      } else {
        logError(
          `[SyncEngine] 本轮有 ${coverage.unsyncedCount} 个会话没有上传到云端` +
            (coverage.registryUnreliable ? '（且「本次改动的会话 id」登记曾失败，漏登记的改动无法确认）' : '') +
            (coverage.registryGapOpen ? '（此前漏登记的那批改动尚未被一次全量上传覆盖）' : '') +
            '，已保留 pending_upload 等待下一轮重试。涉及的会话 id：' +
            `${coverage.unsyncedIds.slice(0, 5).join('、')}${coverage.unsyncedIds.length > 5 ? ' 等' : ''}`
        );
      }
      report(100, 'none');
      this.isSyncing = false;
      // ── 如实上报「有东西没传上去」 ────────────────────────────────────
      // success 仍然是 true（这一轮的其他环节：墓碑广播、TTL 清理、设置上传
      // 都真的完成了），但**不是「全部同步」**。事实放在两个字段里：
      //   · skippedGroups —— 数量（机器可读）；
      //   · error —— 人话（UI 走 resolveSyncFailureCopy，未登记的句子原样透出）。
      //
      // ⚠️ 为什么不给 `success: false`：那会让后台轮询把本轮判成故障并进入
      // 退避阶梯，而实际上「下次重试」正是我们要的行为（保留 pending_upload）。
      // 更糟的是它会走「上传未成功 ⇒ 跳过下载」，把一次**部分成功**的上传
      // 说成整体失败。
      //
      // ── D-10：还有第三种「没同步完」——「无法确认」 ──────────────────────
      // 「漏登记的那批改动至今没被全量覆盖」时，unsyncedCount 可能是 0
      // （登记集合对得上账！），但「全部都传上去了」这句话**无法证明**。
      // 旧代码只按 unsyncedCount>0 决定要不要报 ⇒ 这种情况界面报「同步成功」
      // —— 那正是自锁期里界面在撒谎的地方。现在由 `cannotConfirmAllSynced`
      // 统一裁决：它为 true ⇒ 必须带上「无法确认」的事实与文案。
      const cannotConfirmAllSynced = coverage.cannotConfirmAllSynced;
      return {
        success: true,
        ...(skippedOverwrite ? { skippedOverwrite } : {}),
        ...(coverage.unsyncedCount > 0
          ? { skippedGroups: coverage.unsyncedCount, skippedGroupIds: coverage.unsyncedIds }
          : {}),
        ...(coverage.unsyncedCount > 0
          ? { error: `${coverage.unsyncedCount} 个会话尚未同步到云端（已保留待传队列，下一轮会自动重试）` }
          : {}),
        // ── 2026-10-23（DS-43-19）：「本轮期间才登记进来的改动」也要如实报 ──
        // 这批 id 不在本轮开始时的快照里 ⇒ 本轮**没传**它们 ⇒ 说「同步成功」
        // 是不老实的（那正是本缺陷的用户可见面）。
        //
        // ⚠️ 为什么**不说**「N 个会话尚未同步到云端」：那句话在普通轮次里
        // 可能是**假的** —— 普通轮次上传的是本机全部活跃会话，而那个会话
        // 很可能**已经**随本轮上去了（本轮只是没看到它的登记）。
        // ⇒ 只说能被这一轮的事实支撑的话：期间有改动、队列留着、下一轮补传。
        //
        // 它走的是与「未同步」**同一条通道**（skippedGroups + error）⇒
        // SW 的 SYNC 回包据此把 ok 置 false ⇒ 界面弹这句人话，而不是
        // 「上传成功」。下一轮补传成功后界面会再报一次成功。
        ...(residualIds.length > 0
          ? {
              skippedGroups: residualIds.length,
              skippedGroupIds: residualIds,
              error:
                `本轮上传期间有 ${residualIds.length} 个会话被改动，已保留待传队列，` +
                '下一轮会自动补传',
            }
          : {}),
        // 「无法确认全部已同步」：数量可能为 0，但「都传完了」这句话无法证明。
        // 调用方（SW 的 SYNC 回包）据此把 ok 置 false ⇒ 界面弹提示而不是
        // 「上传成功」。字段缺失（老调用方）⇒ 行为与从前一致。
        ...(cannotConfirmAllSynced
          ? {
              cannotConfirmAllSynced: true,
              ...(coverage.unsyncedCount === 0
                ? {
                    error:
                      '本次同步无法确认是否全部完成：有一次「改动记录」写入失败，' +
                      '可能有改动没被登记、也就没被上传。已保留待传队列；' +
                      '下一轮会改用全量上传把可能漏掉的改动补齐（若正在等待' +
                      '「云盘归属」决策，请先到设置里完成那一步）。',
                  }
                : {}),
            }
          : {}),
      };
    } catch (error) {
      logError('[SyncEngine] 上传失败:', error);
      this.isSyncing = false;
      errorHandler.handle(error as Error, {
        showToast: false,
        logToConsole: true,
        severity: 'medium',
        fallbackMessage: '数据上传失败',
      });
      // ── 2026-10-22（402）：「云端整体不可用」要**带着机器判据**出本层 ────
      // 这一层是上传结果**唯一**的出口（后台轮询与 popup 手动同步都消费它）。
      // 原先 `error instanceof Error ? error.message : '上传失败'` 有两个问题：
      //   ① postgrest-js 的错误**不是 Error 实例** ⇒ 直接落成「上传失败」，
      //      message 与状态码一起丢；
      //   ② 即便是 Error，message 也是英文原文 ⇒ 中文判定会把它当机器串
      //      吞掉（纯英文 ⇒ 命中「不含 CJK」）⇒ 用户看到「请重试」。
      //
      // 归一在**这里**（最后一层还能拿到 `code` 的地方）⇒ 引擎的返回形状
      // 多一个 `backendUnavailable: true` 机器标记，UI 与后台据此说人话。
      //
      // ⚠️ `error` 字段仍保留人话（不是英文原文）：UI 的 resolveSyncFailureCopy
      // 会原样透出含中文的句子；机器标记单独走 `backendUnavailable`。
      const backendUnavailable = isBackendUnavailableError(error);
      return {
        success: false,
        error: backendUnavailable
          ? backendUnavailableCopy('upload')
          : error instanceof Error
            ? error.message
            : '上传失败',
        ...(isLockedBackendError(error) ? { locked: true } : {}),
        ...(backendUnavailable ? { backendUnavailable: true } : {}),
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
    // ── 2026-10-22（402）：「云端整体不可用」不许被吞成「没登录」──────────
    // 原先 `.catch(() => null)` 把**所有**失败都读成「恢复不出来」⇒ 返回 false
    // ⇒ 整个同步说「用户未登录」。而生产实测（项目被封禁）：账号校验请求本身
    // 返回 402 —— 他明明登录着，却被告成「没登录」。
    //
    // ── 2026-10-23（第 50 轮）：**不再有任何 catch** ────────────────────
    // 修复前这里还有一句 `.catch(err => { if (isBackendUnavailableError(err)) throw err; return null; })`
    // —— 那句把「断网 / 超时」也压成了 null ⇒「恢复不出来」⇒「没登录」。
    //
    // 现在由 `getCurrentUser` 自己分档（见 core/sessionFailure.ts）：
    //   · **核到**没会话 ⇒ resolve(null) ⇒ 这一支返回 false ⇒「确实没登录」；
    //   · 核不到（断网 / 402 / 令牌被吊销）⇒ **reject** ⇒ 错误原样上抛
    //     ⇒ 闸门（core/authGuard.ts）据此分出「等我们恢复」与「现在联系不上」。
    //
    // ⚠️ RTK 的 `unwrap()` reject 出来的是**序列化后**的错误
    // （miniSerializeError 只保留 name/message/stack/code）—— 我们的
    // `code: 'backend_unavailable'` **恰好在 commonProperties 里**（code），
    // 所以机器标记能活下来；但 `httpStatus` 会丢。判据因此必须认 `code`。
    const user = await store.dispatch(getCurrentUser()).unwrap();
    if (!user) return false;
    store.dispatch(
      setFromCache({ user, isAuthenticated: true, statusKind: 'authenticated' })
    );
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
