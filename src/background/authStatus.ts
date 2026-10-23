/**
 * 「核登录态」这件事的**后台一侧**（service worker）。
 *
 * ── 为什么核在 SW、而不在弹窗 ────────────────────────────────────────────
 * 弹窗挂载时核登录态 ⇒ 必须加载整条 Supabase SDK（≈75KB gzip）⇒
 * **每次开弹窗都付一次**，而用户点开弹窗只想看本机会话列表。
 *
 * ⇒ 核的这件事搬到 SW：SW 侧的 SDK 是**静态依赖**（`src/service-worker.ts`
 * 静态 import 门面）⇒ 已经在扩展包里 ⇒ **不产生任何下载**。
 * 弹窗只发一条消息问「核完了吗」，拿回一个判定结果。
 *
 * ⚠️ 判据在 `src/core/authStatus.ts`（纯函数）—— 本文件只做 IO。
 */

import { store } from '@/store';
import { getCurrentUser } from '@/store/slices/authSlice';
import { authCache } from '@/utils/authCache';
import { isBackendUnavailableError } from '@/core/backendUnavailable';
import {
  decideAuthStatus,
  toAuthStatusUser,
  type AuthStatus,
} from '@/core/authStatus';
import { logWarn } from '../utils/log';

/**
 * 核一次登录态（联网）。
 *
 * 顺序很重要：**先读本机缓存**（本地，零延迟），
 * 再去核服务端 —— 缓存那份在「核不到」时是**兜底**（见 `decideAuthStatus`）。
 */
export async function readAuthStatus(): Promise<AuthStatus> {
  let cachedUser = null as ReturnType<typeof toAuthStatusUser>;
  try {
    const cached = await authCache.getAuthState();
    if (cached?.isAuthenticated && cached.user) {
      cachedUser = toAuthStatusUser(cached.user);
    }
  } catch (err) {
    // 缓存读不到**不中止**核登录态：缓存只是兜底，核服务端才是主路径。
    logWarn('[authStatus] 读本机缓存登录态失败（不影响核对服务端）:', err);
  }

  try {
    const user = await store.dispatch(getCurrentUser()).unwrap();
    if (!user) {
      // 服务端明确说「没有会话」⇒ 真的没登录。
      // ⚠️ 这一支**必须**清掉缓存那份：用户可能刚刚在别处登出了
      // （否则界面会一直显示「已登录」，而他点了上传只会得到一句「会话已过期」）。
      return decideAuthStatus({ verifiedUser: null, cachedUser: null });
    }
    return decideAuthStatus({ verifiedUser: toAuthStatusUser(user), cachedUser });
  } catch (err) {
    const unavailable = isBackendUnavailableError(err);
    if (unavailable) {
      // 402 那一类：**用户确实登录着**，只是我们确认不了 ⇒ 不许读成「没登录」。
      logWarn('[authStatus] 云端项目不可用，按缓存保留登录态（不说「未登录」）');
    } else {
      logWarn('[authStatus] 核对登录态失败（不知道，不等于没登录）:', err);
    }
    return decideAuthStatus({
      verifiedUser: null,
      cachedUser,
      backendUnavailable: unavailable,
      failureDetail: unavailable ? undefined : err instanceof Error ? err.message : String(err),
    });
  }
}

/** 供 SW 侧日志用的一句话摘要（不面向用户）。 */
export function describeAuthStatus(status: AuthStatus): string {
  switch (status.kind) {
    case 'authenticated':
      return `已登录（${status.user?.email ?? status.user?.id ?? '未知账号'}）`;
    case 'not_authenticated':
      return '未登录';
    case 'backend_unavailable':
      return '云端项目不可用（登录态按缓存保留）';
    default:
      return `登录态未知（${status.detail ?? '无原因'}）`;
  }
}
