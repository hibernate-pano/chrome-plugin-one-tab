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
 *   · postgrest-js 2.118（**REST 侧**）：`error = JSON.parse(body)` —— 错误对象
 *     **就是响应体本身**，**没有 code、没有 status**，且**不是 Error 实例**
 *     （`error instanceof Error` 为 false）。真实 HTTP 402 只在**信封**的
 *     `res.status` 上，被 `{ data, error }` 的解构丢掉 ⇒ 402 只能靠我们注入进
 *     响应体的 `http_status` 看见（注入机制不变）。
 *   · auth-js 2.118（**auth 侧**）：`AuthApiError { status: <翻译后的状态码>,
 *     code: undefined }`。⚠️ **这个 status 不是原始的 402**（2026-10-23 第 51 轮
 *     更正）：我们在 fetch 咽喉处把 auth 端点上的「服务端不可用」（402/503/52x）
 *     **翻译成了 503**（`core/authSdkStatus.ts` 的 `statusForAuthSdk`），为的是不让
 *     SDK 把一次云端故障当成「刷新令牌已死」而**删掉用户的会话**；而 auth-js 的
 *     `handleError` 会把**响应体整个丢掉**（只保留 message / status / code）
 *     ⇒ auth 侧**拿不到**原始 402，只剩 message 里那句服务端原文
 *     （含 `exceed_egress_quota` 标记）⇒ 本仓的**报文标记**判据在 auth 侧照样命中
 *     ⇒ 分类结论不变（503 本身也在「服务端不可用」集合里）。
 *
 * ⇒ 结论：**状态码是唯一可靠的「外部」机器判据**（另一类是我们**自己**写下的
 * `code = 'backend_unavailable'`，见 `isBackendUnavailable` 的①），
 * 而状态码必须由**唯一咽喉**注入：
 * `utils/supabase/client.ts` 的 `fetchWithTimeout`（所有 Supabase 流量的咽喉）
 * 把 HTTP 状态码写进响应体的 `http_status` 字段。写入的**不是** `code` ——
 * `code` 已被 PGRST204 / 42703 / 23502 消费（见 upload.ts / probe.ts /
 * missingColumn.ts），注入会改变那些既有语义。
 *
 * 为什么还要认 `exceed_egress_quota` 这类**报文标记**：网关/代理可能改写状态码
 * （例如把 402 转成 400 或 200+错误体）。这时状态码不再是 402，但报文里的
 * 违规标记仍在。两者任一命中即判「服务端不可用」——**任一**即可，不要求同时。
 *
 * ⚠️ 状态码有「**真实**」与「**自报**」之分（详见 `readHttpStatus` 的注释）：
 * 响应体里的 `http_status` 是**服务端自己说的话**（我们自己注入时它才等于
 * 真实状态码），而错误对象**顶层**的 `status` / `httpStatus` 是**传输层观测到的**
 * ⇒ 判据必须**先读顶层的**。
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
export const UNAVAILABLE_STATUS_CODES: readonly number[] = [402, 503, 520, 521, 522, 523, 524, 525, 526, 527];

/**
 * 读「**传输层观测到的**」HTTP 状态码（错误对象**顶层**的字段）。
 *
 * ── 为什么顶层字段才算「真实状态码」 ────────────────────────────────────
 * 顶层字段是**传输层/SDK 自己写上去的**（不是响应体里的一句自述）：
 *   · `status` —— `@supabase/auth-js` 2.118 的 `AuthApiError.status`
 *     （`src/lib/fetch.ts:145`：`new AuthApiError(msg, error.status || 500, code)`
 *     ⇒ 它就是 fetch 看到的那个 HTTP 状态码）；
 *   · `httpStatus` —— 我们自己的 `BackendUnavailableError.httpStatus`。
 *
 * ⇒ 这两个都是「**服务器真的这么回的**」。
 */
export const readTransportHttpStatus = (err: unknown): number | null => {
  if (typeof err !== 'object' || err === null) return null;
  const o = err as { status?: unknown; httpStatus?: unknown };
  for (const v of [o.status, o.httpStatus]) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
};

