/**
 * P0 手术 · SyncButton 展示层抽离（行为零变化）。
 * 预览渲染纯函数 + 本地进度模拟器与 Redux/同步调度解耦；
 * SyncButton 只保留状态装配与 sendSyncCommand 调度。
 */
import type { SyncPreviewSummary } from '@/utils/syncPreview';
import type { BackendStatusKind } from '@/components/layout/backendStatus';
import { logError } from '@/utils/log';

/* ── P1-6 · 覆盖模式的双闸门（纯函数，SyncButton 只做状态装配）─────────────
 *
 * 根因：覆盖模式按钮从弹窗打开的第一帧就是可点的——预览还在异步计算、或者预览
 * 直接读失败（summary 为 null，卡片上写着“暂无预览数据”），一次单击就会下发
 * forceRemote/overwriteCloud，把对面（云端或本地）的全部会话清掉，且全程没有
 * 任何确认。预览在这个时刻等于摆设。
 *
 * 两道闸门：
 * 1) 预览未就绪（计算中 / 读失败）→ 按钮 disabled，点不动。
 * 2) 预览就绪 → 第一次点击只“武装”（armed），把这次会删多少个会话写在卡片上；
 *    第二次点击才真正下发。runSyncAction 侧还有一道 isOverwriteGateOpen 兜底，
 *    防止有人绕过 UI 直接调。
 */

export type SyncMode = 'overwrite' | 'merge';
export type OverwriteTargetLabel = '云端' | '本地';

export const syncModeOf = (actionKey: string): SyncMode =>
  actionKey.endsWith('overwrite') ? 'overwrite' : 'merge';

export const describeOverwriteRisk = (
  summary: SyncPreviewSummary,
  targetLabel: OverwriteTargetLabel,
  /**
   * 覆盖时**不会被删除或覆盖**的会话数（2026-10-20 P1）。
   *
   * 指「对端有、这台设备读不出来、而本机又没有副本」的那几组：删掉它们就是
   * 永久丢失（无回收站），所以覆盖上传会跳过它们（判据见
   * core/overwriteUploadGuard.ts）。
   *
   * 为什么要在这里说出来：覆盖模式的风险文案原文是「直接替换现状」，而这一句
   * 在有受保护会话时**不再成立**（那几行会留在原地）。预览必须预告实际结果，
   * 否则用户点两下确认之后才发现「云端没被完全替换」＝ 预览说了假话。
   *
   * 默认 0 = 没有需要保护的会话 ⇒ 原文案逐字不变（用户依赖的那句风险提示）。
   */
  preservedRemoteCount: number = 0
): string => {
  const base =
    // 「一个都不删」时不能说成「直接替换现状：预计删除 0 个会话」——
    // 自带存储（WebDAV）的覆盖是全量上行 + 清单并集，云端独有会话确实原样保留
    //（见 syncPreview.buildUploadPreviewSummary 的 preserveRemoteOnly）。
    summary.deletions === 0
      ? `覆盖模式会把本次数据写入${targetLabel}现状：不会删除${targetLabel}上的任何会话、更新 ${summary.updates} 个会话，操作不可撤销。再点一次确认执行。`
      : `覆盖模式会用本次数据直接替换${targetLabel}现状：预计删除 ${summary.deletions} 个会话、更新 ${summary.updates} 个会话，操作不可撤销。再点一次确认执行。`;
  if (preservedRemoteCount <= 0) return base;
  return (
    `${base}` +
    `另有 ${preservedRemoteCount} 个会话这台设备读不出来，${targetLabel}上那几份不会被删除或覆盖。`
  );
};

export type OverwriteClickDecision =
  | { type: 'blocked'; reason: string }
  | { type: 'armed'; reason: string }
  | { type: 'run' };

export interface OverwriteClickInput {
  summary: SyncPreviewSummary | null;
  isPreviewLoading: boolean;
  hasPreviewError: boolean;
  isArmed: boolean;
  isBusy: boolean;
  targetLabel: OverwriteTargetLabel;
  /**
   * 覆盖时不会被删除或覆盖的会话数（2026-10-20 P1）。
   * 缺省 0 = 没有 ⇒ 风险文案与既往逐字一致。
   */
  preservedRemoteCount?: number;
}

