import { store } from '@/store';
import { getCurrentUser, setFromCache } from '@/store/slices/authSlice';
import { loadSettings } from '@/store/slices/settingsSlice';
import { syncEngine } from '@/services/syncEngine';
import { enqueue, hasQueuedOrRunningJob } from './mutationQueue';
import { logError, logInfo, logWarn } from '../utils/log';
import {
  NORMAL_INTERVAL_MINUTES,
  backoffMinutesFor,
  isBackoffExhausted,
  readBackoffState,
  recordSyncFailure,
  recordSyncSuccess,
  shouldSkipDueToBackoff,
  type BackoffKv,
  type BackoffState,
} from './syncBackoff';

/**
 * 后台定时同步（chrome.alarms 驱动，Service Worker 常驻时每 60s 触发）。
 *
 * 目的：B 设备扩展开着但未打开 popup 时，也能定期从云端拉取 A 设备的变更，
 * 写入本地 storage；用户随后打开 popup 时数据已是最新（popup 首屏 loadGroups
 * 直接读到后台下载好的结果），无需等待手动同步。
 *
 * 设计约束（MV3）：
 * - Service Worker 是事件驱动、可随时被系统杀掉；alarms 触发会重新唤醒 SW。
 * - SW 无 localStorage；supabase 客户端已改用 chrome.storage.local 持久化 session
 *   （见 src/utils/supabase.ts），因此这里能安全恢复登录态。
 * - 每次唤醒都是全新执行上下文，store 也是新实例——先 getCurrentUser 注入登录态，
 *   再走 SyncEngine 下载合并（快照→下载→合并→验证→写入，失败自动回滚）。
 *
 * ── 2026-10-10 F3：失败退避 ────────────────────────────────────────────────
 * 修复前这个 alarm 是固定 periodInMinutes:1，失败无退避、无 maxRetries：网络断着
 * 或云端 500 时，整条管线每 60s 无限重跑，持续消耗流量与电量，且这些重试在故障
 * 恢复前**永远不可能成功**。
 * 现在的节奏由退避状态机决定（见 ./syncBackoff，纯函数 + 注入式 KV/时钟）：
 *   失败 → consecutiveFailures+1 → 重排 alarm 为 delayInMinutes=1/2/5（封顶 5 分钟）；
 *   成功 → **复位**（连续次数清零、持久化键删除、回到 60s 正常节奏）；
 *   连续失败达 MAX_CONSECUTIVE_FAILURES(8) → 不再自动重排（不是永久停摆：
 *     用户手动同步、下一次浏览器启动 / SW onStartup 都会重新注册并复位）。
 * 【为什么状态必须落 chrome.storage.local 而不是模块变量】MV3 SW 随时被系统杀，
 * 模块变量在下一轮唤醒就是 0 ⇒ 退避等于没做。chrome.storage.local 与
 * chrome.alarms 都是持久的，SW 回收后照样读得到。这是整个修复的关键约束。
 */

const SYNC_ALARM = 'tapstack-background-sync';

