import { store } from '@/store';
import { getCurrentUser, setFromCache } from '@/store/slices/authSlice';
import { loadSettings } from '@/store/slices/settingsSlice';
import { syncEngine } from '@/services/syncEngine';
import { readConfiguredBackendId } from '@/sync-backend';
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
// 档位校验单点在 storage 层（读路径兜底也在那里），这里只复用，不另写一份
// [5,10,30,60] 白名单 —— 两处各写一份，半年后就是一次口径漂移。
import { DEFAULT_SETTINGS, validateSyncIntervalMinutes } from '../utils/storage';
import { storage } from '../utils/storage';
import { STORAGE_KEYS } from '../storage-kv/keys';
import { kvGet } from '../storage-kv/storageAdapter';
import type { UserSettings } from '../types/tab';
import { primeSyncBackend } from '@/sync-backend';
import { isBackendUnavailableError } from '@/core/backendUnavailable';
import { backendUnavailableBackgroundNotice } from '@/components/sync/backendUnavailableCopy';

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
 *
 * ── 2026-10-11（1.23.0）：自动同步默认关闭 + 用户四档间隔 ────────────────
 * 自动同步每轮都是出站流量（Supabase egress 配额），60s 全量轮询是配额见底的主因。
 * 新语义（产品拍板）：
 *   · 默认关闭：后台 alarm 不注册、打开 popup 不再自动拉取，用户点「同步」手动获取；
 *   · 用户在菜单中开启后四选一：5 / 10 / 30 / 60 分钟（默认 10）；
 *   · 本地改动的上传保持事件驱动（只在真有改动时才传，F2 增量后极小），
 *     不受本开关影响 —— 关掉上传省不下什么，反而把编辑困在本机且无声。
 * 本文件的三处改动：
 *   1) setupBackgroundSync 读设置：关 → 清 alarm 直接返回（无 alarm = 零成本，
 *      顺带自愈关掉开关前残留的孤儿 alarm）；开 → 按用户档位注册；
 *   2) handleAlarm 每次触发重读设置：开关在 alarm 待发期间被关掉时，
 *      本轮自杀（清 alarm + 返回），不跑管线、不计退避；
 *   3) rescheduleAlarm 改取双参数（delay + period）：退避重排时 period
 *      必须沿用用户档位，不能写死 1 分钟，否则一次失败就把用户档位洗掉。
 */

/** 后台轮询 alarm 名。popup 不直接碰 alarms（SW 侧单点拥有），这里导出只供测试断言。 */
export const SYNC_ALARM = 'tapstack-background-sync';

/** 用户关掉自动同步后 popup 发来重建 alarm 的 SYNC 操作名（见 service-worker SYNC 分支）。 */
export const RESYNC_ALARM_OP = 'resyncAlarm';

/** popup 自动下载（打开触发）被总开关拦下时的原因码（AuthProvider 对它静默，见那里的白名单）。 */
export const AUTO_SYNC_DISABLED_REASON = 'auto_sync_disabled';

/**
 * 最近一次 readAutoSyncConfig 是否因**读失败**而返回 false（2026-10-12 P1）。
 *
 * 「自动同步没跑」有两种完全不同的成因，而它们需要的收尾动作正好相反：
 *   · 用户真的关了        → 清 alarm（终态，不需要下一轮）
 *   · 读配置失败（故障）  → **重排一个短延迟再试**（清 alarm 不是永久停摆：
 *                          每次 SW 唤醒都会经模块顶层重进 setupBackgroundSync，
 *                          但唤醒时刻不可控 —— 重排把自愈收缩到 1 分钟内）
 * readAutoSyncConfig 的返回类型只有 `{enabled:false}`，无法表达这个区别，
 * 所以用模块级标记把「读失败」这一事实带到调用方。
 *
 * 放模块级而不是塞进返回值：返回形状被 service-worker 的门禁分支等调用方消费，
 * 改形状会波及它们；而这个标记只需要 handleAlarm 一处读。
 * 每次 readAutoSyncConfig 开头重置 —— 它是「最近一次读」的快照，不是历史累计。
 */
let autoSyncConfigReadFailed = false;

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
 * 「同步需要配置/解锁」的一次性可见提醒。
 *
 * ── 为什么必须可见 ────────────────────────────────────────────────────
 * 修复前锁定后端只打一行 logWarn，用户侧零感知：设置页宣称「每 N 分钟后台
 * 同步一次」，实际连续 8 次后 alarm 被清掉、自动同步静默停摆。
 * 通知是这条链路上唯一能主动触达用户的通道。
 *
 * 【一次性】发送成功才置标志（backoffKv = chrome.storage.local，活过 SW
 * 回收）：同一锁定状态连续多轮只打扰一次；发送失败不置标志，下一轮重试。
 * 真正跑通一轮（done）后清掉标志 ——「解锁又锁上」这类新一季问题会重新
 * 提醒一次，而不是被第一次永久静默。
 *
 * 通知 API 不可用时（测试环境 / 未来移除 notifications 权限）静默返回：
 * 提醒是附加的，绝不能因为它反把同步让路这条路弄失败。
 */
const LOCKED_BACKEND_NOTICE_KEY = 'background_sync_locked_notice_shown';

/**
 * 「云端项目被限制」时后台轮询的下次重试间隔（分钟）。
 *
 * ── 为什么是 60 分钟（而不是退避阶梯的 1/2/5）───────────────────────────
 * 这一类失败**重试无用**（项目被封禁时重试一万次结果一样），而且每次重试
 * 都在消耗 **egress 配额** —— 配额超限正是被封禁的原因。所以间隔必须
 * 显著长于普通故障的退避档。
 *
 * 但**不能拉到无穷大**（也不能清 alarm）：那会让「恢复后自动继续」变成
 * 谎话 —— 用户得手动同步或重启浏览器才知道恢复了。60 分钟是一个折中：
 * 配额喘得起气，且恢复后最多一小时自愈。
 *
 * 为什么不是「用户档位」（默认 10 分钟）：10 分钟一轮全量轮询仍在持续
 * 烧配额，而封禁状态往往持续更久（要等人去解封）。
 */