/**
 * 覆盖按钮每次点击的裁决。关键不变量：**预览未就绪时任何输入都不得返回 'run'**，
 * 且未武装状态下永远不会返回 'run'——即“一次点击清空对面”这条路径被堵死。
 */
export const decideOverwriteClick = (input: OverwriteClickInput): OverwriteClickDecision => {
  if (input.isBusy) {
    return { type: 'blocked', reason: '同步进行中，请稍候' };
  }
  if (input.isPreviewLoading) {
    return { type: 'blocked', reason: '预览还在计算中，计算完成后才能选覆盖模式' };
  }
  if (!input.summary) {
    return {
      type: 'blocked',
      reason: input.hasPreviewError
        ? '预览读取失败，不知道这次会删掉什么，覆盖模式已锁定；可改用合并模式'
        : '预览数据尚未就绪，覆盖模式已锁定',
    };
  }
  if (input.isArmed) {
    return { type: 'run' };
  }
  return {
    type: 'armed',
    reason: describeOverwriteRisk(input.summary, input.targetLabel, input.preservedRemoteCount ?? 0),
  };
};

/** runSyncAction 的硬闸门：覆盖模式必须带已确认标记，否则直接拒跑（合并模式不拦） */
export const isOverwriteGateOpen = (input: {
  mode: SyncMode;
  isConfirmed: boolean;
  isBusy: boolean;
  /** 见 syncGateInput：承载「当前身份能否真的完成一次同步」的判定，不是「登录了没」。 */
  isAuthenticated: boolean;
}): boolean => {
  if (input.isBusy || !input.isAuthenticated) return false;
  if (input.mode === 'overwrite' && !input.isConfirmed) return false;
  return true;
};

/* ── C 组：同步入口的可见性与「可执行失败文案」（2026-10-18）─────────────
 *
 * 根因（三个同源的「不可发现 / 说谎」缺陷）：
 * 1. 工具栏同步按钮整组按 `if (!canSync) return null` 隐藏 ⇒ 云端未登录的新用户
 *    **完全看不到同步存在**（顶栏空一格），而 README 承诺「工具栏同步按钮仍可
 *    手动上传/下载」。
 * 2. `isOverwriteGateOpen` 的 `isAuthenticated` 形参被塞进了 `canSync`
 *    （后端或已登录）这个**混合语义**；只放宽渲染而不动它，未登录用户就能开弹窗、
 *    点覆盖、点两下毫无反应 —— 正是本仓库反复消灭的那类缺陷。
 * 3. 未登录时 `reason='not_authenticated'` 只有 download 方向有特判，upload
 *    方向落到 `spec.failureMessage`（「上传失败，请重试」）这种无信息量的话。
 *
 * 下面三个纯函数把这三件事各自定死，组件只做状态装配。
 */

/** 身份判定的两种来源（`syncBackend === 'supabase'` 时登录是必须的）。 */
export interface SyncGateInput {
  syncBackend: 'supabase' | 'webdav';
  isAuthenticated: boolean;
}

/**
 * 「当前身份能不能真的完成一次同步」。
 *
 * 为什么不直接用 isAuthenticated：自带存储（WebDAV）用户没有 TapStack 账号，
 * isAuthenticated 恒为 false；判据必须按后端分流（与 authGuard / backgroundSync
 * 同口径）。
 */
export const syncIdentityCanRun = (input: SyncGateInput): boolean =>
  input.syncBackend === 'webdav' || input.isAuthenticated;

/**
 * 工具栏同步按钮组**是否渲染**。
 *
 * 刻意写成一张**数据表**而不是「按身份判断」（2026-10-18 C 组）：
 * 原缺陷是 `if (!canSync) return null`，而 canSync 混着登录态，于
 * 云端未登录的新用户整组按钮凭空消失（顶栏空格），连「有同步」都不知道，
 * 与 README「工具栏同步按钮仍可手动上传/下载」直接冲突。
 *
 * 现在这张表只回答「这个后端有没有手动同步功能」——当前两个后端都有
 *（WebDAV 不需要登录，云端由下面的入口闸门说清缺登录）。将来若真的
 * 出现不支持手动同步的后端，必须**特意把它从这里删掉**，而不是默认继承。
 */
