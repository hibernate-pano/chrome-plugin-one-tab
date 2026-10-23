/**
 * 「读会话失败」→ **它到底意味着什么**（判据层，纯函数）。
 *
 * ── 为什么需要这一层（2026-10-23，第 50 轮）──────────────────────────────
 * Supabase 的 `getSession()` 在**刷新失败**时返回
 * `{ data: { session: null }, error }` —— session 是 null，但**「为什么 null」
 * 决定了后面该对用户说什么**：
 *
 *   · 刷新令牌被吊销 / 无效（`refresh_token_not_found` 等）⇒ **会话真的死了**
 *     ⇒ 用户确实需要重新登录 ⇒ 说「未登录」是**诚实的**；
 *   · 断网 / 超时 / 页面导航打断（`AuthRetryableFetchError`）⇒ 我们**不知道**
 *     ⇒ 说「未登录」是**谎**（用户会去重新输密码，而重登在断网时必然失败）；
 *   · 服务端整体不可用（生产实测 402）⇒ 用户**多半登录着**，只是确认不了。
 *
 * 修复前这一层是**塌掉**的：`authSlice` 的 `getSession()` 解构**只取 data**、
 * **丢掉 error** ⇒ 上面三种情况一律读成「没有会话」⇒
 * ① 界面说「未登录」；② `authCache.clearAuthState()` 把本机缓存一起清空。
 *
 * ── 判据用**机器字段**，不靠文案匹配 ───────────────────────────────────
 * 与 `core/backendUnavailable.ts` 同一纪律：界面文案一改，判据不能跟着漂。
 * 可用的机器字段（`@supabase/auth-js` 2.118）：
 *   · `error.code`：`ErrorCode` 枚举（`refresh_token_not_found` 等）；
 *   · `error.name`：错误类名（`AuthSessionMissingError` 等）；
 *   · `error.status`：HTTP 状态码（401 = 令牌被拒 ⇒ 会话死了）。
 */
import { isBackendUnavailable, readHttpStatus } from './backendUnavailable';

/** 读会话失败的三种含义。 */
export type SessionFailureKind =
  /** 会话**真的死了**（刷新令牌被吊销 / 无效 / 已被用过）⇒ 确实没登录。 */
  | 'session_expired'
  /** 核不到：服务端整体不可用（402 之类）⇒ 用户多半登录着。 */
  | 'backend_unavailable'
  /** 核不到：其它原因（断网、超时、通道断了）⇒ **不知道**。 */
  | 'unknown';

/**
 * 「会话真的死了」的机器码集合。
 *
 * 取自 `@supabase/auth-js` 的 `ErrorCode` 枚举（不是猜的）：
 *   · `refresh_token_not_found` —— 刷新令牌在服务端不存在（被吊销 / 换设备）；
 *   · `refresh_token_already_used` —— 刷新令牌已被用过（轮换后重复提交）；
 *   · `session_not_found` / `session_expired` —— 服务端说这个会话没了；
 *   · `bad_jwt` —— 令牌本身无效。
 *
 * ⚠️ 这四个的共同点：**再重试一万次也一样** ⇒ 用户只能重新登录。
 * 断网那类**不在**这里 —— 它重试一下就好了，说成「请重新登录」是把用户
 * 指向一个解决不了问题的动作。
 */
const DEAD_SESSION_CODES: ReadonlySet<string> = new Set([
  'refresh_token_not_found',
  'refresh_token_already_used',
  'session_not_found',
  'session_expired',
  'bad_jwt',
]);

/** 「会话真的死了」的错误类名（`@supabase/auth-js` 2.118）。 */
const DEAD_SESSION_NAMES: ReadonlySet<string> = new Set([
  'AuthSessionMissingError',
  'AuthInvalidRefreshTokenError',
  'AuthInvalidJwtError',
]);

/** 从任意形状里读出错误码（`code`）。 */
const readErrorCode = (err: unknown): string | undefined => {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
};

/** 从任意形状里读出错误类名（`name`）。 */
const readErrorName = (err: unknown): string | undefined => {
  if (typeof err !== 'object' || err === null) return undefined;
  const name = (err as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
};

/** 从任意形状里读出错误文本（只用于日志/诊断，不参与判据）。 */
const readErrorText = (err: unknown): string => {
  if (typeof err === 'string') return err;
  if (typeof err !== 'object' || err === null) return '';
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' ? message : '';
};

/**
 * 读会话失败 ⇒ 它意味着什么（纯函数）。
 *
 * 判定顺序**不能换**：
 *   ① **服务端不可用**先判（402 / 503 / 52x / 项目被限制的报文标记）——
 *      它的 `code` 有时也长得像会话问题，但含义完全相反（用户多半登录着）；
 *   ② 再判**会话真的死了**（机器码 / 类名 / 401）；
 *   ③ 其余（断网、超时、页面导航打断）⇒ **不知道**。
 */
export function classifySessionFailure(error: unknown): {
  kind: SessionFailureKind;
  /** 原始错误文本（只进日志，不面向用户）。 */
  detail: string;
  /** HTTP 状态码（若拿得到）—— 只用于日志/诊断。 */
  httpStatus?: number;
} {
  const detail = readErrorText(error);
  const httpStatus = readHttpStatus(error) ?? undefined;

  // ① 服务端整体不可用 —— 「等我们恢复」，不是「请重新登录」。
  if (isBackendUnavailable(error)) {
    return { kind: 'backend_unavailable', detail, httpStatus };
  }

  // ② 会话真的死了 —— 机器码优先，其次错误类名，最后 401（令牌被拒）。
  const code = readErrorCode(error);
  if (code && DEAD_SESSION_CODES.has(code)) {
    return { kind: 'session_expired', detail, httpStatus };
  }
  const name = readErrorName(error);
  if (name && DEAD_SESSION_NAMES.has(name)) {
    return { kind: 'session_expired', detail, httpStatus };
  }
  if (httpStatus === 401) {
    return { kind: 'session_expired', detail, httpStatus };
  }

  // ③ 核不到 —— 「不知道」。
  return { kind: 'unknown', detail, httpStatus };
}