export const BACKEND_UNAVAILABLE_RETRY_MINUTES = 60;

/** 「云端项目被限制」的一次性提醒标志（与 LOCKED_BACKEND_NOTICE_KEY 分开）。 */
const BACKEND_UNAVAILABLE_NOTICE_KEY = 'background_sync_backend_unavailable_notice_shown';

/**
 * 「云端项目被限制」的一次性可见提醒（2026-10-22）。
 *
 * ── 为什么必须可见 ──────────────────────────────────────────────────────
 * 后台同步失败时**用户什么都没点** ⇒ 界面上零动静。唯一能主动触达用户的
 * 通道就是这条通知。而这一次尤其需要：用户会以为「自动同步坏了」或
 * 「我被限流了」—— 通知必须说清「**你的本地数据没事、不是你的错、等我们恢复**」。
 *
 * 【一次性】同一段封禁期只打扰一次（标志在 backoffKv = chrome.storage.local，
 * 活过 SW 回收）。真正跑通一轮（done）后清掉 ⇒ 「封禁 → 恢复 → 再封禁」
 * 会重新提醒一次。
 */
async function notifyBackendUnavailableOnce(): Promise<void> {
  const api = (globalThis as { chrome?: typeof chrome }).chrome;
  // API 不可用（测试环境 / 权限被移除）时**不置标志**直接返回：
  // 「发不出去」不等于「已提醒过」。
  if (!api?.notifications?.create) return;
  try {
    const already = await backoffKv.get(BACKEND_UNAVAILABLE_NOTICE_KEY);
    if (already) return;

    // 通知权限由设置里的「显示通知提醒」控制（与 locked 那条同口径）。
    // 读不到设置时按**开启**处理（漏报一次的代价 < 用户以为已提醒过）。
    try {
      const settings = await storage.getSettings();
      if (settings.showNotifications !== true) return;
    } catch (err) {
      logWarn('[BackgroundSync] 读取通知设置失败，按开启处理:', err);
    }

    await api.notifications.create({
      type: 'basic',
      iconUrl: api.runtime?.getURL?.('icons/icon128.png'),
      title: 'TapStack 云端暂时不可用',
      message: backendUnavailableBackgroundNotice(),
    });
    await backoffKv.set(BACKEND_UNAVAILABLE_NOTICE_KEY, true);
  } catch {
    // 发不出去就下轮再试，不置标志，不抛错。
  }
}

async function notifyLockedBackendOnce(): Promise<void> {
  const api = (globalThis as { chrome?: typeof chrome }).chrome;
  // API 不可用（测试环境 / 权限被移除）时**不置标志**直接返回：
  // 「发不出去」不等于「已提醒过」。修复前这里先置位再发现没有 API，
  // 标志就此留下，同一锁定季后续轮次连尝试都不再做。
  if (!api?.notifications?.create) return;
  try {
    const already = await backoffKv.get(LOCKED_BACKEND_NOTICE_KEY);
    if (already) return;

    // ── 2026-10-18 P2-5：受「显示通知提醒」开关约束 ────────────────────────
    // 这条通知是 info 性质（「去配置/解锁」的建议），按 2026-10-17 定的
    // 分流策略（success/info 受控、error 必发）应当受开关控制。
    //
    // 为什么必须一致：全仓唯一尊重该开关的地方是 TabManager.showNotification，
    // 这里直接 chrome.notifications.create 意味着用户在设置里关掉通知后，
    // 每隔 10 分钟仍会收到这一条 —— 用户唯一能做的反应是关掉整个扩展的
    // 通知权限，连带把真正的失败提醒也一起关掉。
    //
    // 读不到设置时按**开启**处理，与 TabManager 同口径：漏报一条建议的代价
    // 小于「让用户以为已经提醒过了」。
    try {
      const settings = await storage.getSettings();
      if (settings.showNotifications !== true) return;
    } catch (err) {
      logWarn('[BackgroundSync] 读取通知设置失败，按开启处理:', err);
    }

    await api.notifications.create({
      type: 'basic',
      iconUrl: api.runtime?.getURL?.('icons/icon128.png'),
      title: 'TapStack 同步需要配置或解锁',
      message:
        '后台自动同步已停在「让路」状态：云盘尚未配置，或本次会话尚未解锁。' +
        '配置好并解锁后会自动继续，不用做什么。',
    });
    await backoffKv.set(LOCKED_BACKEND_NOTICE_KEY, true);
  } catch {
    // 发不出去就下轮再试，不置标志，不抛错。
  }
}

/**
 * 自动同步的生效配置（总开关 + 档位）。setup 与 handleAlarm 共用、
 * service-worker 的自动下载门禁也复用它（单点判据，不各写一份）。
 *
 * 【读失败的方向】fail-open 回今天的行为（开/1分钟）+ 告警。
 * 注意与 performBackgroundSync §2.5 的区别：那里读失败必须中止整轮
 * （那一步要拿设置去决定「这轮该不该跑、该怎么跑」，读不到就等于替用户猜）；
 * 这里读失败只是「不知道用户想几分钟跑一次」—— 用旧行为继续是最不坏的选择，
 * 且瞬时错误下轮自动纠正。
 * 两个地方方向相反，各自的理由写在各自的注释里，不要统一。
 */
export interface AutoSyncConfig {
  enabled: boolean;
  intervalMinutes: number;
}