/**
 * 读「**响应体自报**」的 HTTP 状态码（`http_status`）。
 *
 * ── 为什么它是「自报」而不是「真实」 ────────────────────────────────────
 * `http_status` 是**响应体里的一个字段** —— 它是**服务端/网关对自己说的话**。
 * 平时它等于真实状态码，是因为**我们**在 fetch 咽喉处把真实状态码写进了响应体
 * （`utils/supabase/client.ts` 的 `injectHttpStatus`）—— 但那份注入是
 * 「`obj.http_status === undefined` 才写」⇒ **服务端自己带了这个字段时，
 * 注入会让位**，那个值就是**服务端的自述**，未必等于它真正回的状态码。
 *
 * ⚠️ 这条限制是**结构性的**，不是判据能补的：postgrest-js 2.118 的错误对象
 * **就是响应体本身**（`src/PostgrestBuilder.ts:450`：`error = JSON.parse(body)`），
 * 而真实状态码只留在**信封**的 `status` 上（同行 481）—— 信封被
 * `{ data, error }` 的解构丢掉 ⇒ 到了判据这里，REST 错误身上**只有响应体**。
 * ⇒ 真正的修法是在 fetch 咽喉处用一个**服务端不可能撞名**的字段名注入
 * （那在 `utils/supabase/client.ts`，不在本文件）。
 */
export const readSelfReportedHttpStatus = (err: unknown): number | null => {
  if (typeof err !== 'object' || err === null) return null;
  const v = (err as { http_status?: unknown }).http_status;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
};

/**
 * 从任意形状里读出一个数字型的 HTTP 状态码（读不到返回 null）。
 *
 * ── 优先级：**真实状态码 压过 自报状态码** ───────────────────────────────
 *   ① `status` / `httpStatus`（**顶层**）—— 传输层/SDK 写上去的 ⇒ 真实；
 *   ② `http_status`（**响应体里**）—— 服务端的自述 ⇒ 可能是假的。
 *
 * ⚠️ 为什么不能反过来（先读 `http_status`）：服务端/网关自己在错误体里带了
 * 一个 `http_status` 时（`injectHttpStatus` 让位给它），**真 503 会被读成 400**
 * ⇒ 判据说「不是服务端不可用」⇒ 界面说「请重试」—— 而重试一万次也一样。
 *
 * ⚠️ 三种既有形状**一个都不能丢**（本仓既有语义）：
 *   · postgrest-js 的错误**没有** `status`（错误体只有 message/code/…）⇒
 *     必须仍然能从 `http_status` 读到 402；
 *   · auth-js 的 `AuthApiError` 带 `status` ⇒ 必须仍然读得到；
 *   · 我们的 `BackendUnavailableError` 用 `httpStatus` ⇒ 必须仍然读得到。
 */
export const readHttpStatus = (err: unknown): number | null =>
  readTransportHttpStatus(err) ?? readSelfReportedHttpStatus(err);

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
 * 这个错误带「服务端不可用」的**机器码**吗（跨 realm 安全：只认结构化字段）。
 *
 * ⚠️ 为什么单抽出来：`isBackendUnavailable` 与 `isBackendUnavailableError`
 * **都要认它**，而后者又要兜底调前者 ⇒ 若在前者里直接调后者就是**互相递归**。
 */
const hasUnavailableCode = (err: unknown): boolean => {
  if (typeof err !== 'object' || err === null) return false;
  return (err as { code?: unknown }).code === BACKEND_UNAVAILABLE_CODE;
};

