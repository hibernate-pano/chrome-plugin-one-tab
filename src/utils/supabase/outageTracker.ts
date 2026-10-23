/**
 * 「云端刚刚明确不可用」的一次**观测**（IO 层的小状态，跨层只读结论）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * 2026-10-23（第 51 轮）：云端返回 402（项目被限制）时，
 * `@supabase/auth-js` 会在**刷新失败**后连打 8 次请求、退避 25.4 秒
 * （`_refreshAccessToken` 的 `retryable()`：200/400/800/…/12800ms，
 * 直到下一次退避会越过 30 秒的 tick 窗口为止）。
 *
 * ⇒ **一次云端故障 = 界面卡 25 秒**。而且卡住的这 25 秒里，
 * 我们**拿不到**那句错误（它要等退避跑完才抛出来）⇒
 * 「云端不可用」这个判定**根本来不及送到界面上**。
 *
 * ⇒ 所以：**在唯一能看到状态码的地方（fetch 咽喉）记一笔**，
 *   让上层**不必等那个错误**也能知道「云端现在不服务」。
 *
 * ── 为什么不用「把退避关掉」这种想法 ───────────────────────────────────
 * 退避在 SDK 内部（我们改不了）；能改的只有**状态码**与**等待时间**。
 * 这里记一笔观测，上层据此：
 *   ① **不再白等**：明知云端不服务，就不必再让它失败一次；
 *   ② **说得准**：那一档是「云端不可用」，不是「核不到」。
 *
 * ── 生命周期 ────────────────────────────────────────────────────────────
 * · **成功**的响应会清掉它（云端活了 ⇒ 立刻恢复真实判定）；
 * · 它只在**本 realm** 内有效（SW 与页面各有各的）——
 *   每个 realm 自己观测到自己那份，这是对的（各自的网络状况不同）。
 */

/** 观测的有效期：多久之内还算「刚刚不可用」。 */
const OUTAGE_WINDOW_MS = 60_000;

/**
 * 「刚刚观测到云端在/不在服务」的记忆窗口（毫秒）。
 *
 * ⚠️ 为什么要有它（2026-10-23，第 51 轮）：一轮同步里读会话有 **6-8 个点**
 * （ensureAuthenticated / requireSessionUserId / 删除广播 / 清墓碑 / 写设置 /
 * 下载侧 2-3 个），而每个点都会先问一句「云端在吗」⇒ 一轮同步多打 6-8 个请求。
 * 这个项目**刚因 egress 配额被封过**（生产实测 402）⇒ 往一个正在计配额的项目上
 * 加请求是往伤口上撒盐。
 *
 * ⇒ 短时间内问过一次就够了（**5 秒**）：
 *   · 5 秒内问过「在服务」 ⇒ 不再问（省掉 6-8 个请求）；
 *   · 5 秒内问过「不在服务」 ⇒ 直接报错（省掉请求，且**不等**它恢复）。
 *
 * 为什么 5 秒是安全的：
 *   · 窗口内云端真的挂了 ⇒ SDK 拿到的是「服务端不可用」⇒ 已被翻译成
 *     **瞬时故障**（503）⇒ **会话不会被删**（这正是本轮要保的东西）；
 *   · 窗口内云端恢复了 ⇒ 最多多等 5 秒 ⇒ 可接受。
 */
const OBSERVATION_WINDOW_MS = 5_000;

let lastUnavailableAt = 0;

/** 最近一次「探活/请求」观测到的结论（null = 从没观测过）。 */
type Observation = { kind: 'available' | 'unavailable'; at: number };
let lastObservation: Observation | null = null;

export const outageTracker = {
  /** 记一次观测：某个请求拿到了「服务端不可用」的状态码。 */
  noteUnavailable(now: number = Date.now()): void {
    lastUnavailableAt = now;
    lastObservation = { kind: 'unavailable', at: now };
  },

  /**
   * 记一次观测：**云端答了**（在服务）。
   *
   * 与 `noteUnavailable` 配对使用：探活成功时调用它 ⇒ 短时间内不必再问。
   */
  noteAvailable(now: number = Date.now()): void {
    lastObservation = { kind: 'available', at: now };
  },

  /**
   * 最近观测到过「服务端不可用」吗？
   *
   * @param windowMs 观测的有效期
   * @param now 当前时刻（可注入 ⇒ 便于测试）
   */
  isUnavailableRecently(windowMs: number = OUTAGE_WINDOW_MS, now: number = Date.now()): boolean {
    if (lastUnavailableAt === 0) return false;
    return now - lastUnavailableAt < windowMs;
  },

  /** 清掉观测（云端恢复 ⇒ 立刻回到真实判定）。 */
  clear(): void {
    lastUnavailableAt = 0;
    // 「答了」⇒「刚刚不可用」这个**暂定事实**作废。
    // 但「刚刚在服务」这个事实**继续成立**（一次成功的响应只会加强它）——
    // 否则每成功一个请求就把记忆清掉 ⇒ 记忆窗口形同虚设（省不下请求）。
    if (lastObservation?.kind === 'unavailable') lastObservation = null;
  },

  /**
   * 最近观测到的结论（「在服务」/「不在服务」/ 没有观测）。
   *
   * @param windowMs 记忆窗口（毫秒）
   * @param now 当前时刻（可注入 ⇒ 便于测试）
   */
  recentObservation(
    windowMs: number = OBSERVATION_WINDOW_MS,
    now: number = Date.now()
  ): 'available' | 'unavailable' | null {
    if (!lastObservation) return null;
    if (now - lastObservation.at >= windowMs) return null;
    return lastObservation.kind;
  },

  /** 上次观测的时刻（0 = 从没观测到）—— 只用于诊断。 */
  get lastSeenAt(): number {
    return lastUnavailableAt;
  },
};

/**
 * 仅测试用：忘掉**全部**观测（包括「刚刚在服务」的记忆）。
 *
 * ⚠️ 为什么需要它：模块级状态会**跨用例残留** —— 一个用例观测到「不可用」，
 * 下一个用例就会**跳过探活**（直接吃记忆）⇒ 那条「应当问过一句」的断言
 * 会变成**假红**，而「不许问刷新端点」那条会变成**假绿**（它根本没经过闸门）。
 *
 * ⚠️ 生产代码不许调它（与仓库既有约定同款：`__resetKeyCacheForTesting` /
 * `__resetCloudColumnProbeCacheForTests` / `__resetGroupsChangedBusForTests`）。
 */
export function __resetOutageTrackerForTests(): void {
  lastUnavailableAt = 0;
  lastObservation = null;
}