/**
 * 读自动同步配置。
 *
 * ── 2026-10-11（1.23.0 审查修复 P1）：必须绕过 settings 的进程内缓存 ──
 * 修复前这里走 `store.dispatch(loadSettings())`，而 getSettings 走
 * `cachedAsyncFn('storage','settings')` —— **60 秒进程内缓存**。popup 与 SW 是
 * 两个执行上下文、各有独立的 cacheManager，所以：
 *
 *   用户点「关闭自动同步」→ popup 落盘（自己进程内缓存已更新）
 *                        → 发 resyncAlarm 叫 SW 重建 alarm
 *                        → SW 的 readAutoSyncConfig 读到**自己那份 60s 旧缓存**
 *                        → 判定「还开着」→ 按旧档位把 alarm 重建出来
 *
 * 后果分两层，第二层才致命：
 *   1) 关态下 popup 的自动下载门禁也读同一缓存 → 关了仍自动拉一次（浪费流量）；
 *   2) 真正的问题是**关不掉**：handleAlarm 的「关则自杀」每轮都读到旧值 true，
 *      于是「关」这个用户显式意图在最长 60 秒内**完全无效**，后台继续按用户
 *      已拒绝的节奏出站流量。
 *
 * 已用探针实证（tests/autoSyncDefaultOff.test.ts「缓存旁路」那条用例钉住）：
 * popup 改盘后立刻再读，拿到的仍是 enabled:true。
 *
 * 【修法与为什么不直接清缓存】清 SW 进程的 cacheManager 也可以，但那是
 * 「从外面捅穿别人的缓存」—— cacheManager 是 storage 模块的私有实现，
 * backgroundSync 去 clear 它等于建立一条新的跨模块耦合，且下一个有缓存的
 * 设置字段会再犯一次。直接读盘（绕过 cachedAsyncFn）语义更准：
 * 「这次问的是**当前真实配置**」而不是「本进程 60 秒前见过什么」。
 * 一轮同步多一次 KV 读（几 KB 的 settings 键），相对它后面要跑的整库管线
 * 可以忽略；而在手动同步按钮那条路上它同样是「读一次真值」，并不更贵。
 *
 * 【为什么不用 storage.getSettings 再比对】那正是有缓存的那个入口，
 * 绕一圈等于没修。
 */
export async function readAutoSyncConfig(): Promise<AutoSyncConfig> {
  autoSyncConfigReadFailed = false;
  try {
    // 直接读盘：见上方「必须绕过进程内缓存」的完整论证。
    // 读失败与之前一致（fail-open 回旧行为 + 告警），缓存不是失败原因，
    // 但真读失败时不能把用户「关掉了自动同步」当成「开着」——那正是本缺陷的形态。
    // 方向选择：读失败 → 保守按「关」处理（不出流量），并在日志出声。
    // 与 loadSettings 那条路的 fail-open（旧行为=开）相反，理由是：
    // 用户显式关掉自动同步的意图**不该被一次瞬时读错误撤销**（撤销用户意图
    // 比多跑一轮更糟）；而「开」是默认值，不需要保护。
    // 代价：读失败时自动同步会停到下一轮（瞬时错误下轮自愈），可接受。
    const raw = await kvGet<unknown>(STORAGE_KEYS.SETTINGS);
    const stored = raw && typeof raw === 'object' ? (raw as Partial<UserSettings>) : {};
    const settings = { ...DEFAULT_SETTINGS, ...stored };
    if (settings.syncEnabled === true) {
      return {
        enabled: true,
        intervalMinutes: validateSyncIntervalMinutes(settings.syncIntervalMinutes),
      };
    }
    return { enabled: false, intervalMinutes: validateSyncIntervalMinutes(settings.syncIntervalMinutes) };
  } catch (err) {
    // fail-closed（按「关」）：见上方注释——撤销用户显式关掉的意图比多跑一轮更糟。
    // 读失败一律出声（logError 而非 warn）：它会让自动同步静默停摆，
    // 用户看到的现象是「我开了自动同步但它不动了」，没有提示就无从排查。
    //
    // ── 2026-10-12 P1：把「读失败」标记出来，别让它冒充「用户关闭」 ──────
    // 修复前本函数只返回 `{enabled:false}`，而 false 有两种含义：
    //   (a) 设置里明确写着 syncEnabled !== true  → 用户真的关了 → **该清 alarm**
    //   (b) kvGet 抛错（死句柄看门狗 / 事务 abort）→ 故障       → **不该清 alarm**
    // 调用方（handleAlarm）无法区分，于是走 (b) 这条路时也会
    // `alarms.clear(SYNC_ALARM)` —— 「本轮不再排下一轮」：同步停摆到下一次
    // SW 被唤醒（service-worker 模块顶层会重进 setupBackgroundSync 重建 alarm，
    // 但无事件就无唤醒，停摆时长不可控），且无任何 UI 提示。
    // （日志承诺的「下轮重试」并不可靠：清掉 alarm 就没有确定性的下一轮。）
    //
    // 修法：读失败时 configReadFailed=true。**方向仍是不出流量**（这一点不变，
    // 且是对的），但「本轮不跑管线」与「把 alarm 清掉」必须分开：
    // 前者是本轮的取舍，后者是终态，只有真读到用户关闭才做。
    autoSyncConfigReadFailed = true;
    logError('[BackgroundSync] 读不到自动同步配置，按「关闭」处理（保守不出流量），下轮重试:', err);
    return { enabled: false, intervalMinutes: NORMAL_INTERVAL_MINUTES };
  }
}