/** chrome.storage.local 的最小适配：退避状态是本模块唯一的持久化需求。 */
const backoffKv: BackoffKv = {
  async get(key) {
    const out = await chrome.storage.local.get(key);
    return out?.[key];
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
  async remove(key) {
    await chrome.storage.local.remove(key);
  },
};

/**
 * 把 alarm 重排到指定间隔。
 *
 * `chrome.alarms.create` 同名会覆盖旧 alarm（MV3 文档明确），所以「重排」就是
 * 再 create 一次同一个名字。delayInMinutes < 1 会被 Chrome 抬到 1 分钟并告警，
 * 而我们的阶梯最小值正好是 1 分钟，不触发该限制。
 */
function rescheduleAlarm(minutes: number): void {
  // ⚠️ periodInMinutes 必须**恒等于** NORMAL_INTERVAL_MINUTES（固定 60s 轮询），
  // 而 delayInMinutes 才是退避那一拍到点的时刻。两者混用（我第一版的错）会让
  // 「退避中」直接变成「周期变成 5 分钟」——语义完全错了：
  //   · 退避只该推迟**下一次**尝试；故障恢复后必须立刻回到 60s 节奏，
  //     否则一次网络抖动就把用户永久留在慢速同步里（拍板要求「成功必须复位」
  //     在这里同样成立：退避是「什么时候再试一次」，不是「轮询变慢」）。
  //   · tests/newFeatures.test.ts 钉着 periodInMinutes === 1，那是原实现的
  //     公开契约（SW 每次 onInstalled/onStartup 都用它恢复正常节奏）。
  chrome.alarms.create(SYNC_ALARM, {
    delayInMinutes: minutes,
    periodInMinutes: NORMAL_INTERVAL_MINUTES,
  });
  logInfo(`[BackgroundSync] 下轮同步安排在 ${minutes} 分钟后（周期恒为 ${NORMAL_INTERVAL_MINUTES} 分钟）`);
}

/**
 * 注册后台同步 alarm。在 service-worker 启动时调用一次。
 *
 * 【为什么 alarm 必须**同步**创建，而退避校正异步做】
 * `chrome.alarms.create` 必须在本函数返回前发生（同步），否则 SW 刚起来的
 * 那一小段窗口里 alarm 还不存在 —— Chrome 只保证已存在的 alarm 会唤醒 SW。
 * 更实际的理由：这是三处（onInstalled / onStartup / 模块顶层）都会调的入口，
 * 同步创建让「注册成功」这件事本身没有时序依赖，调用方与测试都能确定地看到它。
 * 退避校正（读持久化状态 → 若在退避中则把 delayInMinutes 往后推）随后异步进行；
 * 它只是**推迟**下一次触发，不会让 alarm 消失。
 *
 * 【幂等】onInstalled / onStartup / 模块顶层三处都会调它，chrome.alarms.create
 * 同名覆盖，不会叠加出多个 alarm。已处于退避中时不能用固定 60s 覆盖退避节奏
 * （否则每次 SW 唤醒都把退避抹平），所以异步段里读持久化状态：退避未到点就按
 * 剩余时间排，否则保持 60s 并**复位**（跨过完整退避窗口且期间无失败 ⇒ 已恢复）。
 */
export function setupBackgroundSync(): void {
  // 1) 同步：先把 alarm 排上（正常节奏）。这一步不做任何 await。
  rescheduleAlarm(NORMAL_INTERVAL_MINUTES);
  // 2) 异步：按持久化退避状态校正首次 delay（退避中则往后推；否则复位）。
  void (async () => {
    let state: BackoffState;
    try {
      state = await readBackoffState(backoffKv);
    } catch (err) {
      // 读不到退避状态不该阻止同步（退避只是省流量）→ 保持已排好的正常节奏。
      logWarn('[BackgroundSync] 读不到退避状态，保持正常周期:', err);
      return;
    }
    if (state.consecutiveFailures === 0) {
      // 未处于退避：清掉可能残留的键（跨过完整退避窗口且期间无失败 ⇒ 已恢复）。
      await recordSyncSuccess(backoffKv, Date.now()).catch(() => undefined);
      logInfo(`[BackgroundSync] 已注册后台同步 alarm（每 ${NORMAL_INTERVAL_MINUTES} 分钟）`);
      return;
    }
    const waitMs = state.nextAllowedAt - Date.now();
    if (waitMs > 0) {
      const delayMinutes = Math.max(1, Math.ceil(waitMs / 60_000));
      rescheduleAlarm(delayMinutes);
      logInfo(
        `[BackgroundSync] 已注册后台同步 alarm（退避中：连续失败 ${state.consecutiveFailures} 次，` +
          `${delayMinutes} 分钟后重试）`
      );
    } else {
      // 退避窗口已过但计数还在（如 SW 曾被杀）→ 复位，让本轮正常跑并在成功后再清。
      await recordSyncSuccess(backoffKv, Date.now()).catch(() => undefined);
      logInfo(`[BackgroundSync] 退避窗口已过，退避复位（每 ${NORMAL_INTERVAL_MINUTES} 分钟）`);
    }
  })();
  chrome.alarms.onAlarm.addListener(handleAlarm);
}

/**
 * 供手动触发一次（测试/调试）。用户显式触发 = 绕过退避窗口（他刚点了菜单）。
 *
 * 【返回值维持历史 boolean 契约（不能改）】
 *   true  = 执行了同步，或「有同步在途所以让路」（两者都表示「这一轮已被处理」）
 *   false = 未登录，本轮什么也没做
 * tests/syncBusyGate.test.ts 正是靠这个三元语义区分「让路」与「未登录」：
 * 空存储下走未登录分支必须拿到 false，而队列被占时必须拿到 true。
 * 如果这里改成 return outcome.ok，未登录会变成 true（因为「未登录」不算故障），
 * 那条守卫就失去了区分能力 —— 于是退避需要的 ok/fail 语义另开一个出口给
 * handleAlarm 用，**不让一个返回值同时承担两套语义**。
 *
 * ⚠️ 这条路径**不记账退避**：用户显式点击不代表轮询健康，且它同时服务 popup 手动同步。
 */
export async function runBackgroundSyncOnce(): Promise<boolean> {
  const outcome = await performBackgroundSync();
  if (outcome.kind === 'not_logged_in') return false;
  return true;
}

/**
 * alarm 入口：退避门禁 → 跑管线 → 按成功/失败重排 alarm。
 *
 * 【退避门禁放在这里而不是 performBackgroundSync 里】前者是「这一轮根本不该跑」
 * （省掉整条管线的构造与入队），后者是「跑了但没做完」。两者对退避的含义不同：
 * 被门禁拦下的轮次**不算失败**（不推进 consecutiveFailures），否则一次长时间
 * 不登录/长退避会把失败次数推到上限，白白停掉自动同步。
 */
async function handleAlarm(alarm: chrome.alarms.Alarm): Promise<void> {
  if (alarm.name !== SYNC_ALARM) return;
  try {
    const state = await readBackoffState(backoffKv);
    if (shouldSkipDueToBackoff(state, Date.now())) {
      const waitMs = state.nextAllowedAt - Date.now();
      logInfo(
        `[BackgroundSync] 退避窗口内（连续失败 ${state.consecutiveFailures} 次），` +
          `本轮跳过，约 ${Math.ceil(waitMs / 1000)}s 后重试`
      );
      rescheduleAlarm(Math.max(1, Math.ceil(waitMs / 60_000)));
      return;
    }
    const outcome = await performBackgroundSync();
    if (outcome.ok) {
      const before = state.consecutiveFailures;
      await recordSyncSuccess(backoffKv, Date.now());
      if (before > 0) {
        logInfo(`[BackgroundSync] 同步成功，退避复位（此前连续失败 ${before} 次）→ 回到 ${NORMAL_INTERVAL_MINUTES} 分钟节奏`);
        rescheduleAlarm(NORMAL_INTERVAL_MINUTES);
      } else {
        logInfo(`[BackgroundSync] 同步成功（${outcome.detail}）`);
      }
    } else {
      const next = await recordSyncFailure(backoffKv, Date.now(), outcome.detail);
      const minutes = backoffMinutesFor(next.consecutiveFailures);
      if (isBackoffExhausted(next.consecutiveFailures)) {
        logWarn(
          `[BackgroundSync] 同步连续失败 ${next.consecutiveFailures} 次（${outcome.detail}），` +
            `已停止自动重排 alarm。用户手动同步或下次浏览器启动会重试并复位。`
        );
        await chrome.alarms.clear(SYNC_ALARM).catch(() => undefined);
      } else {
        logWarn(
          `[BackgroundSync] 同步失败（${outcome.detail}），第 ${next.consecutiveFailures} 次：` +
            `下次重试间隔 ${minutes} 分钟`
        );
        rescheduleAlarm(minutes);
      }
    }
  } catch (err) {
    logError('[BackgroundSync] 后台同步异常:', err);
    // 异常路径同样计入退避：未捕获异常也是失败，不处理等于无限 60s 重试。
    try {
      const next = await recordSyncFailure(backoffKv, Date.now(), `unexpected: ${String(err)}`);
      if (!isBackoffExhausted(next.consecutiveFailures)) {
        rescheduleAlarm(backoffMinutesFor(next.consecutiveFailures));
      }
    } catch {
      /* 退避记账本身失败：下一轮照常按持久化状态判定，不阻塞 */
    }
  }
}

/**
 * 执行一次后台同步：恢复登录态 → 先推送本地未上传变更 → 再下载合并。
 *
 * ponytail: 原实现只下载不上传，是“复活”问题的核心后台表现——MV3 popup
 * 失焦销毁后任何本地变更都不可能再上云，但后台轮询仍然在拉云端，会把
 * 云端旧版本合并回本地。先检查持久化 pending_upload，若有未上传变更
 * 先 upload()（即使 SW 刚起来也是冷启动无 timer，安全可调），再
 * downloadAndMerge。这保证“下载”不会反着覆盖“刚改但还没上传完”的本地状态。
 *
 * ── 2026-10-10 F3：返回值改为结构化 outcome，让退避能区分「成功 / 失败 / 让路」──
 * 修复前只有一个 boolean，无法判断「失败」与「让路」（有同步在途、未登录），
 * 于是退避无处可挂：要么把让路也算成失败（失败次数被推爆、误停自动同步），
 * 要么把失败也算成让路（退避永不生效，F3 等于没修）。
 *
 * 三类的语义与对退避的影响：
 *   · ok    —— 本轮真的跑完了同步（或者让路成功 / 未登录 / 手动强制）。
 *              让路与未登录**不算失败**：前者下轮正常 60s 就跑，后者用户没登录
 *              时网络多半也没开，算失败会白推退避次数。
 *   · fail  —— 本轮因为真实故障中止（设置读失败、上传失败、下载失败）。
 *              这些正是修复前「每 60s 无限重试」的场景，现在逐级退避。
 *   · 失败原因随 outcome.detail 落进持久化状态，日志/诊断可追。
 */
export type BackgroundSyncOutcomeKind = 'done' | 'yielded' | 'not_logged_in' | 'failed';

export interface BackgroundSyncOutcome {
  /**
   * 本轮是否成功完成同步（含让路 / 未登录这类非故障跳过）。
   * handleAlarm 用它决定「复位」还是「推进阶梯」。
   */
  ok: boolean;
  /**
   * 更细的分类。存在的理由：runBackgroundSyncOnce 的历史 boolean 契约必须能区分
   * 「让路」(true) 与「未登录」(false)，而 handleAlarm 只关心 ok —— 两套语义不能
   * 挤在一个字段里，否则不是把守卫改坏就是把退避改坏。
   */
  kind: BackgroundSyncOutcomeKind;
  /** 一句话原因，落日志与退避状态；成功时是进度摘要。 */
  detail: string;
}

async function performBackgroundSync(): Promise<BackgroundSyncOutcome> {
  // 0. 同步任务去重闸门（1.22.12）：队列里已有 sync 任务在跑或在排（popup 的
  // AutoSync 下载、上一轮 alarm 还没收尾、延迟上传……）时，本轮直接让路。
  // 不让路的后果是同一条 FIFO 上叠两条整库管线：alarm 每 60s 一次，与每次开
  // popup 的 AutoSync 相互叠加 —— 线上日志里 normalizeTabsData 告警成对出现
  // （两轮全量下载）、用户点击的 removeTab 排在它们后面撞满 30s 协议超时。
  // 让路是安全的：pending_upload 由 mutation 路径的 scheduleUpload 自驱、
  // 下载路径末尾也有 stillPending 兜底重调度，本轮不传不丢任何上传意图；
  // 数据新鲜度最多少等一个 alarm 周期（60s），下轮照常执行。
  if (hasQueuedOrRunningJob('sync:')) {
    logInfo('[BackgroundSync] 已有同步任务在途，跳过本轮轮询（不叠第二条整库管线，下轮 alarm 重试）');
    // 让路不是故障：下轮 alarm 正常 60s 就到，不该推进退避阶梯。
    return { ok: true, kind: 'yielded', detail: '让路：已有同步任务在途' };
  }

  // 1. 恢复登录态（读取 chrome.storage.local 中的 session）
  const user = await store.dispatch(getCurrentUser()).unwrap().catch(() => null);
  if (!user) {
    logInfo('[BackgroundSync] 未登录，跳过后台同步');
    // 未登录不是同步故障（此时大概也没联网），不推进退避。
    return { ok: true, kind: 'not_logged_in', detail: '未登录，跳过' };
  }

  // 2. 登录态写入 store（SyncEngine 检查 store.auth.isAuthenticated 才放行）
  store.dispatch(
    setFromCache({ user, isAuthenticated: true })
  );

  // 2.5 载入用户设置（syncStrategy 决定合并策略；SW 的 store 是新实例，默认值会丢用户配置）
  //
  // ── 2026-10-05：读失败改为中止本轮，不再「用默认值继续」（P1）────────────
  // syncStrategy 决定上传时用哪种合并策略，而 cloudOverwrite 那个默认值
  // （conservative）恰好是**最危险**的一个：它假设「云端更新则丢弃本地」，
  // 于是「本地其实有未上传的新状态」这个前提一旦不成立，用户的本地数据
  // 就被云端旧数据覆盖。而设置读失败时，我们**恰恰不知道**这个前提成不成立
  // —— 默认值不是「安全的兜底」，它是「在不确定时选了破坏性更强的那个」。
  //
  // 原来这里是 `.catch(() => undefined)`，读失败与「设置本来就是默认值」不可区分，
  // 两者都会让流程继续 —— 这正是「静默用错策略」的来源。
  try {
    await store.dispatch(loadSettings()).unwrap();
  } catch (e) {
    logWarn(
      '[BackgroundSync] 读不到用户设置，中止本轮同步（syncStrategy 决定合并策略，' +
        '默认值 conservative 会在「本地领先云端」时覆盖本地数据 —— 与其赌一把，' +
        '不如什么都不做）。下轮 alarm 重试。',
      e
    );
    // 真实故障（fail-closed 中止）→ 计入退避。
    return { ok: false, kind: 'failed', detail: '读不到用户设置，已中止本轮' };
  }

  // 3. ponytail: 先上传本地未推送变更。持久化标志 storage.getPendingUpload()
  // 跨进程跨 SW 重启保留：popup 失焦销毁后本地有变更 = true，下一次后台
  // alarm 起来时会先上传。forcePending=true 跳过 isSyncing 短路。
  // 上传失败（网络断等）则中止本次下载：拉下来的只会是云端旧数据，
  // 会覆盖本地未推送的新状态（复活）。pending flag 已保留，下轮重试。
  try {
    const hasPending = await syncEngine.hasPendingUpload();
    if (hasPending) {
      logInfo('[BackgroundSync] 本地有未上传变更，先上传再下载');
      // 单写者队列（与 service-worker.ts 的 SYNC upload handler 同名 'sync:upload'），
      // 后台轮询上传与 popup SYNC 消息上传串行执行，避免并发 upload/download 撞车。
      const upResult = await enqueue('sync:upload', () => syncEngine.upload({ forcePending: true }));
      if (!upResult.success) {
        logWarn(`[BackgroundSync] 上传未成功，跳过本次下载: ${upResult.error}（下轮 alarm 重试）`);
        // 修复前这里 return true（当成功），于是「上传一直失败」会每 60s 无限重试。
        return { ok: false, kind: 'failed', detail: `上传未成功: ${upResult.error ?? 'unknown'}` };
      }
    }
  } catch (e) {
    // ── 2026-10-05：判据读不到时**中止本轮**，不再继续下载 ──────────────
    // 原来这里是 logWarn + 继续走第 4 步下载。那是危险的：读不到
    // pending_upload 意味着「本地有没有未推送的变更」这个问题没有答案，
    // 而下载会用云端数据覆盖本地。若本地其实有未推送的新状态（正是读失败
    // 最可能的原因之一），这一轮下载就会把它覆盖掉 —— 用户的修改静默丢失。
    //
    // 上传路径的注释（第 79-80 行）已经写明「上传失败则中止本次下载：
    // 拉下来的只会是云端旧数据，会覆盖本地未推送的新状态（复活）」。
    // 读不到判据与上传失败在后果上是同一类：不确定本地是否领先 ⇒ 不下载。
    logWarn(
      '[BackgroundSync] 读不到 pending_upload 判据，中止本轮同步（不下载：' +
        '本地是否领先云端未知，下载可能覆盖未推送的本地变更）。下轮 alarm 重试。',
      e
    );
    // 判据读不到 = 真不知道本地是否领先 → 故障，计入退避。
    return { ok: false, kind: 'failed', detail: '读不到 pending_upload 判据，已中止本轮' };
  }

  // 4. 下载并合并到本地 storage（同 'sync:download' 名，串行化）
  const result = await enqueue('sync:download', () => syncEngine.downloadAndMerge());
  if (!result.success) {
    const reason = result.reason ?? 'unknown';
    // already_syncing / recent_upload_guard / pending_upload_failed 属正常并发或保护性跳过，
    // **不算故障**（上轮刚上传过、下轮就正常跑），不进退避。
    // up_to_date 走的是 success 分支（见 syncEngine 的探活短路）。
    if (reason === 'already_syncing' || reason === 'recent_upload_guard' || reason === 'pending_upload_failed') {
      logInfo(`[BackgroundSync] 自动下载按保护性规则跳过: ${reason}（非故障，不进退避）`);
      return { ok: true, kind: 'yielded', detail: `下载按保护性规则跳过: ${reason}` };
    }
    logWarn(`[BackgroundSync] 自动下载未成功: ${reason}`);
    // 其余（网络错、validation_failed、precheck_unknown、snapshot_failed…）都是
    // 真实故障：修复前全部每 60s 无限重试，现在逐级退避到 5 分钟封顶。
    return { ok: false, kind: 'failed', detail: `自动下载未成功: ${reason}` };
  }

  // 5. 合并结果已由 SyncEngine 写入 storage
  const summary = result.stats
    ? `（本地 ${result.stats.localCount} → 云端 ${result.stats.cloudCount}，合并 ${result.stats.mergedCount}）`
    : '';
  logInfo(`[BackgroundSync] 后台同步完成: ${result.groups.length} 个组${summary}`);
  return { ok: true, kind: 'done', detail: `同步完成: ${result.groups.length} 个组${summary}` };
}