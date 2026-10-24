import { User } from '@/types/tab';
import {
  createAccountScopeRecord,
  normalizeAccountScope,
  type AccountBindEvidence,
  type AccountScopeRecord,
} from '@/core/accountScope';
import { kvGet, kvRemove, kvSet } from '@/storage-kv/storageAdapter';
import { STORAGE_KEYS } from '@/storage-kv/keys';
import { logError, logInfo, logWarn } from './log';

// 存储键名
const AUTH_CACHE_KEY = 'auth_cache';

/**
 * 升级前归属账本的位置（chrome.storage.local 的独立键）。
 *
 * 2026-10-24 审计 DS-43-20：账本已搬进 KV 层（`STORAGE_KEYS.ACCOUNT_SCOPE`），
 * 这个键名只作为**一次性迁移的来源**保留。搬完就把旧键删掉 ——
 * 留着它有两个后果：
 *   ① 「清除本地数据」只清 KV ⇒ 旧键把账本**复活**（会话已经没了，账本还在）；
 *   ② 两个地方各有一份 ⇒ 迟早分叉，而分叉的方向是「哪份旧用哪份」。
 */
const LEGACY_ACCOUNT_SCOPE_KEY = 'local_account_scope';


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
 * 读**升级前**那份归属账本（chrome.storage.local 的旧键）。
 *
 * 三态与 `readLastAuthCacheUserId` 同纪律：
 *   · 记录对象 ⇒ 有（旧形态的账本）；
 *   · null ⇒ **键不存在**（这台机器从来没有过归属记录）；
 *   · **抛错** ⇒ 读失败 —— 不可知，不许当成「没有」。
 */
async function readLegacyAccountScope(): Promise<unknown | null> {
  if (!hasLocalStorage()) return null;
  const result = await chrome.storage.local.get(LEGACY_ACCOUNT_SCOPE_KEY);
  const raw = result[LEGACY_ACCOUNT_SCOPE_KEY];
  return raw === undefined || raw === null ? null : raw;
}

/**
 * 删掉升级前那份归属账本（搬进 KV 之后，旧键就是过时数据）。
 *
 * 删不掉**不抛错**：KV 里那份才是真相（旧键留着只会让「清除本地数据」
 * 之后账本被复活一次，而那时会话已经没了 ⇒ 无害）。但要留日志，
 * 因为「删不掉」说明 chrome.storage.local 出了别的问题。
 */
async function removeLegacyAccountScope(): Promise<void> {
  if (!hasLocalStorage()) return;
  try {
    await chrome.storage.local.remove(LEGACY_ACCOUNT_SCOPE_KEY);
  } catch (error) {
    logWarn('[authCache] 删不掉升级前的归属记录旧键（KV 里的那份才是真相）:', error);
  }
}

/**
 * 本机会话的归属记录（**落盘在 KV 层**，与本机会话同一个库）。
 *
 * ── 为什么搬进 KV（2026-10-24 审计 DS-43-20）───────────────────────────
 * 它原先在 chrome.storage.local 的独立键里，而会话本体在 KV 层（IndexedDB）
 * ⇒ **两个库各活各的** ⇒ 只要 chrome.storage.local 被整片清掉：
 *   归属账本没了、会话还在 ⇒ 下一次登录走 first-bind ⇒ 本机残留的会话
 *   被**静默认领**给新账号 ⇒ 跨账号泄露（DS-1 的原始后果）。
 * 搬进 KV 后，「会话还在 ⇒ 账本还在」是**结构事实**。
 *
 * ── 一次性迁移（为什么不能靠通用迁移）──────────────────────────────────
 * chrome.storage→KV 的通用迁移**对存量用户早已跑过**（标志位
 * `chromeStorageMigrated` 为真 ⇒ 不会重跑）⇒ 存量用户的旧键不会自动被搬。
 * ⇒ 这里在 read() 里做**显式的一次性补搬**：KV 里没有 ⇒ 读旧键 ⇒ 写 KV
 * ⇒ 删旧键。搬完之后两个地方再无分叉。
 *
 * read() 的三种返回必须分清：
 *   · 记录对象 ⇒ 有归属事实；
 *   · null ⇒ **键不存在**（这台机器还没建立归属记录）；
 *   · 抛错 ⇒ 读失败 / 记录形状损坏 —— 调用方必须 fail-closed，
 *     绝不能把它当成「键不存在」（那是 fail-open，会让跨账号泄露长回来）。
 */
export const accountScopeStore = {
  async read(): Promise<AccountScopeRecord | null> {
    const raw = await kvGet<unknown>(STORAGE_KEYS.ACCOUNT_SCOPE);
    if (raw !== null && raw !== undefined) return normalizeAccountScope(raw);

    // KV 里没有 ⇒ 可能还是升级前的形态（账本在 chrome.storage.local）。
    const legacy = await readLegacyAccountScope();
    if (legacy === null) return null;
    const record = normalizeAccountScope(legacy);
    // 先写 KV，再删旧键：写失败 ⇒ 抛错（旧键还在，下次还能重搬），
    // 删失败 ⇒ 只留一条告警（KV 那份已经是真相）。
    await kvSet(STORAGE_KEYS.ACCOUNT_SCOPE, record);
    await removeLegacyAccountScope();
    logInfo('[authCache] 已把升级前的账号归属记录搬进本地库');
    return record;
  },

  async write(record: AccountScopeRecord): Promise<void> {
    await kvSet(STORAGE_KEYS.ACCOUNT_SCOPE, record);
  },

  async clear(): Promise<void> {
    await kvRemove(STORAGE_KEYS.ACCOUNT_SCOPE);
  },
};

/**
 * 认账判据要用的**外部证据**：「这台机器上次登录的是谁」。
 *
 * ── 为什么认账需要它（2026-10-24 审计 DS-43-20）────────────────────────
 * `decideAccountBind` 的 first-bind 分支（账本里没有归属账号）会把
 * **本机现有会话直接认领给新登录的账号**。若这台机器明明登录过别的账号，
 * 那就不是「第一次绑定」，而是「归属记录丢了」—— 两者必须分开，
 * 否则一次存储事故就足以把别人的会话写进新账号的云端。
 *
 * 判据就是**登录缓存里最后一个账号 id**（`readLastAuthCacheUserId`）：
 *   · 有它且不是新账号 ⇒ 这台机器上有别的账号的会话 ⇒ 走「换账号」口径
 *     （旧会话认账给上一个账号 + 明确告诉用户），**不许**静默认领；
 *   · 有它且就是新账号 ⇒ 这些会话本来就是它的（账本丢了而已）⇒ 认领无妨；
 *   · 没有它 ⇒ 这台机器**从没有过被记下的账号** ⇒ 第一次绑定，认领。
 *
 * ⚠️ 读**失败**时这里会抛错（不吞成「没有证据」）—— 与本仓其它读路径
 * 同一纪律：不可知 ≠ 不知。抛错 ⇒ 认账整条失败 ⇒ 归属记录保持原样
 * ⇒ 上传闸门更保守（方向是安全的）。
 */
export async function readAccountBindEvidence(): Promise<AccountBindEvidence> {
  return { lastKnownUserId: await readLastAuthCacheUserId() };
}

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
