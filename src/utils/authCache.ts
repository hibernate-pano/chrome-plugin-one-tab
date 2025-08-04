import { User } from '@/types/tab';

// 存储键名
const AUTH_CACHE_KEY = 'auth_cache';

// 缓存数据结构
interface AuthCache {
  user: User | null;
  isAuthenticated: boolean;
  timestamp: number;
}

/**
 * 认证状态缓存工具
 * 用于在本地存储中缓存用户登录状态，避免页面刷新时的闪烁
 * 缓存有效期为30天，确保用户不需要频繁登录
 */
export const authCache = {
  /**
   * 保存认证状态到本地缓存
   * @param user 用户信息
   * @param isAuthenticated 是否已认证
   */
  async saveAuthState(user: User | null, isAuthenticated: boolean): Promise<void> {
    try {
      const cacheData: AuthCache = {
        user,
        isAuthenticated,
        timestamp: Date.now()
      };

      await chrome.storage.local.set({ [AUTH_CACHE_KEY]: cacheData });
      console.log('认证状态已缓存');
    } catch (error) {
      console.error('缓存认证状态失败:', error);
    }
  },

  /**
   * 从本地缓存获取认证状态
   * @returns 缓存的认证状态，如果没有缓存则返回null
   */
  async getAuthState(): Promise<{ user: User | null; isAuthenticated: boolean } | null> {
    try {
      const result = await chrome.storage.local.get(AUTH_CACHE_KEY);
      const cacheData = result[AUTH_CACHE_KEY] as AuthCache | undefined;

      if (!cacheData) {
        return null;
      }

      // 检查缓存是否过期（30天）
      const now = Date.now();
      const cacheAge = now - cacheData.timestamp;
      const cacheExpired = cacheAge > 30 * 24 * 60 * 60 * 1000;

      if (cacheExpired) {
        console.log('认证缓存已过期');
        await this.clearAuthState();
        return null;
      }

      return {
        user: cacheData.user,
        isAuthenticated: cacheData.isAuthenticated
      };
    } catch (error) {
      console.error('获取认证缓存失败:', error);
      return null;
    }
  },

  /**
   * 清除认证状态缓存
   */
  async clearAuthState(): Promise<void> {
    try {
      await chrome.storage.local.remove(AUTH_CACHE_KEY);
      console.log('认证缓存已清除');
    } catch (error) {
      console.error('清除认证缓存失败:', error);
    }
  }
};