/**
 * 把 alarm 重排到指定间隔。
 *
 * `chrome.alarms.create` 同名会覆盖旧 alarm（MV3 文档明确），所以「重排」就是
 * 再 create 一次同一个名字。delayInMinutes < 1 会被 Chrome 抬到 1 分钟并告警，
 * 而我们的阶梯最小值正好是 1 分钟，不触发该限制。
 *
 * @param delayMinutes 下一次触发在几分钟后（退避用它推迟，非退避传 period 即可）
 * @param periodMinutes 周期。必须传用户档位 —— 写死常量等于一次失败就把
 * 用户选的 30/60 分钟洗成 1 分钟（1.23.0 前就是这么写的，那时只有一档）。
 */
function rescheduleAlarm(delayMinutes: number, periodMinutes: number): void {
  // ⚠️ delay 与 period 是两个正交语义，不可混用（第一版把退避 delay 当成
  // period 传，等于「退避中直接把周期改成 5 分钟」的 bug）：
  //   · delayInMinutes 只推迟**下一次**尝试；故障恢复后必须立刻回到用户档位，
  //     否则一次网络抖动就把用户永久留在慢速同步里（拍板要求「成功必须复位」
  //     在这里同样成立：退避是「什么时候再试一次」，不是「轮询变慢」）。
  //   · periodInMinutes 恒等于用户档位（1.23.0 前是写死的 1 分钟常量，那时只有一档；
  //     tests/autoSyncDefaultOff.test.ts 按新契约钉住「周期 = 用户档位」，
  //     读不到配置才回落 NORMAL_INTERVAL_MINUTES）。
  chrome.alarms.create(SYNC_ALARM, {
    delayInMinutes: delayMinutes,
    periodInMinutes: periodMinutes,
  });
  logInfo(`[BackgroundSync] 下轮同步安排在 ${delayMinutes} 分钟后（周期 ${periodMinutes} 分钟）`);
}

/**
 * 注册后台同步 alarm。在 service-worker 启动时调用一次。
 *
 * ── 2026-10-11（1.23.0）：先读配置再决定建不建 alarm ───────────────────
 * 旧实现「同步创建 alarm、异步校正退避」，理由是 SW 刚起来时 alarm 必须已存在。
 * 新语义下「无 alarm」是合法稳态（用户关了自动同步），所以顺序反过来：
 * 先异步读配置，关 → 清 alarm 返回（顺带清掉关开关前残留的孤儿 alarm），
 * 开 → 按档位注册 + 原有的退避校正。
 * 代价是 SW 启动到读完配置之间有几毫秒没有 alarm：若 SW 恰好在这几毫秒内被杀，
 * alarm 要等下次启动才注册 —— SW 刚启动的最小存活远超一次 storage 读，
 * 这个窗口在实践中不存在，为它加复杂度不值得。
 *
 * 【幂等】onInstalled / onStartup / 模块顶层三处都会调它，chrome.alarms.create
 * 同名覆盖，不会叠加出多个 alarm。已处于退避中时不能用固定 60s 覆盖退避节奏
 * （否则每次 SW 唤醒都把退避抹平），所以异步段里读持久化状态：退避未到点就按
 * 剩余时间排，否则保持 60s 并**复位**（跨过完整退避窗口且期间无失败 ⇒ 已恢复）。
 * （1.23.0 起「保持 60s」改为「保持用户档位」，退避 delay 仍走 1/2/5 阶梯。）
 */
