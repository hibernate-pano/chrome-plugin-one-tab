/**
 * 「服务端现在不服务」**对 auth SDK 的翻译**（判据层，纯函数）。
 *
 * ── 这条性质是什么 ──────────────────────────────────────────────────────
 * `@supabase/auth-js` 2.118 在**刷新失败**时的收尾动作分两种：
 *   · 失败被它当成「**瞬时故障**」（网络错、500/501/502/503/504/520-530）
 *     ⇒ **保留用户的会话**（抛 `AuthRetryableFetchError`）；
 *   · 失败被它当成「**服务端明确拒绝**」（其余一切状态码）
 *     ⇒ **删掉用户的会话**（`_removeSession()`）——
 *     它的推理是「刷新令牌被拒 ⇒ 会话真的死了 ⇒ 留着也没用」。
 *
 * 而 **402**（Supabase 项目被限制 / egress 配额超限，生产实测 2026-10-22）
 * **恰恰落在第二种**：服务端**根本没评估**那个刷新令牌，它只是「现在不服务」。
 * ⇒ 于是一次云端故障 = 全员被静默登出（本机会话令牌被删掉）。
 *
 * ── 后果（2026-10-23 真机抓到的）───────────────────────────────────────
 *  ① 用户明明登录着，界面说「未登录」；
 *  ② `authCache.clearAuthState()` 把本机登录缓存一起清掉；
 *  ③ 用户去重新输密码 —— 而 402 期间重新登录**必然失败** ⇒ 死循环；
 *  ④ 云端恢复后，用户**必须**重新登录（会话令牌已经被 SDK 删了）。
 *
 * ── 修法：把「服务端现在不服务」翻译成 SDK 眼里的「瞬时故障」──────────
 * SDK 只对 {500,501,502,503,504,520-530} 保留会话 ⇒ 把这类状态码在
 * **唯一咽喉处**（`utils/supabase/client.ts` 的 fetch 包装）翻译成 503。
 *
 * ⚠️ **原始状态码在 auth 端点上其实看不到**（2026-10-23，第 51 轮更正）：
 * 它照旧写进了响应体的 `http_status`（既有机制），但 **auth-js 把响应体丢了**
 * —— `handleError` 只把 message / status / code 装进 `AuthApiError`
 * ⇒ 我们拿到的错误对象上是**翻译后的 503**，不是 402。
 * ⇒ 「402 = 项目被限制」这条既有语义在 **REST 侧**一字不变（那边读得到
 * `http_status`），在 **auth 侧**则靠**报文标记**兜住：402 的响应体里那句
 * 「…exceed_egress_quota…」会进 `AuthApiError.message`
 * ⇒ `core/backendUnavailable.ts` 的标记判据照样命中 ⇒ **分类结论不变**，
 * 变的只是「诊断时看到的状态码」（503 而不是 402）。
 *
 * ── 为什么只翻 auth 端点 ───────────────────────────────────────────────
 * REST 端点上「状态码」不驱动任何**破坏性**动作（postgrest-js 不会删本机
 * 数据）⇒ 不必翻译；auth 端点上它会**删用户的会话** ⇒ 必须翻译。
 * 范围越小越安全。
 *
 * ── 为什么这是判据层而不是 IO 层 ───────────────────────────────────────
 * 「哪些状态码对 SDK 来说是瞬时的」「哪些端点会删用户的会话」都是
 * **规则**，不是 IO ⇒ 放 core（可被直接断言）；IO（改写响应）留在 client.ts。
 */
import { UNAVAILABLE_STATUS_CODES } from './backendUnavailable';

/**
 * auth-js 2.118 当作「瞬时故障」的状态码（这一档**保留用户的会话**）。
 *
 * 取自 `@supabase/auth-js` 2.118 的 `NETWORK_ERROR_CODES`（不是猜的）：
 * 500/501/502/503/504（标准服务端/网关错误）+ 520-530（Cloudflare 一族）。
 */
export const AUTH_SDK_TRANSIENT_STATUSES: ReadonlySet<number> = new Set([
  500, 501, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 528, 529, 530,
]);

/**
 * 翻译后用的状态码。
 *
 * 必须是 503：它是 auth-js 的瞬时集合成员（⇒ SDK 保留会话），
 * 同时也在我们自己的「服务端不可用」集合里（⇒ 分类结论不变）。
 */
export const TRANSIENT_STATUS_FOR_SDK = 503;

/** 429（Too Many Requests / 限流）。 */
const HTTP_TOO_MANY_REQUESTS = 429;

/** 401（Unauthorized）。 */
const HTTP_UNAUTHORIZED = 401;

/** 403（Forbidden）。 */
const HTTP_FORBIDDEN = 403;

/**
 * 这个 URL 是不是 **auth 端点**（只有它会因状态码而删掉用户的会话）。
 *
 * 形状取自 Supabase 的 auth 路径：`/auth/v1/...`（含 `/auth/v1/token`、
 * `/auth/v1/user`、`/auth/v1/logout`）。
 */
export const isAuthEndpoint = (url: string): boolean => /\/auth\/v\d+\//.test(url);