const BACKENDS_WITH_MANUAL_SYNC: ReadonlyArray<SyncGateInput['syncBackend']> = [
  'supabase',
  'webdav',
];

export const shouldRenderSyncControls = (
  syncBackend: SyncGateInput['syncBackend']
): boolean => BACKENDS_WITH_MANUAL_SYNC.includes(syncBackend);

/**
 * 身份不足时，第一时间（在用户点上传/下载的瞬间）给出的提示。
 * 返回 null 表示身份够用，不必打断。
 *
 * 为什么必须在这一刻出声：放宽渲染后，未登录用户能开弹窗、能点覆盖两下；
 * 若这里也静默，他就得到「点了完全没反应」。
 */
export const syncIdentityBlockedCopy = (input: SyncGateInput): string | null =>
  syncIdentityCanRun(input)
    ? null
    : '还没有登录 TapStack 云端，登录后同步才能使用。请先点右上角「⋯」菜单里的「登录 / 注册」。';

/**
 * 点上传/下载时是否允许开弹窗。
 *
 * 为什么必须在**入口**拦：放宽了渲染门禁后，若入口静默放行，未登录用户会经历
 * 「按钮出现 → 弹窗能开 → 点覆盖两下 → 毫无反应」。缺身份就当场说清缺什么。
 */
export type SyncEntryDecision =
  | { type: 'open' }
  | { type: 'blocked'; reason: string };

export const decideSyncEntry = (
  input: SyncGateInput & { isBusy: boolean }
): SyncEntryDecision => {
  if (input.isBusy) return { type: 'blocked', reason: '同步进行中，请稍候' };
  const missing = syncIdentityBlockedCopy(input);
  if (missing) return { type: 'blocked', reason: missing };
  return { type: 'open' };
};

/** 同步失败时 reason（内部枚举）→ 用户可执行文案的翻译表。 */
export const SYNC_REASON_COPY: Record<string, string> = {
  already_syncing: '同步正在进行中，请稍候',
  precheck_unknown:
    '本地存储读取失败，已中止同步以保护你的未上传内容，请稍后重试',
  // 上传后 UPLOAD_GUARD_MS（35s，见 syncDecision.ts）内的手动下载被跳过：
  // 云端已是本地新状态，再拉只会用旧数据覆盖（或与在途上传竞态）。
  recent_upload_guard: '刚完成上传，云端已是最新状态，无需下载',
  pending_upload_failed:
    '还有未上传的本地改动，已中止下载以免覆盖它们，请先完成上传',
  snapshot_failed: '本地快照创建失败，已中止同步以保护现有数据',
  // 2026-10-17：用**空云端**覆盖会把本机会话整体清空且不可逆
  // （1.22.0 起无回收站），syncDecision.decideForceRemoteOverwrite
  // 在覆盖路径上拦下了它。必须把「本机数据没动」说出来 ——
  // 否则用户看到一次失败的同步，却不知道自己刚差点丢掉全部会话。
  overwrite_empty_cloud_refused:
    '云端没有任何数据，已中止覆盖以免清空本机会话（你的本地数据没有变化）。如需清空请手动删除会话',
  // 2026-10-18 B 组：readConfiguredBackendId() 读不到本机设置 ⇒
  // 这一轮**不知道该往哪个后端同步**。这不是「没登录」，措辞必须分开，
  // 否则会把一个存储/设置读取故障说成「请去登录」。
  backend_unknown: '读不到同步设置，本轮不知道该用哪个后端，已中止以免写错地方。请重新打开设置页确认后端选择',
  // 2026-10-18 C 组：未登录在 upload 方向原先没有任何条目，会落到
  // spec.failureMessage（「上传失败，请重试」）—— 一句既没说是没登录、
  // 也没说下一步的话。口径对齐 HeaderDropdown 的「请先登录以使用同步功能」。
  not_authenticated: '未登录：同步需要 TapStack 云端账号，请先点「⋯」菜单里的「登录 / 注册」',
  // 2026-10-20 C-06：删除熔断是**保护性中止**，不是普通失败。
  // syncEngine 在写入之前就中止了本轮下载（本地数据一个字节都没动），
  // 原先它没有登记在案 ⇒ isBareEnum('failsafe_triggered') 为真 ⇒ 落到
  // 兜底文案「下载失败，请重试」——用户既不知道本地数据没被动过，
  // 又被引导去重试（重试只会再次触发熔断，白跑一趟）。
  //
  // 【文案必须自足】SW 那条下载分支只回传 `error: r.reason`，
  // 把 `r.error`（中文可读原因）丢了 —— 本条不能依赖那个字段透传。
  failsafe_triggered:
    '本次同步会丢弃过多会话，已中止以保护你的本地数据（你的本地数据没有变化）。请先确认云端/云盘上的会话是否完整（例如目录被清空或移动过），确认无误后再手动重试',
};

