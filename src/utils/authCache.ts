import { User } from '@/types/tab';
import { secureStorage } from '@/utils/secureStorage';

const AUTH_CACHE_KEY = 'auth_cache';
const CACHE_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

interface AuthCache {
  user: User | null;
  isAuthenticated: boolean;
  timestamp: number;
}

export const authCache = {
  async saveAuthState(user: User | null, isAuthenticated: boolean): Promise<void> {
    try {
      const cacheData: AuthCache = {
        user,
        isAuthenticated,
        timestamp: Date.now(),
      };
      await secureStorage.set(AUTH_CACHE_KEY, cacheData);
    } catch (error) {
      console.error('缓存认证状态失败:', error);
    }
  },

  async getAuthState(): Promise<{ user: User | null; isAuthenticated: boolean } | null> {
    try {
      const cacheData = await secureStorage.get<AuthCache>(AUTH_CACHE_KEY);
      if (!cacheData) return null;

      if (Date.now() - cacheData.timestamp > CACHE_DURATION_MS) {
        await secureStorage.remove(AUTH_CACHE_KEY);
        return null;
      }

      return {
        user: cacheData.user,
        isAuthenticated: cacheData.isAuthenticated,
      };
    } catch (error) {
      console.error('获取认证缓存失败:', error);
      return null;
    }
  },

  async clearAuthState(): Promise<void> {
    try {
      await secureStorage.remove(AUTH_CACHE_KEY);
    } catch (error) {
      console.error('清除认证缓存失败:', error);
    }
  },
};
