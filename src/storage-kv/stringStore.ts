/**
 * S2 存储 KV 收敛：字符串级共享存储单源。
 *
 * supabase-js 默认把 session token 存 localStorage，但 MV3 service-worker
 * 没有 localStorage（每次唤醒 memory storage 为空），导致后台轮询无法恢复
 * 登录态。所以在扩展环境统一改用 chrome.storage.local —— popup 与
 * service-worker 共享同一 session。
 *
 * ⚠️ 非扩展环境（网页版仪表盘）必须回退到 localStorage：
 * 网页版（src/web/webApi.ts）复用了 supabase 模块，而它没有 chrome.* API。
 * 早期实现里“无 chrome.storage 就当没有 session”，导致网页版登录请求成功
 * （/auth/v1/token 200）但 session 永远无法持久化 —— 仪表盘随后报“未登录”、
 * 一个 /rest/v1/tab_groups 请求都不会发出。回退到 localStorage 等价于
 * supabase-js 的默认行为，网页版恢复可用。
 *
 * 本模块之前以内联形式活在 src/utils/supabase.ts；S2 下沉为共享单源，
 * supabase client 与后续 KV chrome 迁移层同源引用，行为零变化。
 */
import { hasExtensionStorage, hasWebStorage } from './env';

export interface StringStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const sharedStringStorage: StringStorage = {
  async getItem(key: string): Promise<string | null> {
    if (hasExtensionStorage()) {
      const result = await chrome.storage.local.get(key);
      return (result[key] as string | undefined) ?? null;
    }
    return hasWebStorage() ? localStorage.getItem(key) : null;
  },
  async setItem(key: string, value: string): Promise<void> {
    if (hasExtensionStorage()) {
      await chrome.storage.local.set({ [key]: value });
      return;
    }
    if (hasWebStorage()) localStorage.setItem(key, value);
  },
  async removeItem(key: string): Promise<void> {
    if (hasExtensionStorage()) {
      await chrome.storage.local.remove(key);
      return;
    }
    if (hasWebStorage()) localStorage.removeItem(key);
  },
};
