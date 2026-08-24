/**
 * TapStack 网页版 API 封装
 *
 * 复用扩展的纯逻辑层（auth + downloadTabGroups），这些模块不依赖 chrome.* API，
 * 因此可直接在浏览器 Web 环境中运行。本文件提供面向页面组件的薄接口。
 */
import { supabase, auth as supabaseAuth, sync as supabaseSync } from '@/utils/supabase';
import type { TabGroup } from '@/types/tab';

export interface WebUser {
  id: string;
  email: string;
}

export class WebAuthError extends Error {}

/** 登录（邮箱 + 密码） */
export async function signIn(email: string, password: string): Promise<WebUser> {
  const { data, error } = await supabaseAuth.signIn(email, password);
  if (error) {
    const message = typeof error === 'object' && error !== null && 'message' in error
      ? (error as { message: string }).message
      : '登录失败';
    throw new WebAuthError(message);
  }
  if (!data.user) {
    throw new WebAuthError('登录失败');
  }
  return { id: data.user.id, email: data.user.email ?? '' };
}

/** 登出 */
export async function signOut(): Promise<void> {
  await supabaseAuth.signOut();
}

/** 获取当前登录用户（无会话返回 null，不抛错） */
export async function getCurrentUser(): Promise<WebUser | null> {
  const result = await supabaseAuth.getCurrentUser();
  if (result.error || !result.data?.user) {
    return null;
  }
  const user = result.data.user as { id: string; email?: string };
  return { id: user.id, email: user.email ?? '' };
}

/** 下载当前用户的会话数据（服务端完整解密后的 TabGroup[]） */
export async function fetchGroups(): Promise<TabGroup[]> {
  const groups = await supabaseSync.downloadTabGroups();
  return Array.isArray(groups) ? groups : [];
}

export { supabase };