/**
 * 判据：这个错误是不是「服务端项目不可用」（用户等的是我们恢复，不是他重试）。
 *
 * 三条判据，任一命中即为真：
 *   ① **机器码** `code === 'backend_unavailable'`（我们自己的专用错误）；
 *   ② 状态码在 `UNAVAILABLE_STATUS_CODES` 里（402 / 503 / 52x）；
 *   ③ 报文里有「项目被限制」的标记（`exceed_egress_quota` 等）。
 *
 * 为什么①不能省（2026-10-23，第 51 轮补）：有些「云端不可用」**拿不到状态码** ——
 *   · 探活的「apikey 被拒」那一档：网关回 **401/403**，而 401/403 **不在**
 *     `UNAVAILABLE_STATUS_CODES` 里（那个集合的语义是「哪些 HTTP 状态码算服务端
 *     不服务」，另有用途，不许为此改它）；
 *   · `refineDeadlineOutcome` 的改判：观测只记了「什么时候不可用」，没记「多少」。
 * ⇒ 只认状态码与报文的话，这些错误在**每一个**走 `isBackendUnavailable` 的调用点
 * 都会**漏判**（最典型：`store/slices/authSlice.ts` 的 `authBackendUnavailableCopy`）
 * ⇒ 用户看到「请稍后重试」—— 正是这条判据要消灭的那句话。
 *
 * 为什么认它是**安全**的：`BackendUnavailableError` **只在**「服务端不可用」时
 * 被构造（全仓无第二个构造点），`code` 不是能撞上的普通字段。
 *
 * 为什么②可以独立成立：网关把 402 改写成 400 时，状态码判据失效，但标记还在。
 * 反过来，标记被本地化时状态码仍在。任一即可，不要求同时 —— 这是**扩大**
 * 判据的方向（宁可多认成「服务端不可用」，也不要把它当成「网络抖动」让用户
 * 一直重试）。
 *
 * 为什么**不**把「网络错误 / 5xx 之外的任何 4xx 状态码」也算进来：401/403/404/409
 * 作为**裸状态码**是**用户侧**的问题（令牌过期、RLS 没配、id 不存在），说成
 * 「服务端不可用」是甩锅给用户，而且会掩盖真正的配置错误。
 * ⚠️ 这与①不冲突：① 认的是**我们自己下的结论**（网关拒了 apikey ⇒ 云端不服务），
 * 不认「任何一个碰巧是 401 的错误」。
 */
export const isBackendUnavailable = (err: unknown): boolean => {
  if (hasUnavailableCode(err)) return true;
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
  // 判据仍认原始错误（SDK 的原始形状），这样**产生点没包成专用类**时
  // 也不会漏判 —— 包装是「锦上添花」，判据才是「底线」。
  // （`code` 那一条已收进 `isBackendUnavailable`，见 `hasUnavailableCode`。
  //  ⚠️ 这里**不能**反过来再单独判一次 `code` 之外还调 `isBackendUnavailable`，
  //  否则两函数互相递归 —— 所以 `code` 只在一个地方判。）
  return isBackendUnavailable(err);
};

/**
 * 「等到期限」这一档 ⇒ 到底落在哪一档（**判据层**，纯函数）。
 *
 * ── 为什么需要它（2026-10-23，第 51 轮）────────────────────────────────
 * 「等到期限」（`DeadlineExceededError`）只说明「**我们不等了**」，
 * 它**本身不说明任何原因** ⇒ 单看它，那一档是「**不知道**」。
 *
 * 而「不知道」若被原样送到界面上，同步路径会说「请重试」——
 * 而项目被限制（生产实测 402）时，**重试一万次结果一样**。
 *
 * ⇒ 但若我们**已经观测到**「云端明确不可用」（状态码判据，不是猜的），
 * 那么这次「等不到」是**有证据的**（刚刚真的回过 402/503）⇒ 那一档是
 * 「**云端不可用**」（等我们恢复），不是「请重试」。
 *
 * ⚠️ 为什么这个方向是安全的（判错时的代价不对称）：
 *   · 说成「云端不可用」⇒ 上游**保住本机数据 + 稍后再来**（fail-closed）；
 *   · 说成「请重试」⇒ 用户在项目被封禁期间一直重试（无用功，还烧配额）。
 * ⇒ 判错的方向是「把不可用说成网络抖动」（代价：用户多等一会儿），
 *   反过来（把网络抖动说成不可用）代价是**用户白等**⇒ 取「不可用」这侧更保守。
 *
 * ⚠️ 而「**没有**观测到不可用」时**必须**留在「不知道」：
 *   把「核不到」读成「云端不可用」= 把用户的网络说成我们挂了 ⇒ 指错了下一步。
 */
export type DeadlineOutcome =
  /** 「云端不可用」（等我们恢复）。 */
  | 'backend_unavailable'
  /** 「不知道」（核不到）。 */
  | 'unknown';

/**
 * 「等到期限」⇒ 落在哪一档（**纯函数**，判据层）。
 *
 * @param opts.deadlineExceeded         这次失败是不是「等到期限了」
 * @param opts.cloudUnavailableObserved 最近有没有**观测到**「云端明确不可用」
 */
export const classifyDeadlineOutcome = (opts: {
  deadlineExceeded: boolean;
  cloudUnavailableObserved: boolean;
}): DeadlineOutcome =>
  opts.deadlineExceeded && opts.cloudUnavailableObserved
    ? 'backend_unavailable'
    : 'unknown';