/** 纯 snake_case 枚举（如 `precheck_unknown`）不该原样弹给用户。 */
const isBareEnum = (reason: string): boolean => /^[a-z_]+$/.test(reason);

/**
 * 给日志 / 诊断用的机器前缀。
 *
 * `validation_failed: ` 是 syncEngine 拼出来的（`validation_failed: ${validation.reason}`），
 * 里面的中文原因才是给人看的，前缀本身对用户没有意义 —— 弹出去只会让人
 * 以为出了什么英文错误码。
 *
 * 判据写成一个**通用**形态（`snake_case 词 + 冒号`）而不是只认
 * `validation_failed`：前缀是机器标记，与具体是哪个 reason 无关；
 * 只认一个字面量等于赌它永远不变 —— 将来多一个 `xxx_failed:` 就又漏出去了。
 */
const MACHINE_PREFIX_RE = /^\s*[a-z][a-z0-9_]*\s*:\s*/i;

/**
 * 「像机器错误串」的特征。
 *
 * 判据来自一个事实：这是**全中文**界面，用户读得懂的失败原因一定是中文。
 * 命中下列特征 ⇒ 它是机器串（数据库报错、浏览器网络报错、JS 运行时异常名、
 * 堆栈帧……），必须换成中文兜底，原始串只进 console。
 */
