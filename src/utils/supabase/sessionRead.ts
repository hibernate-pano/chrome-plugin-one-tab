/**
 * 读会话的**唯一入口**（所有 `getSession()` 调用点都走它）。
 *
 * ── 为什么要有这一层（2026-10-23，第 51 轮）───────────────────────────────
 * 裸调 `supabase.auth.getSession()` 有三个洞，每一个都在**云端故障**时暴露：
 *
 *   ① **它会删掉用户的会话。** 本地会话过期时 SDK 会去刷新；刷新撞上 402
 *      （项目被限制）时，SDK 认定「刷新令牌被拒」⇒ `_removeSession()`
 *      ⇒ 一次云端故障 = 全员被静默登出（实测，见
 *      tests/guards/authSessionSurvivesOutage.test.ts）。
 *   ② **它会拖 25 秒。** 402 被翻译成 SDK 眼里的「瞬时故障」后，SDK 会
 *      连打 8 次、退避 25.4 秒（`_refreshAccessToken` 的 `retryable()`）。
 *   ③ **它没有上限。** 弱网时这一句能挂到 45 秒（fetch 的超时），
 *      而同步管线的协议上界是 30 秒 ⇒ 用户看到的是「操作超时」。
 *
 * ⇒ 这一层把四件事一次做完：
 *   · **先问一句**「云端在吗」（`requireCloudAvailable`）—— 明确不可用就**不碰 SDK**
 *     ⇒ ①②都不会发生（会话连读都没被读，更没机会被删）；
 *   · **给等待一个上限**（`withDeadline`）⇒ ③ 不会发生；
 *   · **失败原样带出**（`error` 不许被丢掉）⇒ 上游能按**失败原因**分流，
 *     而不是把「核不到」读成「没登录」；
 *   · **「等到期限」这一档要落地**（见 `refineDeadlineOutcome`）——
 *     若已经**观测到**「云端不可用」，那一档就是「云端不可用」（等我们恢复），
 *     不是「请重试」（项目被限制时重试一万次结果一样）。
 *     ⇒ 弹窗侧与同步侧**共用这一份口径**。
 *
 * ── 为什么 `getSession` 是**参数**而不是在这里直接调 ──────────────────────
 * 登录态核对（store/slices/authSlice.ts）走的是**按需加载**的 SDK 门面
 * （弹窗首屏不许为一句「核一下」下载 75KB）；同步路径走的是静态 SDK。
 * ⇒ 这里只认「一个能读会话的函数」，两条路共用同一套闸门。
 */
import {
  BackendUnavailableError,
  classifyDeadlineOutcome,
  isBackendUnavailableError,
  readHttpStatus,
} from '@/core/backendUnavailable';
import { isDeadlineExceeded, withDeadline } from '@/utils/deadline';
import { requireCloudAvailable } from './cloudAvailability';
import { outageTracker } from './outageTracker';

/**
 * 读会话的**等待上限**（毫秒）。
 *
 * ── 为什么是 5 秒 ───────────────────────────────────────────────────────
 * · 健康时一次刷新约 200–400ms ⇒ 5 秒是几十倍余量，不会误伤；
 * · 弱网下一次刷新可能要 1–3 秒 ⇒ 5 秒仍能容下；
 * · 25.4 秒的退避风暴被砍到 5 秒 ⇒ 界面最多卡 5 秒。
 *
 * ⚠️ 到了上限**不是**「没登录」，而是「**不知道**」——
 * 那一档由调用方记成「核不到」，界面说「联系不上云端」，
 * 登录态**按缓存保留**。
 *
 * ⚠️ 而「不知道」**只在没有别的证据时**才成立：若刚刚真的观测到
 * 「云端不可用」，那一档就被**改判**成「云端不可用」（见
 * `refineDeadlineOutcome` 与 `core/backendUnavailable.ts` 的
 * `classifyDeadlineOutcome`）—— 判据在**这一层**统一，两条路径共用。
 */
export const SESSION_READ_DEADLINE_MS = 5_000;

/** 读会话的结果（形状与 SDK 的 `getSession()` 一致，泛型化会话与错误类型）。 */
export interface SessionReadResult<T, E = unknown> {
  data: { session: T | null };
  error: E;
}

/**
 * 读会话（**唯一入口**）。
 *
 * @param getSession 一个能读会话的函数（**惰性**传入：闸门通过后才加载 SDK）
 * @param label      出现在错误消息里的名字（诊断用）
 * @param deadlineMs 等待上限（**默认就是生产值**；只给测试缩短用 ——
 *                   见下面那条注释）
 */
