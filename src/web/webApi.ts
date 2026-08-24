/**
 * TapStack 网页版 API 封装
 *
 * 复用扩展的纯逻辑层（auth + downloadTabGroups），这些模块不依赖 chrome.* API，
 * 因此可直接在浏览器 Web 环境中运行。本文件提供面向页面组件的薄接口。
 */
import { supabase, auth as supabaseAuth } from '@/utils/supabase';
import { decryptData } from '@/utils/encryptionUtils';
import type { Tab, TabData, TabGroup } from '@/types/tab';

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

function mapTabDataToTab(tab: TabData, groupId: string): Tab {
  return {
    id: tab.id,
    url: tab.url,
    title: tab.title,
    favicon: tab.favicon,
    createdAt: tab.created_at,
    lastAccessed: tab.last_accessed,
    group_id: groupId,
    pinned: tab.pinned ?? false,
  };
}

/** 下载当前用户的会话数据（覆盖扩展逻辑，但加密结果做数组防护，避免解密出非数组导致崩溃） */
export async function fetchGroups(): Promise<TabGroup[]> {
  const current = await getCurrentUser();
  if (!current) {
    throw new WebAuthError('未登录');
  }
  const userId = current.id;
  const { data: rows, error } = await supabase
    .from('tab_groups')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  const tabGroups: TabGroup[] = [];

  for (const row of rows ?? []) {
    const groupAny = row as any;
    let rawTabs: TabData[] = [];

    if (typeof groupAny.tabs_data === 'string') {
      try {
        const decrypted = await decryptData<TabData[]>(groupAny.tabs_data, userId);
        if (Array.isArray(decrypted)) {
          rawTabs = decrypted;
        } else {
          console.warn(`标签组 ${groupAny.id} 解密结果不是数组，已忽略`);
        }
      } catch (decryptError) {
        console.warn(`解密标签组 ${groupAny.id} 失败，尝试解析明文:`, decryptError);
        try {
          const parsed = JSON.parse(groupAny.tabs_data);
          if (Array.isArray(parsed)) {
            rawTabs = parsed;
          }
        } catch {
          // 忽略，保持空数组
        }
      }
    } else if (Array.isArray(groupAny.tabs_data)) {
      rawTabs = groupAny.tabs_data as TabData[];
    }

    const groupId = String(groupAny.id);
    tabGroups.push({
      id: groupId,
      name: String(groupAny.name ?? '未命名会话'),
      tabs: rawTabs.map((tab) => mapTabDataToTab(tab, groupId)),
      createdAt: String(groupAny.created_at ?? ''),
      updatedAt: String(groupAny.updated_at ?? ''),
      isLocked: Boolean(groupAny.is_locked),
    });
  }

  return tabGroups;
}

export { supabase };
