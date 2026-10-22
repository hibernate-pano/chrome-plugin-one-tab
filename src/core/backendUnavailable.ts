/**
 * 「云端项目被限制 / 服务不可用」的识别与人话（2026-10-22，402 收口）。
 *
 * ── 为什么需要这一层 ─────────────────────────────────────────────────────
 * 2026-10-22 生产实测：整个 Supabase 项目被封禁（egress 配额超限），**所有**
 * 端点（`/rest/v1/`、`/auth/v1/health`）都返回 HTTP 402，body 是：
 *
 *   {"message":"Service for this project is restricted due to the following
 *    violations: exceed_egress_quota. The project owner must upgrade their
 *    plan or remove spend caps to restore service."}
 *
 * 修复前用户看到的是「上传失败，请重试。若反复出现，请导出诊断信息」。三处都错：
 *   ① 「请重试」是**错的方向** —— 服务端项目被封禁，重试一万次结果一样；
 *   ② 「请导出诊断信息」是**甩锅给用户** —— 诊断信息对用户毫无用处，
 *      真正需要知道这件事的是产品负责人；
 *   ③ 「若反复出现」是废话 —— 它**正在**反复出现。
 *
 * 更糟的是：**这条英文串会被中文判定吞掉**（纯英文 ⇒ `looksLikeMachineError`
 * 命中「不含 CJK」⇒ 走中文兜底），原始信息（配额被限、这是服务端问题）**全丢**。
 * 用户完全不知道「是云端服务出问题了，不是我的数据或操作有问题」。
 *
 * ── 判据为什么是「机器字段」而不是「文案匹配」 ─────────────────────────
 * 本仓既有纪律（见 components/layout/backendStatus.ts 的注释）：文案匹配让 UI
 * 分类取决于另一处文件里的措辞，改一句文案就能把「服务端故障」显示成「未配置」，
 * 把用户指向一个他已经做过的动作。
 *
 * 而 Supabase 的 402 **恰好有**机器字段可用 —— 但不在 `error.code` 上：
 *   · postgrest-js 2.118：`error = { message }`，**没有 code、没有 status**，
 *     且**不是 Error 实例**（`error instanceof Error` 为 false）。HTTP 402 只在
 *     信封的 `res.status` 上，被 `{ data, error }` 的解构丢掉。
 *   · auth-js 2.118：`AuthApiError { status: 402 }`，`status` 是原生的，
 *     但 `code` 是 undefined。
 *
 * ⇒ 结论：**状态码是唯一可靠的机器判据**，而它必须由**唯一咽喉**注入：
 * `utils/supabase/client.ts` 的 `fetchWithTimeout`（所有 Supabase 流量的咽喉）
 * 把 HTTP 状态码写进响应体的 `http_status` 字段。写入的**不是** `code` ——
 * `code` 已被 PGRST204 / 42703 / 23502 消费（见 upload.ts / probe.ts /
 * missingColumn.ts），注入会改变那些既有语义。
 *
 * 为什么还要认 `exceed_egress_quota` 这类**报文标记**：网关/代理可能改写状态码
 * （例如把 402 转成 400 或 200+错误体）。这时状态码不再是 402，但报文里的
 * 违规标记仍在。两者任一命中即判「服务端不可用」——**任一**即可，不要求同时。
 */

/**
 * 「服务端项目被限制」的机器码。
 *
 * 为什么不复用 `backend_locked`（lockedBackendError.ts）：那一条的语义是
 * 「**用户还没配置/解锁**」——正常用户状态，不是故障，后台据此让路（不进退避）。
 * 本条是「**服务端出问题了**」——故障且**不可重试**，两者需要的收尾动作不同。
 */
export const BACKEND_UNAVAILABLE_CODE = 'backend_unavailable';

/**
 * Supabase 把项目封禁时返回的报文标记（2026-10-22 生产实测）。
 *
 * 为什么要认**报文标记**而不只认状态码：见文件头「判据为什么是机器字段」——
 * 网关改写状态码时，标记仍在。两者是「或」的关系。
 *
 * ⚠️ 这里匹配的是**服务端返回的英文原文**，不是界面文案 —— 与本仓
 * 「界面文案不许成为判据」的纪律一致（改界面文案不会让判据失效）。
 */
const SERVICE_RESTRICTED_MARKERS: readonly RegExp[] = [
  /exceed_egress_quota/i,
  /service for this project is restricted/i,
  /restricted due to the following violations/i,
];

/**
 * 不可重试的服务端状态码。
 *
 * 402（Payment Required）：项目被封禁 / 配额超限 —— **重试无用**。
 * 503/520-527：网关与上游临时不可用 —— 同样是「重试意义不大」的一类
 * （服务不可用不是「再点一次就好」）。把它们放在一起的理由见
 * `isBackendUnavailable` 的注释：这一类的共同点是**用户等的是服务端恢复，
 * 不是自己重试**。
 */
const UNAVAILABLE_STATUS_CODES: readonly number[] = [402, 503, 520, 521, 522, 523, 524, 525, 526, 527];

