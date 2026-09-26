/**
 * P0 手术 · 会话 single-source。
 * 原 `upload.ts` 内 migrateToJsonb / uploadTabGroups / uploadSettings 三处
 * 逐字重复的 getSession + getUser + 校验块收口于此。错误文案逐字保留，
 * 行为零变化。调用方只拿回校验过的 userId。
 */
import { supabase } from './client';

export async function requireSessionUserId(): Promise<string> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();

  if (sessionError) {
    throw new Error(`获取会话失败: ${sessionError.message}`);
  }

  if (!sessionData.session) {
    throw new Error('用户未登录或会话已过期，请重新登录');
  }

  const { data: { user }, error: userError } = await supabase.auth.getUser();

  if (userError) {
    throw new Error(`获取用户信息失败: ${userError.message}`);
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