export const readSessionSafely = async <T, E = unknown>(
  getSession: () => Promise<SessionReadResult<T, E>>,
  label: string,
  deadlineMs: number = SESSION_READ_DEADLINE_MS,
): Promise<SessionReadResult<T, E>> => {
  // ① 云端明确不服务 ⇒ **不碰 SDK**（会话因此不会被删，见文件头①）。
  await requireCloudAvailable(label);
  // ② 云端在服务（或不知道）⇒ 去读，但**有上限**（见文件头③）。
  try {
    return await withDeadline(getSession(), deadlineMs, label);
  } catch (err) {
    // ③ 「等到期限」这一档要**落地**（见 refineDeadlineOutcome 的注释）。
    throw refineDeadlineOutcome(err, label);
  }
};

/**
 * 「等到期限」⇒ 最终抛什么（**这一层是口径的唯一出处**）。
 *
 * ── 为什么要有这一步（2026-10-23，第 51 轮）────────────────────────────
 * `withDeadline` 到点就抛 `DeadlineExceededError`（机器码 `deadline_exceeded`）。
 * 那个错误**只说明「我们不等了」**，不说明任何原因 ⇒ 上游拿到的既不是
 * 「云端不可用」也不是「核不到」⇒ 界面只能说「请重试」。
 *
 * 而在**同步路径**上这件事特别刺眼：项目被限制（生产实测 402）时，
 * 「请重试」是**错的方向** —— 重试一万次结果一样。
 *
 * ⇒ 于是把判断**下沉到这里**（`readSessionSafely` 就在 `requireCloudAvailable`
 * 旁边，**拿得到 `outageTracker`**）：弹窗侧与同步侧**共用同一份口径**，
 * 不会再出现「弹窗说云端不可用、同步说请重试」这种各说各话。
 *
 * ⚠️ 判据本身在 `core/backendUnavailable.ts` 的 `classifyDeadlineOutcome`
 * （纯函数 ⇒ 可被直接断言）；这里只负责把 IO（观测）喂给它。
 */
const refineDeadlineOutcome = (err: unknown, label: string): unknown => {
  const outcome = classifyDeadlineOutcome({
    deadlineExceeded: isDeadlineExceeded(err),
    // ⚠️ 这是**观测**，不是猜测：`outageTracker` 只在真的收到 402/503/52x 时
    // 才记一笔（见 utils/supabase/client.ts 的 fetch 咽喉）。
    cloudUnavailableObserved: outageTracker.isUnavailableRecently(),
  });
  if (outcome === 'backend_unavailable') {
    // 抛**专用错误**（带机器码 `backend_unavailable`）⇒ 上游能落到
    // 「云端不可用」那一档（而不是「请重试」）。
    // ⚠️ 不带状态码：观测只记了「什么时候」，没记「多少」——
    //   而状态码只用于日志/诊断，机器判据靠的是 `code`。
    return new BackendUnavailableError(`云端项目暂时不可用（${label}）`);
  }
  // 「不知道」⇒ 原样带出 `DeadlineExceededError`
  //（绝不许被读成「没登录」，也不许被读成「云端不可用」）。
  return err;
};

/**
 * 把「读会话失败」变成一个**说得清**的错误（**保住机器判据**）。
 *
 * ⚠️ 判据必须喂**原始**错误：包装过的 `new Error(...)` 只剩 message，
 * 状态码（402/503）就看不见了 ⇒ 上游会把它读成「普通失败」⇒
 * 用户看到「请重试」—— 而重试一万次也一样（项目被限制时）。
 */
export const toSessionReadError = (err: unknown, label: string): Error => {
  const detail = err instanceof Error ? err.message : String(err);
  // ⚠️ 用 `isBackendUnavailableError`（认 `code`）而不是只认状态码：
  // 我们自己的专用错误**可能没带状态码**（探活的「记忆窗口」那一支、以及
  // `refineDeadlineOutcome` 的改判都是这样 —— 观测只记了「什么时候不可用」，
  // 没记「多少」）。只认状态码的话，它会被**降级成普通 Error** ⇒ `code` 丢掉
  // ⇒ 上游又落回「请重试」—— 正是这条判据要消灭的那句话。
  if (isBackendUnavailableError(err)) {
    return new BackendUnavailableError(
      `${label}失败：${detail}`,
      readHttpStatus(err) ?? undefined,
    );
  }
  return new Error(`${label}失败：${detail}`);
};

/**
 * 「服务端明确说没有会话」时的话。
 *
 * ⚠️ 只有在**没有 error** 的前提下才能说这句：读失败（断网/云端故障）时
 * 说「请重新登录」是一句**更重的谎**（用户会去输密码，而那必然失败）。
 */
export const NO_SESSION_MESSAGE = '用户未登录或会话已过期，请重新登录';