const MACHINE_ERROR_SIGNATURES: readonly RegExp[] = [
  /failed to fetch/i,
  /network\s*error/i,
  /duplicate key value/i,
  /violates?\b/i,
  /\bconstraint\b/i,
  /\b(?:Type|Syntax|Range|Reference|Network|Unknown)Error\b/,
  /undefined is not\b/i,
  /is not a function/i,
  /cannot read propert/i,
  /\bERR_[A-Z_]+\b/,
  /\bat\s+[\w.$<>]*\s*\(/, // 堆栈帧
  /:\d+:\d+/, // 行列号
];

/** 是否含中日韩统一表意文字（用来判断「这段文本已经是中文」）。 */
const HAS_CJK = /[一-鿿]/;

/**
 * 这段文本是不是「机器错误串」而不是人话。
 *
 * 两条判据（任一命中即是）：
 *   1. 命中机器特征词（duplicate key / constraint / Failed to fetch / Error 名 …）；
 *   2. 完全不含中文 —— 全中文界面里，一段纯英文的技术串对用户没有意义。
 */
const looksLikeMachineError = (text: string): boolean => {
  if (MACHINE_ERROR_SIGNATURES.some(re => re.test(text))) return true;
  return !HAS_CJK.test(text);
};

/**
 * 一次同步失败的最终文案（来源优先级从高到低）：
 * 1. reason 已登记 ⇒ SYNC_REASON_COPY（逐条翻译，不退化成裸枚举）；
 * 2. reason 是纯 snake_case 枚举 ⇒ spec.failureMessage（枚举原文只进日志）；
 * 3. reason 带人类可读文本 ⇒ 剥掉机器前缀后原样显示；
 * 4. reason 是机器错误串（英文数据库/网络报错）⇒ 中文兜底，原始串只进 console。
 *
 * 方向无关：未登录在上传方向同样要说人话（2026-10-18 C 组）。
 */
export const resolveSyncFailureCopy = (input: {
  reason?: string | null;
  fallbackMessage: string;
}): string => {
  const reason = input.reason;
  if (reason == null || reason === '') return input.fallbackMessage;
  const mapped = SYNC_REASON_COPY[reason];
  if (mapped) return mapped;
  // 纯枚举：原文对用户等于没说 ⇒ 回退到兜底（**原样**，不加后缀：
  // 「上传失败，请重试」已经是完整的可执行文案）。
  if (isBareEnum(reason)) return input.fallbackMessage;
  // 剥掉机器前缀（`validation_failed: `），只留人话部分
  const stripped = reason.replace(MACHINE_PREFIX_RE, '').trim();
  if (!stripped) return input.fallbackMessage;
  if (looksLikeMachineError(stripped)) {
    // 机器串：换成中文兜底，原始串**只进 console**，绝不进 UI
    logError('[syncPreviewView] 同步失败原因（机器串，仅日志）:', reason);
    return `${input.fallbackMessage}。若反复出现，请导出诊断信息`;
  }
  return stripped;
};

/* ── C2：设置页 WebDAV banner 的状态文案（2026-10-18）─────────────────────
 *
 * 原缺陷：banner 的判据只有 `settings.syncBackend === 'webdav'` —— 它回答的是
 * 「用户选了哪个后端」，却输出「已启用：数据同步到你自己的云盘」。于是
 * 「已配好但本次会话未解锁」（重开浏览器 / 刚点过面板里的「锁定」）的用户
 * 看到的是「已启用」，而同步实际一次都不会跑。banner 与同页上方的 hint 互相矛盾，
 * 用户据此以为数据正在备份到自己的云盘。
 *
 * 判据必须是真的解析结果（backendStatus.classifyBackendResolution 的完整三态，
 * 含 lockedKind），不是「再写一个只看 syncBackend 的判断」——那等于把原缺陷
 * 换个写法。
 */
export type WebDavBannerKind = 'unconfigured' | 'locked' | 'unreadable' | 'ready';

/**
 * 分类结果 → banner 形态。
 *
 * `error` / `unknown` 一律不得落到 `ready`：那两种意味着**读不到**配置或解锁态，
 * 此时宣称「已启用」与原来的谎话同类。它们有自己的 `unreadable` 形态。
 */
export const webDavBannerKindOf = (status: BackendStatusKind): WebDavBannerKind => {
  switch (status) {
    case 'ready':
      return 'ready';
    case 'unconfigured':
      return 'unconfigured';
    case 'locked':
      return 'locked';
    case 'error':
    case 'unknown':
    default:
      return 'unreadable';
  }
};

/** banner 文案。只有 `ready` 允许说「已启用」。 */
export const WEB_DAV_BANNER_COPY: Record<WebDavBannerKind, string> = {
  unconfigured: '还没有配置云盘。填好地址与账号并点「保存并启用」后才会开始同步。',
  locked: '已配置，但本次会话尚未解锁：重新输入应用密码后同步才会恢复。',
  unreadable: '读不到云盘的配置或解锁状态，同步暂不可用：请重新保存一次配置。',
  ready: '已启用：数据同步到你自己的云盘。',
};

export const webDavBannerCopy = (status: BackendStatusKind): string =>
  WEB_DAV_BANNER_COPY[webDavBannerKindOf(status)];

/**
 * 色档与文案同表维护：颜色是「这件事是否正常」的第二个信号，
 * 只有 `ready` 允许用「一切正常」的蓝底 —— 否则未解锁 banner 配上蓝色
 * 依旧会让人一眼当成绿灯。
 */
export const WEB_DAV_BANNER_TONE: Record<WebDavBannerKind, string> = {
  unconfigured: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
  locked: 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  unreadable: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
  ready: 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
};

/* ── C1 另一半：菜单里的同步状态卡（2026-10-18）────────────────────────────
 *
 * 根因：卡片条件是 `(isAuthenticated && user) || settings.syncBackend === 'webdav'`，
 * 云端**未登录**用户菜单里既看不到后端配置状态，也看不到上次成功同步时间，
 * 连「去设置」入口都没有 —— 与工具栏同步按钮被藏起来是同一个病：同步对新用户
 * 不存在。
 *
 * 但简单把条件放宽还不够：Supabase 分支永远没有 lockedReason，
 * classifyBackendResolution 会返回 `ready / 已配置并解锁` —— 未登录时直接
 * 把这句渲染出来就是新的谎话。所以状态行文案必须由本函数统一决定：
 * 云端 + 未登录 ⇒ `未登录`，不说任何「已配置/已解锁」。
 */
export interface MenuSyncStatusView {
  /** 卡片抬头：邮箱 / 「自带存储」/ 「未登录」。 */
  headline: string;
  /** 状态行前缀，按后端分流（照抄「自带存储」到云端就会撒谎）。 */
  prefix: 'TapStack 云端' | '自带存储';
  /** 状态短语。云端未登录时恒为「未登录」，不转述后端的 ready。 */
  label: string;
  /** 圆点色档。 */
  tone: 'ok' | 'warn' | 'muted' | 'error';
  /** 是否给「去设置」入口。 */
  actionable: boolean;
  /** 是否给「去登录」入口（云端未登录时唯一的下一步）。 */
  needsLogin: boolean;
}

export const resolveMenuSyncStatus = (input: {
  syncBackend: 'supabase' | 'webdav';
  isAuthenticated: boolean;
  userEmail: string | null | undefined;
  backend: { label: string; tone: MenuSyncStatusView['tone']; actionable: boolean };
}): MenuSyncStatusView => {
  const isWebdav = input.syncBackend === 'webdav';
  const prefix = isWebdav ? '自带存储' : 'TapStack 云端';
  const headline = input.userEmail
    ? input.userEmail
    : isWebdav
      ? '自带存储'
      : '未登录';

  // 云端 + 未登录：后端解析再「ready」也不代表能同步（Supabase 分支不检查登录态）。
  if (!isWebdav && !input.isAuthenticated) {
    return {
      headline,
      prefix,
      label: '未登录',
      tone: 'warn',
      actionable: false,
      needsLogin: true,
    };
  }

  return {
    headline,
    prefix,
    label: input.backend.label,
    tone: input.backend.tone,
    actionable: input.backend.actionable,
    needsLogin: false,
  };
};

/**
 * （2026-10-19 审计 C-6：原 getSyncStrategyLabel 已删除）
 *
 * 它把 settings.syncStrategy 翻译成「本地优先 / 云端优先 / 检测冲突后询问」，
 * 而那个设置**没有任何入口**，合并也固定走 mergeOpStamped（组级 LWW）——
 * 也就是说这个函数在陈述一个从未被执行的策略。留着它，早晚会有人再把它
 * 接到界面上，重新引入一条谎报。
 */

const MAX_VISIBLE_NAMES = 2;

const renderPreviewNames = (label: string, names: string[], toneClass: string) => {
  if (names.length === 0) {
    return null;
  }
  const shown = names.slice(0, MAX_VISIBLE_NAMES);
  const extra = names.length - shown.length;
  return (
    <p
      className={`truncate text-[0.72rem] leading-5 ${toneClass}`}
      title={`${label}：${names.join('、')}`}
    >
      {label}：{shown.join('、')}
      {extra > 0 ? ` 等 ${names.length} 个` : ''}
    </p>
  );
};

/** 带符号的净变化：+N / −N / ±0，用 tabular-nums 保证多行数字右对齐不跳动。 */
export const formatDelta = (delta: number): { text: string; toneClass: string } => {
  if (delta > 0) return { text: `+${delta}`, toneClass: 'text-emerald-600 dark:text-emerald-400' };
  if (delta < 0) return { text: `−${Math.abs(delta)}`, toneClass: 'text-rose-600 dark:text-rose-400' };
  return { text: '±0', toneClass: 'text-slate-400 dark:text-slate-500' };
};

/**
 * 同步预览卡片的内容区。
 *
 * 三块固定结构（顺序稳定，便于两张卡片横向/纵向对齐）：
 *   1) 模式说明（会说清这次怎么改动目标侧）
 *   2) 新增 / 更新 / 删除 三个等宽数字块（统一尺寸与基线）
 *   3) 目标侧会话数的「现有 → 预计（净变化）」一行 + 示例名
 *
 * 颜色改用主题类（dark: 变体）而非内联固定色，避免暗色主题下白底黑字发糊。
 */
export const renderPreviewSummary = (
  summary: SyncPreviewSummary | null,
  targetLabel: '云端' | '本地',
  modeDescription: string,
  /**
   * 覆盖时不会被删除或覆盖的会话数（2026-10-20 P1）。
   * 缺省 0 = 没有 ⇒ 卡片与既往一致。
   */
  preservedRemoteCount: number = 0,
) => {
  if (!summary) {
    return (
      <p className="mt-3 text-[0.78rem] leading-5 text-slate-400 dark:text-slate-500">暂无预览数据</p>
    );
  }

  const stats = [
    { key: 'added', label: '新增', value: summary.additions, tone: 'text-emerald-600 dark:text-emerald-400' },
    { key: 'updated', label: '更新', value: summary.updates, tone: 'text-sky-600 dark:text-sky-400' },
    { key: 'deleted', label: '删除', value: summary.deletions, tone: 'text-rose-600 dark:text-rose-400' },
  ];
  const delta = formatDelta(summary.afterCount - summary.beforeCount);

  return (
    <div className="mt-3 flex flex-col gap-3">
      <p className="text-[0.78rem] leading-5 text-slate-500 dark:text-slate-400">{modeDescription}</p>

      <div className="grid grid-cols-3 gap-2">
        {stats.map(stat => (
          <div
            key={stat.key}
            className="flex min-w-0 flex-col items-center gap-0.5 rounded-xl border border-slate-100 bg-slate-50 px-2 py-2.5 dark:border-slate-700/60 dark:bg-slate-800/60"
          >
            <span className={`text-[0.7rem] font-medium ${stat.tone}`}>{stat.label}</span>
            <span className="text-lg font-semibold leading-none tabular-nums text-slate-900 dark:text-slate-50">
              {stat.value}
            </span>
          </div>
        ))}
      </div>

      <div className="rounded-xl bg-slate-50/70 px-3 py-2 dark:bg-slate-800/40">
        <div className="flex items-center justify-between gap-2 text-[0.76rem] leading-5 text-slate-500 dark:text-slate-400">
          <span className="truncate">{targetLabel}会话</span>
          <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
            <span className="text-slate-700 dark:text-slate-300">{summary.beforeCount}</span>
            <span aria-hidden="true" className="text-slate-400 dark:text-slate-500">→</span>
            <span className="font-medium text-slate-900 dark:text-slate-100">{summary.afterCount}</span>
            <span className={`text-[0.72rem] font-medium ${delta.toneClass}`}>{delta.text}</span>
          </span>
        </div>
        {summary.unchanged > 0 && (
          <div className="mt-0.5 text-[0.7rem] leading-5 text-slate-400 dark:text-slate-500">
            另有 {summary.unchanged} 个会话保持不变
          </div>
        )}
        {preservedRemoteCount > 0 && (
          <div className="mt-0.5 text-[0.7rem] leading-5 text-amber-600 dark:text-amber-400">
            另有 {preservedRemoteCount} 个会话这台设备读不出来，{targetLabel}上那几份不会被删除或覆盖
          </div>
        )}
      </div>

      {(summary.addedNames.length > 0 || summary.updatedNames.length > 0 || summary.deletedNames.length > 0) && (
        <div className="flex flex-col gap-0.5">
          {renderPreviewNames('新增', summary.addedNames, 'text-emerald-600 dark:text-emerald-400')}
          {renderPreviewNames('更新', summary.updatedNames, 'text-sky-600 dark:text-sky-400')}
          {renderPreviewNames('删除', summary.deletedNames, 'text-rose-600 dark:text-rose-400')}
        </div>
      )}
    </div>
  );
};

/**
 * 本地进度模拟器工厂：SW 不回传 onProgress，用一组 setTimeout 推进进度条。
 * 返回 timer 句柄，调用方在真实结果回来时 clearTimeout 并归位 100%。
 */
export const createSimulatedProgress = (onTick: (p: number) => void): ReturnType<typeof setTimeout> => {
  const steps = [10, 30, 55, 80];
  let i = 0;
  const tick = () => {
    if (i < steps.length) {
      onTick(steps[i]);
      i += 1;
      return setTimeout(tick, 400);
    }
    return undefined;
  };
  return setTimeout(tick, 200);
};
