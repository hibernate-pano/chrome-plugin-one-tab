/**
 * 「这台机器现在算不算登录着 TapStack 云端」——**判据层**（纯函数，不碰网络、不碰存储）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * 弹窗（popup）**不再在挂载时联网核登录态** —— 那会把整条 Supabase SDK 拉下来
 * （SDK ≈58KB gzip + 门面 ≈16KB gzip，**每次开弹窗都付一次**），
 * 而用户点开弹窗只想看本机会话列表。
 *
 * ⇒ 「登录态」改由 **service worker** 核实后报回来（SW 侧 SDK 是**静态依赖**，
 * 已经在扩展包里，不产生任何下载）。而「核完了 ⇒ 算什么」这个判定必须是
 * **纯函数**，才能被直接断言（IO 留在 IO 层）。
 *
 * ── 四种状态，而不是一个布尔 ────────────────────────────────────────────
 * 「登录 / 没登录」看着是两个事实，但真实世界有**第三、第四种**：
 *
 *   · **服务端整体不可用**（生产实测 402：项目被限制）⇒ **用户确实登录着**，
 *     只是我们**确认不了**。把它读成「没登录」是一句**更重的谎**
 *     —— 用户会去重新登录、重新输密码，甚至以为账号被删了，而真正的原因是
 *     「我们的云端项目被限制」；
 *   · **网络断了** ⇒ 我们**不知道**。「不知道」也不许读成「没登录」。
 *
 * ⇒ 这两种都必须与「没登录」分开，界面也才说得出一句对的话。
 *
 * ── 与「本机缓存登录态」的关系 ──────────────────────────────────────────
 * 缓存登录态（`authCache`，`chrome.storage.local`）是**暂定事实**：
 * 它可能过期（用户在别处登出了）。所以：
 *   · **核到了** ⇒ 以核到的为准；
 *   · **没核到（不可用 / 不知道）** ⇒ **保留缓存那份**（宁可暂定，
 *     也不要在一闪之间把用户的账号状态说成「没登录」）。
 */

import type { User } from '@/types/tab';
import type { AuthCheckState } from '@/types/tab';

/**
 * 四种登录态。
 *
 * ⚠️ 它是 `AuthCheckState`（`src/types/tab.ts`）去掉「还没核」那一档 ——
 * 形状只定义**一次**（types 层），本文件只做**推导**，
 * 免得两处各写一份枚举、慢慢漂成两个口径。
 */
export type AuthStatusKind = Exclude<AuthCheckState, 'unchecked'>;

/** 账号身份（只带真正需要的字段，不把整个 User 传过消息通道）。 */
export interface AuthStatusUser {
  id: string;
  email: string;
}

/** 登录态的判定结果。 */
export interface AuthStatus {
  kind: AuthStatusKind;
  /** 账号（`authenticated` 时必有；其它状态时是「本机缓存里那份」，可能为 null）。 */
  user: AuthStatusUser | null;
  /** 说人话的补充说明（只在 `unknown` 时有；不面向用户，只进日志）。 */
  detail?: string;
}

/** 从本仓的 `User` 里取出身份字段（只留 id / email）。 */
export function toAuthStatusUser(user: User | null | undefined): AuthStatusUser | null {
  if (!user || !user.id) return null;
  return { id: user.id, email: user.email };
}
/**
 * 「核完了 ⇒ 算什么」的判据（纯函数）。
 *
 * @param verifiedUser 服务端核到的账号（`null` = 没核到 / 没登录）
 * @param cachedUser   本机缓存里的账号（**暂定事实**，用来兜底）
 * @param verifiedNoSession 服务端**明确**回答了「没有会话」—— 这是**事实**，
 *   不是「没拿到账号」。⚠️ 必须与 `failureDetail` 分开（见下）。
 * @param backendUnavailable 服务端是否整体不可用（402 之类）
 * @param failureDetail 失败原因（只进日志，不面向用户）
 */
export function decideAuthStatus(input: {
  verifiedUser?: AuthStatusUser | null;
  cachedUser?: AuthStatusUser | null;
  verifiedNoSession?: boolean;
  backendUnavailable?: boolean;
  failureDetail?: string;
}): AuthStatus {
  const cached = input.cachedUser ?? null;

  // ① 核到了 ⇒ 以核到的为准。
  if (input.verifiedUser) {
    return { kind: 'authenticated', user: input.verifiedUser };
  }

  // ② **明确**核到「没有会话」⇒ 真的没登录。
  //    ⚠️ 这一支是**事实**，不是「没拿到结果」的副作用 ——
  //    修复前这里靠 `failureDetail` 的真伪来区分（`if (input.failureDetail)`），
  //    于是「核失败但没有失败原因」会被读成「没登录」——
  //    **失败原因的长相不该决定事实的性质**。
  if (input.verifiedNoSession) {
    return { kind: 'not_authenticated', user: null };
  }

  // ③ 服务端整体不可用 ⇒ **不许**读成「没登录」。
  //    用户多半登录着（缓存里就有账号）⇒ 保留缓存那份，界面据此说
  //    「云端暂时不可用」而不是「请重新登录」。
  if (input.backendUnavailable) {
    return { kind: 'backend_unavailable', user: cached };
  }

  // ④ 兜底：**核不到就是核不到**（fail-closed）⇒ 「不知道」。
  //    ⚠️ 绝不能在这里落到「没登录」—— 那正是第 50 轮修掉的那个谎：
  //    「核不到」被读成「没登录」⇒ 用户去重新输密码，而重登解决不了断网。
  return { kind: 'unknown', user: cached, detail: input.failureDetail };
}

/**
 * 这一档在界面上**怎么说**（纯函数）。
 *
 * ⚠️ 「服务端不可用」与「没登录」在界面上必须是**两句不同的话**：
 * 前者说「云端暂时不可用，本地没丢」（用户什么都不用做）；
 * 后者说「去登录」（用户要重新输密码）。把它们合并成一句 ⇒
 * 用户在服务端故障时去重新登录 ⇒ 白白折腾，还以为账号被删了。
 */
export function authStatusCopy(
  status: AuthStatus,
  copy: {
    backendUnavailable: string;
    unknown: string;
  }
): string | null {
  if (status.kind === 'backend_unavailable') return copy.backendUnavailable;
  if (status.kind === 'unknown') return copy.unknown;
  return null;
}
