/**
 * P0 手术 · 会话 single-source。
 * 原 `upload.ts` 内 migrateToJsonb / uploadTabGroups / uploadSettings 三处
 * 逐字重复的 getSession + getUser + 校验块收口于此。错误文案逐字保留，
 * 行为零变化。调用方只拿回校验过的 userId。
 */
import { supabase } from './client';
import {
  BackendUnavailableError,
  isBackendUnavailable,
  readHttpStatus,
} from '@/core/backendUnavailable';

export async function requireSessionUserId(): Promise<string> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();

  if (sessionError) {
    // ── 2026-10-22（402）：服务端项目被限制时**保留机器判据** ──────────────
    // 这里是「云端不可用」最早暴露的一层（上传/删除广播/列探测都经过它）。
    // 原先 `new Error(...)` 把错误**降级成一条普通 Error**：状态码与
    // 「项目被限制」的标记全丢 ⇒ 上游只能看到一句英文 ⇒ 用户看到
    // 「请重试」，而重试一万次也一样。
    //
    // 归一在**这里**做（而不是在 UI 层）：这一层还拿得到 SDK 的原始错误
    // 形状（`status` / `http_status` / 报文），过了这一层就只剩 message 了。
    //
    // ⚠️ 判据必须喂**原始**错误：包装后的 `new Error(...)` 只剩 message，
    // 状态码（402）就看不见了（报文标记还在 message 里，但状态码没了）。
    const wrapped = new Error(`获取会话失败: ${sessionError.message}`);
    if (isBackendUnavailable(sessionError)) {
      throw new BackendUnavailableError(wrapped.message, readHttpStatus(sessionError) ?? undefined);
    }
    throw wrapped;
  }

  if (!sessionData.session) {
    throw new Error('用户未登录或会话已过期，请重新登录');
  }

  const { data: { user }, error: userError } = await supabase.auth.getUser();

  if (userError) {
    // ── 2026-10-22（402）：**这一支才是账号态 402 的真实落点** ────────────
    // 实测（生产 402）：`/auth/v1/user` 同样返回 402 ⇒ getUser 抛
    // AuthApiError { status: 402 }。而这一支原先把它降级成普通 Error ⇒
    // 上游（syncEngine 的 ensureAuthenticated / backgroundSync 的登录态恢复）
    // 只能看到「获取用户信息失败: <英文原文>」⇒ 用户看到英文或「请重试」。
    //
    // 判据喂**原始**错误（它带 status / http_status），包装后的只剩 message。
    const wrapped = new Error(`获取用户信息失败: ${userError.message}`);
    if (isBackendUnavailable(userError)) {
      throw new BackendUnavailableError(wrapped.message, readHttpStatus(userError) ?? undefined);
    }
    throw wrapped;
  }

  if (!user) {
    throw new Error('用户未登录');
  }

  if (!user.id) {
    throw new Error('用户ID无效');
  }

  if (user.id !== sessionData.session.user.id) {
    user.id = sessionData.session.user.id;
  }

  return user.id;
}
