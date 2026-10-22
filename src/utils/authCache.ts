import { User } from '@/types/tab';
import {
  createAccountScopeRecord,
  normalizeAccountScope,
  type AccountScopeRecord,
} from '@/core/accountScope';
import { logError, logInfo, logWarn } from './log';

// 存储键名
const AUTH_CACHE_KEY = 'auth_cache';

/**
 * 本机会话归属记录的键（2026-10-22 审计 DS-1）。
 *
 * 为什么是**独立键**而不是塞进 auth_cache：
 *   · auth_cache 会被退出登录抹掉，而归属记录**必须活过退出登录** ——
 *     「本机这批会话属于谁」是关于数据的事实，不是关于登录态的事实；
 *   · 归属记录要能在**没有登录态**的时候被读到（上传闸门要判断
 *     「当前账号是不是这些会话的主人」）；
 *   · 独立键也让「清除本地数据」（storage.clear，只清 KV 键）不会顺手
 *     把它带走 —— 归属记录与本机会话同生共死。
 *
 * 为什么放 chrome.storage.local 而不是 KV（IndexedDB）：
 *   · 它是**按账号派生**的推导量（与 storage-kv/keys.ts 里
 *     `supabase_sync_watermark_seq:<userId>` 同一类），不进 STORAGE_KEYS
 *     ⇒ 不参与迁移扫描、不参与 storage.clear 的键清单；
 *   · 读写是「一次 get / 一次 set」的量级，不需要 KV 的版本与迁移机制。
 */
const ACCOUNT_SCOPE_KEY = 'local_account_scope';

// 缓存数据结构
interface AuthCache {
  user: User | null;
  isAuthenticated: boolean;
  timestamp: number;
}

/**
 * 读出登录缓存里的账号 id（**不管缓存有没有过期**）。
 *
 * 用途：上传闸门在「本机还没有归属记录」时，用它兜底判断
 * 「这台机器上次登录的是谁」—— 那是本机归属的最好证据。
 * 读失败返回 null（调用方据此中止上传，fail-closed）。
 */
export async function readLastAuthCacheUserId(): Promise<string | null> {
  try {
    const result = await chrome.storage.local.get(AUTH_CACHE_KEY);
    const cacheData = result[AUTH_CACHE_KEY] as AuthCache | undefined;
    return cacheData?.user?.id ?? null;
  } catch (error) {
    logError('读取登录缓存里的账号 id 失败:', error);
    return null;
  }
}

/**
 * 本机会话的归属记录（读写都在 chrome.storage.local）。
 *
 * read() 的三种返回必须分清：
 *   · 记录对象 ⇒ 有归属事实；
 *   · null ⇒ **键不存在**（这台机器还没建立归属记录）；
 *   · 抛错 ⇒ 读失败 / 记录形状损坏 —— 调用方必须 fail-closed，
 *     绝不能把它当成「键不存在」（那是 fail-open，会让跨账号泄露长回来）。
 */
export const accountScopeStore = {
  async read(): Promise<AccountScopeRecord | null> {
    const result = await chrome.storage.local.get(ACCOUNT_SCOPE_KEY);
    const raw = result[ACCOUNT_SCOPE_KEY];
    if (raw === undefined || raw === null) return null;
    return normalizeAccountScope(raw);
  },

  async write(record: AccountScopeRecord): Promise<void> {
    await chrome.storage.local.set({ [ACCOUNT_SCOPE_KEY]: record });
  },

  async clear(): Promise<void> {
    await chrome.storage.local.remove(ACCOUNT_SCOPE_KEY);
  },
};

/**
 * 退出登录前把「本机会话属于谁」记下来（DS-1 的第一环）。
 *
 * 【为什么必须在这里做，而不是登录时再猜】
 * 原来的退出登录只删了 auth_cache ⇒ 「这台机器上最后登录的账号是谁」
 * 这个事实随登录态一起消失 ⇒ 下一次登录时无从判断「换没换账号」，
 * 于是本机残留的旧账号会话会被原样上传到新账号。
 *
 * 【归属记录比登录缓存更精确时，以归属记录为准】
 * 归属记录记着换账号的历史（当前归属账号可能已经换过几轮），
 * 登录缓存只记「最后一次登录的是谁」。两者不一致时以归属记录为准，
 * 免得把已经认过账的会话重新划给上一个账号。
 */
async function captureLocalSessionOwner(): Promise<void> {
  try {
    const lastUserId = await readLastAuthCacheUserId();
    // 从来没登录过 ⇒ 这台机器没有「上一个账号」这个事实 ⇒ 无从记录。
    if (!lastUserId) return;

    const record = await accountScopeStore.read();
    if (record && record.ownerUserId && record.ownerUserId !== lastUserId) {
      logWarn(
        '[authCache] 归属记录与登录缓存的账号不一致（归属=' +
          `${record.ownerUserId} / 缓存=${lastUserId}），以归属记录为准，不覆盖`
      );
      return;
    }
    await accountScopeStore.write({
      ...(record ?? createAccountScopeRecord()),
      ownerUserId: lastUserId,
    });
    logInfo('[authCache] 已记录本机会话的归属账号');
  } catch (error) {
    // 记不住归属 ≠ 不能退出登录：登录态必须清掉，否则用户退不出去。
    // 归属记录缺失的后果是「上传闸门更保守」（见 upload.ts 的账号闸门）。
    logError('记录本机会话归属失败（登录态仍会清除）:', error);
  }
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
      logInfo('认证状态已缓存');
    } catch (error) {
      logError('缓存认证状态失败:', error);
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
        logInfo('认证缓存已过期');
        await this.clearAuthState();
        return null;
      }

      return {
        user: cacheData.user,
        isAuthenticated: cacheData.isAuthenticated
      };
    } catch (error) {
      logError('获取认证缓存失败:', error);
      return null;
    }
  },

  /**
   * 清除认证状态缓存
   *
   * ⚠️ 顺序很重要（2026-10-22 审计 DS-1）：**先**把「本机会话属于哪个账号」
   * 记下来，**再**删 auth_cache。原来只删 auth_cache，于是「这台机器上
   * 最后登录的账号是谁」随登录态一起消失 ⇒ 换账号时无从判断 ⇒ 旧账号
   * 的会话被原样上传到新账号。
   *
   * 删的仍然只有 auth_cache 一个键：**本机会话一个都不能删**（数据不许丢）。
   */
  async clearAuthState(): Promise<void> {
    await captureLocalSessionOwner();
    try {
      await chrome.storage.local.remove(AUTH_CACHE_KEY);
      logInfo('认证缓存已清除');
    } catch (error) {
      logError('清除认证缓存失败:', error);
    }
  }
};
