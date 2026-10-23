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
 * 读登录缓存的**三态**（2026-10-23 第 50 轮）。
 *
 * ⚠️ 「读失败」必须与「没有缓存」分开 —— 详见 `authCache.getAuthState` 的注释。
 */
export type AuthCacheRead =
  /** 读到了：缓存里确实有（或没有）登录态。 */
  | { state: 'known'; user: User | null; isAuthenticated: boolean }
  /** 读到了：键不存在 ⇒ 这台机器从没登录过（**事实**）。 */
  | { state: 'absent' }
  /** **读失败** ⇒ 不可知（**不许**当成「没登录过」）。 */
  | { state: 'unreadable'; detail: string };

/**
 * 读出登录缓存里的账号 id（**不管缓存有没有过期**）。
 *
 * 用途：上传闸门在「本机还没有归属记录」时，用它兜底判断
 * 「这台机器上次登录的是谁」—— 那是本机归属的最好证据。
 *
 * ── 三态，必须分清（2026-10-23 审计 R-5）───────────────────────────────
 *   · 返回 id  —— 读到了，这台机器上次登录的是它；
 *   · 返回 null —— **键不存在**（这台机器从没登录过）；
 *   · **抛错**  —— 读**失败**（存储故障 / 权限 / 配额）。
 *
 * 原来读失败返回 null，与「键不存在」同形 ⇒ 调用方无法区分「这台机器
 * 从没登录过」（真·无主）与「登录缓存读不出来」（**不可知**）⇒ 两者都
 * 落到同一个兜底「认账给当前账号」⇒ **把别的账号的会话写进当前账号的云端**
 * （DS-1 原样复发，且触发概率比「从没登录过」高得多：存储故障常见得多）。
 *
 * 现在读失败**抛错**（fail-closed）：调用方据此中止，不把它当成「没有归属」。
 */
export async function readLastAuthCacheUserId(): Promise<string | null> {
  // 非扩展环境（单测里没装 chrome 桩的、非扩展页面）没有它 ——
  // 那不是「读失败」，是「这个环境压根没有登录缓存可读」。
  if (!hasLocalStorage()) return null;
  const result = await chrome.storage.local.get(AUTH_CACHE_KEY);
  const cacheData = result[AUTH_CACHE_KEY] as AuthCache | undefined;
  return cacheData?.user?.id ?? null;
}

/**
 * chrome.storage.local 是否可用。
 *
 * 非扩展环境（单测里没装 chrome 桩的、非扩展页面）没有它 —— 那不是「读失败」，
 * 而是「这个环境压根没有归属记录可存」：返回「没有记录」而不是抛错。
 * 扩展环境里它恒在（popup 与 SW 都有），所以这个分支只影响测试与未来的
 * 非扩展宿主。
 */
function hasLocalStorage(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);
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
    if (!hasLocalStorage()) return null;
    const result = await chrome.storage.local.get(ACCOUNT_SCOPE_KEY);
    const raw = result[ACCOUNT_SCOPE_KEY];
    if (raw === undefined || raw === null) return null;
    return normalizeAccountScope(raw);
  },

  async write(record: AccountScopeRecord): Promise<void> {
    if (!hasLocalStorage()) return;
    await chrome.storage.local.set({ [ACCOUNT_SCOPE_KEY]: record });
  },

  async clear(): Promise<void> {
    if (!hasLocalStorage()) return;
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
   * 从本地缓存获取认证状态（**三态**，2026-10-23 第 50 轮）。
   *
   * ── 为什么必须分三态（而不是 `| null`）────────────────────────────────
   * 修复前这里读失败**返回 null**，与「这台机器从没登录过」**同形** ⇒
   * 调用方无法区分：
   *   · `known`      —— 读到了：缓存里确实有（或没有）登录态；
   *   · `absent`     —— **读到了**，键不存在 ⇒ 这台机器从没登录过（**事实**）；
   *   · `unreadable` —— **读失败** ⇒ 我们**不知道**（**不可知**）。
   *
   * 而「不可知」被读成「没登录过」，就是第 50 轮修掉的那个谎的另一半：
   * 存储一抖 ⇒ 界面说「你没登录」⇒ 用户去重新输密码。
   * 本仓已有同款纪律：`readLastAuthCacheUserId` 读失败**抛错**（fail-closed），
   * 注释里写明「把别的账号的会话写进当前账号的云端」的后果 —— 同一个道理。
   *
   * @returns 缓存的认证状态（三态，见 `AuthCacheRead`）
   */
  async getAuthState(): Promise<AuthCacheRead> {
    try {
      const result = await chrome.storage.local.get(AUTH_CACHE_KEY);
      const cacheData = result[AUTH_CACHE_KEY] as AuthCache | undefined;

      if (!cacheData) {
        return { state: 'absent' };
      }

      // 检查缓存是否过期（30天）
      const now = Date.now();
      const cacheAge = now - cacheData.timestamp;
      const cacheExpired = cacheAge > 30 * 24 * 60 * 60 * 1000;

      if (cacheExpired) {
        logInfo('认证缓存已过期');
        await this.clearAuthState();
        return { state: 'absent' };
      }

      return {
        state: 'known',
        user: cacheData.user,
        isAuthenticated: cacheData.isAuthenticated,
      };
    } catch (error) {
      // ⚠️ **不许**在这里返回 null / absent —— 那会把「读不出来」说成
      // 「没有登录态」。读失败是**不可知**，必须原样传出去。
      logError('获取认证缓存失败:', error);
      return {
        state: 'unreadable',
        detail: error instanceof Error ? error.message : String(error),
      };
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