/** 从任意形状里读出一个数字型的 HTTP 状态码（读不到返回 null）。 */
export const readHttpStatus = (err: unknown): number | null => {
  if (typeof err !== 'object' || err === null) return null;
  const o = err as { status?: unknown; http_status?: unknown; httpStatus?: unknown };
  for (const v of [o.http_status, o.httpStatus, o.status]) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
};

/** 从任意形状里读出错误文本（message / msg / 报文原文），读不到返回 ''。 */
const readErrorText = (err: unknown): string => {
  if (typeof err === 'string') return err;
  if (typeof err !== 'object' || err === null) return '';
  const o = err as { message?: unknown; msg?: unknown; body?: unknown; error?: unknown };
  const parts: string[] = [];
  for (const v of [o.message, o.msg, o.body, o.error]) {
    if (typeof v === 'string') parts.push(v);
  }
  return parts.join(' ');
};

/**
 * 判据：这个错误是不是「服务端项目不可用」（用户等的是我们恢复，不是他重试）。
 *
 * 两条判据，任一命中即为真：
 *   ① 状态码在 `UNAVAILABLE_STATUS_CODES` 里（402 / 503 / 52x）；
 *   ② 报文里有「项目被限制」的标记（`exceed_egress_quota` 等）。
 *
 * 为什么②可以独立成立：网关把 402 改写成 400 时，状态码判据失效，但标记还在。
 * 反过来，标记被本地化时状态码仍在。任一即可，不要求同时 —— 这是**扩大**
 * 判据的方向（宁可多认成「服务端不可用」，也不要把它当成「网络抖动」让用户
 * 一直重试）。
 *
 * 为什么**不**认「网络错误 / 5xx 之外的任何 4xx」：401/403/404/409 是**用户侧**
 * 的问题（令牌过期、RLS 没配、id 不存在），说成「服务端不可用」是甩锅给用户，
 * 而且会掩盖真正的配置错误。
 */
export const isBackendUnavailable = (err: unknown): boolean => {
  const status = readHttpStatus(err);
  if (status !== null && UNAVAILABLE_STATUS_CODES.includes(status)) return true;
  const text = readErrorText(err);
  if (!text) return false;
  return SERVICE_RESTRICTED_MARKERS.some(re => re.test(text));
};

/**
 * 「服务端不可用」的专用错误（形状照抄 lockedBackendError.ts 的纪律）。
 *
 * 为什么要一个专用类：这条错误要**穿过好几层**（fetch 边界 → SDK → upload.ts
 * → syncEngine → SW 回包 → UI），而每一层都只透传 `message` 的话，机器判据
 * 到不了最后一层。与 `LockedBackendError` 同一条思路：**用 `code` 这个结构化
 * 标记做跨层识别，不解析 message**。
 *
 * 为什么 `code` 用 `backend_unavailable` 而不是 HTTP 402：跨层的是「是什么
 * 错」，不是「HTTP 码是多少」。402 只在**产生点**有意义。
 */
export class BackendUnavailableError extends Error {
  /** 稳定的机器码：下游按它分类，不解析 message。 */
  readonly code: string = BACKEND_UNAVAILABLE_CODE;
  /** HTTP 状态码（若判据命中时拿得到）—— 只用于日志/诊断。 */
  readonly httpStatus?: number;

  constructor(message: string, httpStatus?: number) {
    super(message);
    this.name = 'BackendUnavailableError';
    if (typeof httpStatus === 'number') this.httpStatus = httpStatus;
  }
}

/**
 * 判据：这个错误是不是「服务端不可用」（跨 realm 安全：认 `code` 字段）。
 *
 * 与 `isLockedBackendError` 同款：既认 `instanceof` 又认 `code` 字段 ——
 * 错误对象若跨 realm（不同执行上下文）`instanceof` 会失败，而 `code` 是
 * 结构化标记；两者都认，等于给这条判据加了一层与 realm 无关的兜底。
 */
export const isBackendUnavailableError = (err: unknown): boolean => {
  if (err instanceof BackendUnavailableError) return true;
  if (typeof err !== 'object' || err === null) return false;
  if ((err as { code?: unknown }).code === BACKEND_UNAVAILABLE_CODE) return true;
  // 判据仍认原始错误（SDK 的原始形状），这样**产生点没包成专用类**时
  // 也不会漏判 —— 包装是「锦上添花」，判据才是「底线」。
  return isBackendUnavailable(err);
};

/**
 * 把任意形状的错误**归一**成「服务端不可用」的专用错误。
 *
 * 归一发生在**产生点**（fetch 边界）—— 那一层是唯一能同时看到 HTTP 状态码
 * 与响应体的地方。归一之后，上游每一层只需要 `throw`/`instanceof`，
 * 不再各自去猜「这个 402 长什么样」。
 *
 * 不是「服务端不可用」时**原样返回**（不改写、不吞掉）—— 调用方照旧按
 * 原来的错误处理。
 */
export const toBackendUnavailableError = (err: unknown): unknown => {
  if (!isBackendUnavailable(err)) return err;
  if (err instanceof BackendUnavailableError) return err;
  const status = readHttpStatus(err);
  const text = readErrorText(err);
  return new BackendUnavailableError(
    text || '服务端项目被限制，暂时无法访问云端服务',
    status ?? undefined
  );
};