/**
 * 这个 URL 是不是「**刷新会话**」那个端点（`grant_type=refresh_token`）。
 *
 * ⚠️ 为什么单独认它（2026-10-23，第 51 轮）：同一个 429，在两个端点上
 * **含义完全不同**：
 *   · **刷新端点**上的 429 = 「慢一点」（限流）⇒ **不是**「你的凭证不对」
 *     ⇒ 把它当「明确拒绝」⇒ SDK 删掉用户的会话 ⇒ 一次限流 = 一次全员登出；
 *   · **登录端点**（`grant_type=password`）上的 429 = 「尝试太频繁」
 *     ⇒ 那句话**就是**对用户说的（请稍后再试）⇒ 不许翻译。
 *
 * ⇒ 只在**刷新端点**上翻译，登录端点原样透传。
 */
export const isRefreshEndpoint = (url: string): boolean =>
  /\/auth\/v\d+\/token/.test(url) && /grant_type=refresh_token/.test(url);

/**
 * 响应体里有没有 **GoTrue 自己的判决**（机器字段，不是文案）。
 *
 * ⚠️ 为什么问这个（2026-10-23，第 51 轮）：刷新端点上的 **401/403** 有两种
 * 完全不同的来源：
 *   · **GoTrue 的判决**（刷新令牌真的被拒）⇒ body 里有 `error` / `error_code`
 *     / `code` 字段（GoTrue 的机器字段）⇒ 会话真的死了 ⇒ **删掉它是对的**；
 *   · **网关的判决**（网关拒了我们的 apikey / 项目被暂停）⇒ body 里**没有**
 *     那些字段，只有 `message` / `hint`
 *     （生产实测 2026-10-23：`{"hint":"Double check your Supabase `anon`
 *     or `service_role` API key.","message":"Invalid API key"}`）
 *     ⇒ 凭证**根本没被评估** ⇒ 删掉会话是**误伤**。
 *
 * ⇒ 判据看的是**字段在不在**（结构），不是句子里写了什么（文案）——
 * 与本仓「文案不许成为判据」同源。
 */
export const hasGoTrueErrorField = (body: unknown): boolean => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const o = body as { error?: unknown; error_code?: unknown; code?: unknown };
  return (
    typeof o.error === 'string' ||
    typeof o.error_code === 'string' ||
    typeof o.code === 'string'
  );
};

/**
 * 给 **auth SDK** 看的状态码（纯函数）。
 *
 * 规则（只有一条，但必须说清）：
 * **「服务端现在不服务」不是「你的凭证无效」。**
 * 凡是落在「服务端不可用」集合里、又落在 auth 端点上的状态码，
 * 都要翻译成 SDK 眼里的「瞬时故障」—— 否则 SDK 会把一次云端故障
 * 当成「刷新令牌已死」并**删掉用户的会话**。
 *
 * @param url   请求的 URL（auth 端点判定用）
 * @param status 原始 HTTP 状态码
 * @param body  响应体（已解析的 JSON；读不出来时传 undefined）
 * @returns 给 SDK 看的状态码（多数情况下与传入的相同）
 */
export const statusForAuthSdk = (
  url: string,
  status: number,
  body?: unknown,
): number => {
  // 非 auth 端点：状态码不驱动破坏性动作 ⇒ 原样透传。
  if (!isAuthEndpoint(url)) return status;
  // SDK 已经当它是瞬时故障 ⇒ 原样透传（503/52x 走的就是这一支）。
  if (AUTH_SDK_TRANSIENT_STATUSES.has(status)) return status;
  // 「服务端不可用」但 SDK 会当成「明确拒绝」⇒ 翻译。
  if (UNAVAILABLE_STATUS_CODES.includes(status)) return TRANSIENT_STATUS_FOR_SDK;
  // 刷新端点上的 **429（限流）** = 「慢一点」，不是「你的凭证不对」
  // ⇒ 翻译（否则一次限流就是一次全员登出）。
  // ⚠️ 只限**刷新端点**：登录端点上的 429 是「尝试太频繁」，
  //    那句话本来就该给用户看 ⇒ 原样透传。
  if (status === HTTP_TOO_MANY_REQUESTS && isRefreshEndpoint(url)) {
    return TRANSIENT_STATUS_FOR_SDK;
  }
  // 刷新端点上的 **401/403**：只有在「**不是** GoTrue 自己的判决」时才翻译。
  //
  // ⚠️ 为什么必须问「body 里有没有 GoTrue 的机器字段」（2026-10-23，第 51 轮）：
  //   · **GoTrue 说**刷新令牌被拒（body 里有 `error` / `error_code` / `code`）
  //     ⇒ 会话**真的**死了 ⇒ 删掉它是对的 ⇒ 原样透传（让 SDK 说「请重新登录」）；
  //   · **网关说**我们的 apikey 被拒（body 里只有 `message` / `hint`；
  //     生产实测 2026-10-23：key 缺失或不对 ⇒ 401「Invalid API key」）
  //     ⇒ 凭证**根本没被评估** ⇒ 删掉用户的会话是**误伤**
  //     ⇒ 翻译成「瞬时故障」⇒ SDK 保留会话。
  //
  // 这一条**挡得住的是误伤**：没有它，一次 key 轮换 = 一次全员登出，
  // 而且用户重新登录也登不进去（登录端点同样 401）⇒ 死循环。
  if (
    (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) &&
    isRefreshEndpoint(url) &&
    !hasGoTrueErrorField(body)
  ) {
    return TRANSIENT_STATUS_FOR_SDK;
  }
  // 其余（400/401/403/404/429…）：**用户侧**的问题 ⇒ 原样透传。
  // ⚠️ 401/400 是「刷新令牌真的被拒」⇒ SDK 删会话是**对的**，
  //    翻译它们会把「请重新登录」这条诚实的话变成谎话。
  return status;
};
