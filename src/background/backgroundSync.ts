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
// 档位校验单点在 storage 层（读路径兜底也在那里），这里只复用，不另写一份
// [5,10,30,60] 白名单 —— 两处各写一份，半年后就是一次口径漂移。
import { DEFAULT_SETTINGS, validateSyncIntervalMinutes } from '../utils/storage';
import { STORAGE_KEYS } from '../storage-kv/keys';
import { kvGet } from '../storage-kv/storageAdapter';
import type { UserSettings } from '../types/tab';

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
 * 自动同步的生效配置（总开关 + 档位）。setup 与 handleAlarm 共用、
 * service-worker 的自动下载门禁也复用它（单点判据，不各写一份）。
 *
 * 【读失败的方向】fail-open 回今天的行为（开/1分钟）+ 告警。
 * 注意与 performBackgroundSync §2.5 的区别：那里读失败必须中止整轮
 * （syncStrategy 选错会覆盖本地数据）；这里读失败只是「不知道用户想几分钟
 * 跑一次」—— 用旧行为继续是最不坏的选择，且瞬时错误下轮自动纠正。
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
      if (before > 0) {
        logInfo(`[BackgroundSync] 同步成功，退避复位（此前连续失败 ${before} 次）→ 回到 ${cfg.intervalMinutes} 分钟节奏`);
        rescheduleAlarm(cfg.intervalMinutes, cfg.intervalMinutes);
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
        rescheduleAlarm(minutes, cfg.intervalMinutes);
      }
    }
  } catch (err) {
    logError('[BackgroundSync] 后台同步异常:', err);
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