export function setupBackgroundSync(): void {
  // listener 注册保持无条件：同一函数引用重复 addListener 无害（Chrome 去重），
  // 而关状态下跳过注册会导致「用户从菜单开启后」收不到 alarm —— 开启路径
  // 经 resyncAlarm 消息重进本函数，届时 listener 必须已在位。
  chrome.alarms.onAlarm.addListener(handleAlarm);
  // 2) 异步：按持久化退避状态校正首次 delay（退避中则往后推；否则复位）。
  void (async () => {
    // 1.23.0：先问总开关。关 → 清 alarm 返回（零成本 + 自愈孤儿 alarm）。
    const cfg = await readAutoSyncConfig();
    if (!cfg.enabled) {
      // ── 2026-10-12 P1：读失败 ≠ 用户关闭（同 handleAlarm 的修法）──────
      // SYNC_ALARM 的创建点全在本模块（rescheduleAlarm）；本函数每次 SW 唤醒
      // 都会经 service-worker 模块顶层重进 —— 所以这里清 alarm 不是
      // 「一次性永久」，但重建依赖 SW 再次被唤醒：无事件就无唤醒，停摆时长
      // 不可控，且期间无任何 UI 提示。读失败时改为排一个 1 分钟后的 alarm：
      // 仍然不跑管线（不出流量），但自愈不再依赖用户下次交互。
      if (autoSyncConfigReadFailed) {
        logWarn(
          '[BackgroundSync] 启动时读不到自动同步配置（故障，非用户关闭）：' +
            '暂不注册常驻 alarm，1 分钟后再试一次。自动同步未被关闭。'
        );
        rescheduleAlarm(1, NORMAL_INTERVAL_MINUTES);
        return;
      }
      await chrome.alarms.clear(SYNC_ALARM).catch(() => undefined);
      logInfo('[BackgroundSync] 自动同步已关闭，不注册后台 alarm（打开 popup 不会自动拉取，点「同步」手动获取）');
      return;
    }
    let state: BackoffState;
    try {
      state = await readBackoffState(backoffKv);
    } catch (err) {
      // 读不到退避状态不该阻止同步（退避只是省流量）→ 保持已排好的正常节奏。
      logWarn('[BackgroundSync] 读不到退避状态，保持正常周期:', err);
      rescheduleAlarm(cfg.intervalMinutes, cfg.intervalMinutes);
      return;
    }
    if (state.consecutiveFailures === 0) {
      // 未处于退避：清掉可能残留的键（跨过完整退避窗口且期间无失败 ⇒ 已恢复）。
      await recordSyncSuccess(backoffKv, Date.now()).catch(() => undefined);
      rescheduleAlarm(cfg.intervalMinutes, cfg.intervalMinutes);
      logInfo(`[BackgroundSync] 已注册后台同步 alarm（每 ${cfg.intervalMinutes} 分钟）`);
      return;
    }
    const waitMs = state.nextAllowedAt - Date.now();
    if (waitMs > 0) {
      const delayMinutes = Math.max(1, Math.ceil(waitMs / 60_000));
      rescheduleAlarm(delayMinutes, cfg.intervalMinutes);
      logInfo(
        `[BackgroundSync] 已注册后台同步 alarm（退避中：连续失败 ${state.consecutiveFailures} 次，` +
          `${delayMinutes} 分钟后重试）`
      );
    } else {
      // 退避窗口已过但计数还在（如 SW 曾被杀）→ 复位，让本轮正常跑并在成功后再清。
      await recordSyncSuccess(backoffKv, Date.now()).catch(() => undefined);
      rescheduleAlarm(cfg.intervalMinutes, cfg.intervalMinutes);
      logInfo(`[BackgroundSync] 退避窗口已过，退避复位（每 ${cfg.intervalMinutes} 分钟）`);
    }
  })();
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
 *
 * ── 2026-10-11（1.23.0）：总开关是第一道门禁 ────────────────────────────
 * 开关在 alarm 待发期间被关掉时，本轮自杀（清 alarm + 返回）：不跑管线、
 * 不计退避、不报错 —— 关是稳态，不是故障。清 alarm 是自愈：关开关前已排好的
 * 那一次 pending alarm 靠这一轮把它清掉，之后再无唤醒（零成本）。
 */
async function handleAlarm(alarm: chrome.alarms.Alarm): Promise<void> {
  if (alarm.name !== SYNC_ALARM) return;
  // ── 2026-10-13（WebDAV 阶段 2）：每轮重读后端配置 ────────────────────
  // 为什么必须在 alarm 里重读而不是只在 SW 启动时读一次：
  // 用户改「同步方式 / 云服务配置 / 解锁状态」时 SW **不一定**被重启
  // （最常见的路径是 popup 直接改盘），于是缓存的后端实例会停留在旧配置上。
  // 表现是「我明明切换了设置却没生效」—— 极难自查。
  // 代价只有一次 settings 读（几 KB）+ 一次配置读，相对后面整库管线可忽略。
  await primeSyncBackend();
  // 提到 try 外：catch 分支也要用它拿用户档位（见该分支内注释）。
  // cfg 在绝大多数轮次都能读到；只有 readAutoSyncConfig 自己抛错才是 null，
  // 那时下面 catch 里的兜底常量才生效。
  let cfg: AutoSyncConfig | null = null;
  try {
    // 1.23.0：先问总开关（每轮重读：开关可能在两次触发之间被改掉）。
    cfg = await readAutoSyncConfig();
    if (!cfg.enabled) {
      // ── 2026-10-12 P1：读失败 ≠ 用户关闭，两者收尾动作相反 ────────────
      // 修复前这里对两种「enabled=false」一律清 alarm。读失败时清 alarm =
      // 「不再排下一轮」：同步停摆到下一次 SW 唤醒（无事件就无唤醒，时长
      // 不可控），且用户界面毫无提示（现象是「我开着自动同步但它不动了」）。
      // 修复后：读失败仍然**不出流量**（本轮不跑管线，方向不变且正确），
      // 但改成重排一个 1 分钟后的 alarm —— 瞬时错误下轮自愈。
      if (autoSyncConfigReadFailed) {
        logWarn(
          '[BackgroundSync] 读不到自动同步配置（故障，非用户关闭）：本轮不跑管线，' +
            '1 分钟后重试。自动同步未被关闭。'
        );
        rescheduleAlarm(1, NORMAL_INTERVAL_MINUTES);
        return;
      }
      await chrome.alarms.clear(SYNC_ALARM).catch(() => undefined);
      logInfo('[BackgroundSync] 自动同步已关闭，本轮跳过并清除 alarm');
      return;
    }
    const state = await readBackoffState(backoffKv);
    if (shouldSkipDueToBackoff(state, Date.now())) {
      const waitMs = state.nextAllowedAt - Date.now();
      logInfo(
        `[BackgroundSync] 退避窗口内（连续失败 ${state.consecutiveFailures} 次），` +
          `本轮跳过，约 ${Math.ceil(waitMs / 1000)}s 后重试`
      );
      rescheduleAlarm(Math.max(1, Math.ceil(waitMs / 60_000)), cfg.intervalMinutes);
      return;
    }
    const outcome = await performBackgroundSync();
    if (outcome.ok) {
      const before = state.consecutiveFailures;
      await recordSyncSuccess(backoffKv, Date.now());
      if (outcome.locked) {
        // ── 2026-10-17 B1：未配置/未解锁 = 正常用户状态，按「让路」收尾 ──
        // recordSyncSuccess 的复位已在上方执行（与所有 ok 分支同形）：本轮
        // 根本没碰网络，留着旧失败计数只会在用户解锁后的下一次真实故障时
        // 提前撞上 8 次上限。
        //
        // 剩下的两条动作：
        //   1) 一次性可见提醒 —— 修复前这里只有 logWarn，用户零感知；
        //      而设置页仍宣称「每 N 分钟后台同步一次」，实际连续 8 次后
        //      alarm 被清掉、自动同步静默停摆。那正是这次修复的核心。
        //   2) **显式按用户档位重排 alarm** —— 不是 1 分钟的退避档，也不是
        //      「什么都不做」。为什么不是什么都不做：锁定时 alarm 必须保持
        //      活着，否则用户配置好后没有任何自动路径把它救回来；而 delay
        //      写退避档会把「让路」伪装成「失败」。
        //
        // 注意：这里不会走到下面的 recordSyncFailure，更不会走到
        // isBackoffExhausted 的清 alarm 分支。
        await notifyLockedBackendOnce();
        rescheduleAlarm(cfg.intervalMinutes, cfg.intervalMinutes);
        logInfo(
          `[BackgroundSync] 未配置/未解锁云盘，本轮让路（不进退避、不清 alarm，` +
            `保持 ${cfg.intervalMinutes} 分钟节奏）: ${outcome.detail}`
        );
      } else if (before > 0) {
        // 真正跑通一轮（done）才有资格清掉「未配置已提醒」标志：
        // 下一季锁定状态需要重新提醒，而不是被第一次永久静默。
        // ⚠️ 不能对保护性让路（kind='yielded'，如 already_syncing）也清：
        // 那会让「锁定 → 队列忙让路 → 再锁定」多发一次提醒（标志被误清）。
        if (outcome.kind === 'done') {
          await backoffKv.remove(LOCKED_BACKEND_NOTICE_KEY).catch(() => undefined);
          // ── 2026-10-22（402）：同样清掉「云端不可用已提醒」标志 ────────────
          // 「封禁 → 恢复 → 再封禁」要重新提醒一次，而不是被第一次永久静默。
          await backoffKv.remove(BACKEND_UNAVAILABLE_NOTICE_KEY).catch(() => undefined);
        }
        logInfo(`[BackgroundSync] 同步成功，退避复位（此前连续失败 ${before} 次）→ 回到 ${cfg.intervalMinutes} 分钟节奏`);
        rescheduleAlarm(cfg.intervalMinutes, cfg.intervalMinutes);
      } else {
        if (outcome.kind === 'done') {
          await backoffKv.remove(LOCKED_BACKEND_NOTICE_KEY).catch(() => undefined);
          await backoffKv.remove(BACKEND_UNAVAILABLE_NOTICE_KEY).catch(() => undefined);
        }
        logInfo(`[BackgroundSync] 同步成功（${outcome.detail}）`);
      }
    } else {
      // ── 2026-10-22（402）：「云端项目被限制」是**不可重试**的故障 ────────
      // 走下面的通用失败分支会有三个坏后果：
      //   ① 推进退避阶梯（1→2→5 分钟）⇒ 每 5 分钟重试一次，而项目被封禁时
      //      重试一万次结果一样 —— 而且**每次重试都在烧 egress 配额**，
      //      配额超限正是被封禁的原因（越重试越封得久）；
      //   ② 8 次后清 alarm ⇒ 「恢复后会自动继续」变成谎话（用户得手动同步
      //      或重启浏览器才知道恢复了）；
      //   ③ 不通知用户 ⇒ 用户只看到「自动同步不动了」，没有任何解释。
      //
      // 正确收尾：**不推进退避阶梯**（不是可重试的故障）、**间隔大幅拉长**
      // （让 egress 配额喘口气、也让它在恢复后能自愈）、**一次性通知用户**、
      // **alarm 保持存活**。
      if (outcome.backendUnavailable) {
        await notifyBackendUnavailableOnce();
        rescheduleAlarm(BACKEND_UNAVAILABLE_RETRY_MINUTES, cfg.intervalMinutes);
        logWarn(
          `[BackgroundSync] 云端项目不可用（${outcome.detail}）：本轮不计入退避阶梯，` +
            `下次重试间隔拉长到 ${BACKEND_UNAVAILABLE_RETRY_MINUTES} 分钟（重试无用，` +
            '且每次重试都会消耗配额）。恢复后会自动继续。'
        );
        return;
      }
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
        rescheduleAlarm(minutes, cfg.intervalMinutes);
      }
    }
  } catch (err) {
    logError('[BackgroundSync] 后台同步异常:', err);
    // ── 2026-10-22（402）：「云端项目被限制」从异常路径上浮到这里 ──────────
    // 账号校验那一支（performBackgroundSync 的第 1 步）会把「服务端不可用」
    // **原样抛出**（不吞成「未登录」），于是它落到本 catch。
    //
    // 必须单独处理：走下面的通用退避 = 每 1/2/5 分钟重试一次，而项目被封禁时
    // 重试无用**且烧配额**（配额超限正是封禁原因）。
    if (isBackendUnavailableError(err)) {
      await notifyBackendUnavailableOnce();
      rescheduleAlarm(
        BACKEND_UNAVAILABLE_RETRY_MINUTES,
        cfg?.intervalMinutes ?? NORMAL_INTERVAL_MINUTES
      );
      logWarn(
        '[BackgroundSync] 云端项目不可用（异常路径）：本轮不计入退避阶梯，' +
          `下次重试间隔拉长到 ${BACKEND_UNAVAILABLE_RETRY_MINUTES} 分钟。恢复后会自动继续。`
      );
      return;
    }
    // 异常路径同样计入退避：未捕获异常也是失败，不处理等于无限 60s 重试。
    try {
      const next = await recordSyncFailure(backoffKv, Date.now(), `unexpected: ${String(err)}`);
      if (!isBackoffExhausted(next.consecutiveFailures)) {
        // ── 2026-10-12 P1：别把用户档位洗回 60s ──────────────────────────
        // 修复前这里无条件写死 NORMAL_INTERVAL_MINUTES（=1，即 60s），旧注释
        // 的理由是「异常路径拿不到用户档位」—— 作用域层面没错：当时 cfg 在
        // try 内首行声明，catch 引用不到。但它不是硬约束：把声明提到 try 外
        // 即可让异常路径也用上真档位（readAutoSyncConfig 整段在 try/catch 里，
        // 几乎不会抛，cfg 几乎总是已读到；null 只是理论兜底）。
        //
        // 影响窗口（如实）：写死的 period 只持续到下一次重排 —— 下一轮 alarm
        // 触发（退避阶梯 ≤ 5 分钟）或下一次 SW 唤醒都会用 cfg 重排回用户档位。
        // 所以不是「永久退回每分钟」，但 1 小时档位的用户在那段窗口里确实
        // 退了每分钟节奏；修掉是为了维持不变量「period 恒 = 用户档位」。
        // delay 仍走退避阶梯（那是「隔多久再试」），period 才是「常态节奏」，
        // 两者语义不同，不该共用同一个常量。
        rescheduleAlarm(
          backoffMinutesFor(next.consecutiveFailures),
          cfg?.intervalMinutes ?? NORMAL_INTERVAL_MINUTES
        );
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
  /**
   * 本轮让路的根因是「自带存储未配置/未解锁」（锁定占位后端抛出）。
   *
   * 不塞进 kind 的理由：kind='yielded' 还有保护性跳过（already_syncing 等）
   * 这些**不该**发配置提醒的情形；而 locked=true 需要额外动作
   * （一次性通知 + 显式按用户档位重排 alarm）。两套语义不能挤在一个字段。
   */
  locked?: boolean;
  /**
   * 本轮失败的根因是「**云端项目被限制 / 服务端不可用**」（2026-10-22，402 收口）。
   *
   * ── 为什么单独一个字段（而不是复用 kind='failed'）──────────────────────
   * `kind='failed'` 的语义是「**可重试**的故障」⇒ 后台会推进退避阶梯
   * （1→2→5 分钟）并在 8 次后清 alarm。
   *
   * 而「云端项目被限制」是**不可重试**的：重试一万次结果一样，而且
   * **每次重试都在烧 egress 配额** —— 配额超限正是被封禁的原因。
   * 继续按 1/2/5 分钟重试 = 让封禁更久、让配额更负。
   *
   * ⇒ 正确的收尾是：**不推进退避阶梯**（不是失败）、**大幅拉长间隔**、
   * **一次性通知用户**、**alarm 保持存活**（否则「恢复后会自动继续」是谎话）。
   *
   * ⚠️ 为什么不用 kind='yielded'：那一档的语义是「正常用户状态，让路」，
   * 它的间隔是**用户档位**（默认 10 分钟）—— 那是「用户还没配云盘」的情形，
   * 而这里要的是「别再试了，等我们恢复」。
   */
  backendUnavailable?: boolean;
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
  //
  // ── 2026-10-17：门禁必须按后端分流，与 syncEngine 同口径 ────────────────
  // 修复前这里无条件问「有没有 Supabase session」。而自带存储（WebDAV）
  // **没有账号体系**，用户永远没有 session ⇒ getCurrentUser() 恒返回 null
  // ⇒ 每轮后台同步在第 1 步就返回 not_logged_in 自杀。
  //
  // 后果不是「少跑一轮」，而是**B1 的锁定让路整条链路不可达**：locked 分支、
  // 一次性通知、按档位重排全部走不到。表现即设置页宣称「每 N 分钟同步一次」、
  // B8 的门禁也显示「已配置并解锁」，而 WebDAV 用户的后台自动同步从不执行
  // —— 比 B1 要修的那个「连续 8 次后静默停摆」更彻底、更不可见。
  //
  // 这是**同一处漏改**的第二次出现：2026-10-14 真机 E2E 抓到「WebDAV 用户点
  // 同步一律得到『用户未登录』」，当时把门禁改成按 backendId 分流（见
  // core/authGuard.ts:34 `if (deps.backendId === 'webdav') return true;`），
  // 但只修了 syncEngine 那条链，**SW 专属的这个入口没跟着改**。
  // 判据必须与 authGuard 一致，否则两处口径漂移又是一次静默失效。
  //
  // WebDAV 分支不注入登录态：没有 user 可写，SyncEngine 侧也已由 authGuard
  // 对 webdav 直接放行，不依赖 store.auth.isAuthenticated。
  const backendId = await readConfiguredBackendId();
  // null = 读不到设置，本轮**无法回答**用户选了什么（2026-10-18 B 组）。
  // 不能让它落进下面的 `!== 'webdav'` 分支：那会去查 Supabase 账号，
  // 自带存储用户永远没有它 ⇒ 每轮都得到 not_logged_in（2026-10-17 B1 那条
  // 链路再次不可达）。而若反过来放行，就等于替用户猜一个后端开跑。
  if (backendId === null) {
    logError('[BackgroundSync] 读不到同步设置，本轮无法判断后端，已中止');
    // 真实故障（fail-closed 中止）→ 计入退避，下轮 alarm 重试。
    return { ok: false, kind: 'failed', detail: '读不到同步设置，已中止本轮' };
  }
  if (backendId !== 'webdav') {
    // ── 2026-10-22（402）：「云端整体不可用」**不许**被吞成「未登录」───────
    // 原先 `.catch(() => null)` 把**所有**失败都读成「没登录」⇒ 返回
    // `not_logged_in` ⇒ **后台每轮静默跳过**：不报错、不退避、不通知。
    // 用户看到的现象是「我开着自动同步，但它一动不动」，而设置页仍宣称
    // 「每 N 分钟后台同步一次」—— 这是本仓反复消灭的那类「静默停摆 + 界面说谎」。
    //
    // 生产实测（Supabase 项目被封禁）：账号校验请求本身返回 402 ⇒
    // thunk reject ⇒ 被这句 catch 吃掉 ⇒ 每轮都读成「未登录」。
    //
    // 所以这一类必须**原样上抛**，按「服务端不可用」处理（不推进退避阶梯、
    // 间隔大幅拉长、一次性通知用户）。
    const user = await store
      .dispatch(getCurrentUser())
      .unwrap()
      .catch(err => {
        if (isBackendUnavailableError(err)) throw err;
        return null;
      });
    if (!user) {
      logInfo('[BackgroundSync] 未登录，跳过后台同步');
      // 未登录不是同步故障（此时大概也没联网），不推进退避。
      return { ok: true, kind: 'not_logged_in', detail: '未登录，跳过' };
    }

    // 2. 登录态写入 store（SyncEngine 检查 store.auth.isAuthenticated 才放行）
    store.dispatch(
      setFromCache({ user, isAuthenticated: true })
    );
  }

  // 2.5 载入用户设置（SW 的 store 是新实例，不载入的话只剩代码默认值）
  //
  // ── 2026-10-05：读失败改为中止本轮，不再「用默认值继续」（P1）────────────
  // 原来这里是 `.catch(() => undefined)`，读失败与「设置本来就是默认值」不可区分，
  // 两者都会让流程继续 —— 而流程继续时，SW 拿到的就是**代码默认值**：
  // 用户开没开同步、用哪个后端、间隔几分钟，SW 一概不知道，却照样开跑。
  //
  // 「默认值不是安全的兜底」：默认值是一组**替用户做的决定**，
  // 而在读失败时我们**恰恰不知道**用户做过什么决定。
  // 与其赌一把，不如什么都不做（下轮 alarm 重试）。
  //
  // ── 2026-10-20 审计 A-9：原文案说「syncStrategy 决定合并策略」——
  // 那个设置已随其它死设置一起退役。合并**固定**走 mergeOpStamped
  // （组级 LWW），从不由任何设置决定；原文提到的 cloudOverwrite 默认值
  // 也早已不存在。留着这两句会让读代码的人以为「有个设置在决定合并方式」，
  // 而那个设置根本不存在 —— 那是注释在讲一个不存在的东西。
  try {
    await store.dispatch(loadSettings()).unwrap();
  } catch (e) {
    logWarn(
      '[BackgroundSync] 读不到用户设置，中止本轮同步（读失败时 SW 只能拿到代码默认值，' +
        '那等于替用户猜 —— 与其赌一把，不如什么都不做）。下轮 alarm 重试。',
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
      if (upResult.locked) {
        // ── 2026-10-17 B1：未配置/未解锁 = 正常用户状态，按「让路」收尾 ──
        // 关键判据来自 syncEngine 的 locked 标记（根因是 LockedBackendError），
        // 不用文案匹配。两条路都必须覆盖（上传口与下载口），否则「本地有未
        // 上传变更」的用户会从上传口子重新掉回退避阶梯。
        logInfo(
          `[BackgroundSync] 未配置/未解锁云盘，本地上传让路（不进退避）: ${upResult.error ?? 'unknown'}`
        );
        return {
          ok: true,
          kind: 'yielded',
          locked: true,
          detail: `未配置/未解锁云盘：${upResult.error ?? '请到设置里完成配置或解锁'}`,
        };
      }
      if (!upResult.success) {
        // ── 2026-10-22（402）：「云端项目被限制」要**单独归类** ─────────────
        // 不能落进普通的 'failed'：那会让后台按 1/2/5 分钟退避重试，
        // 而重试既无用（项目被封禁）**又烧配额**（配额超限正是封禁原因）。
        // 机器标记来自 syncEngine（见 UploadResult.backendUnavailable）。
        if (upResult.backendUnavailable) {
          logWarn(
            '[BackgroundSync] 云端项目不可用，上传失败（重试无用且会消耗配额）：' +
              `${upResult.error ?? 'unknown'}`
          );
          return {
            ok: false,
            kind: 'failed',
            backendUnavailable: true,
            detail: `云端项目不可用，上传未成功: ${upResult.error ?? 'unknown'}`,
          };
        }
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
    if (result.locked) {
      // ── 2026-10-17 B1：未配置/未解锁 ⇒ 让路，不是失败 ─────────────────
      // 关键判据来自 syncEngine 的 locked 标记（根因是 LockedBackendError），
      // 不用文案匹配：文案一改就静默失效。
      logInfo(`[BackgroundSync] 未配置/未解锁云盘，本轮让路（不进退避、不清 alarm）: ${reason}`);
      return {
        ok: true,
        kind: 'yielded',
        locked: true,
        detail: `未配置/未解锁云盘：${reason}`,
      };
    }
    // ── 2026-10-22（402）：「云端项目被限制」要**单独归类**，且**必须先判** ──
    // 同上传口：不能落进普通的 'failed'（那会按 1/2/5 分钟退避重试，
    // 而重试既无用**又烧配额**）。机器标记来自 syncEngine。
    //
    // ⚠️ 为什么这一段必须在下面的「保护性跳过」**之前**：
    // `pending_upload_failed` 原本属于「让路」（保护性跳过 ⇒ 不算故障）。
    // 而「上传被 402 挡住」时，downloadAndMerge 的 upload_first 分支
    // 会把 reason 换成「服务端不可用的人话」—— 但如果哪天它仍带着
    // `pending_upload_failed` 这个 reason（历史形状、老调用方），
    // 让路分支就会**先命中** ⇒ 后台静默什么都不做（不报故障、不退避、
    // 不通知）—— 而它恰恰是**真故障**且**不可重试**。
    //
    // ⇒ 判据必须是**机器标记优先**：只要标记在，一律按「云端不可用」收尾。
    if (result.backendUnavailable) {
      logWarn(`[BackgroundSync] 云端项目不可用，自动下载未成功: ${reason}`);
      return {
        ok: false,
        kind: 'failed',
        backendUnavailable: true,
        detail: `云端项目不可用，自动下载未成功: ${reason}`,
      };
    }
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
