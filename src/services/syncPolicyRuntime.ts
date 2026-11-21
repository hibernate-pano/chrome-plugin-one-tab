/**
 * 同步策略的 IO 层（2026-11-21）。
 *
 * ── 分层 ──────────────────────────────────────────────────────────────────
 * · `src/core/syncPolicy.ts` = **判据**（纯函数：策略形状、合并、各项裁决）。
 * · 本文件 = **IO**（把远端 JSON 取回来、缓存到本地、按 TTL 决定要不要刷新）。
 *
 * 为什么策略要放在**远端**而不是编译进包里：
 *  · 出网配额是**项目级**共享的 ⇒ 出问题时的止血必须**不发版**就能做；
 *  · 而「配��」这件事本身必须在一个**不消耗 Supabase 配额**的地方 ——
 *    项目被封禁时 `/rest/v1/*` 与 `/auth/v1/health` 一律 402 ⇒ 策略也得从别处取。
 *    这里取自 Vercel 上的静态 JSON（与商店隐私政策同一个站，见
 *    `scripts/build-legal-site.mjs`）。
 *
 * ── 失效语义（每一条都指向「别把同步弄坏」）────────────────────────────────
 *  · 取不到远端 ⇒ 用**上一次缓存**（再没有 ⇒ 用默认策略）。
 *    绝不用「取不到 = 停同步」——那会把一次网络抖动变成静默停摆。
 *  · 缓存超过 TTL 才刷新；刷新失败**不**清缓存。
 *  · 合并非法字段逐项退回默认（见 core/syncPolicy.ts 的 mergeSyncPolicy）。
 */
import {
  DEFAULT_SYNC_POLICY,
  mergeSyncPolicy,
  type SyncPolicy,
} from '@/core/syncPolicy';
import { kvGet, kvSet } from '@/storage-kv/storageAdapter';
import { STORAGE_KEYS } from '@/storage-kv/keys';
import { logInfo, logWarn } from '@/utils/log';

/**
 * 远端策略 JSON 的地址。
 *
 * ⚠️ 它必须**不经过 Supabase**：项目被封禁时策略也得拿得到（那正是最需要
 * 调整策略的时刻）。
 */
export const SYNC_POLICY_URL = 'https://tapstack-two.vercel.app/sync-policy.json';

/** 缓存有效期：6 小时。远端策略是「慢变量」，不需要更勤。 */
export const SYNC_POLICY_TTL_MS = 6 * 60 * 60 * 1000;

/** 拉策略的超时：5 秒。拉不到就用缓存 ⇒ 不该让用户等。 */
export const SYNC_POLICY_FETCH_TIMEOUT_MS = 5_000;

/** 缓存在本地的那一份。 */
export interface CachedSyncPolicy {
  policy: SyncPolicy;
  /** 上次成功取到的时刻（毫秒）。 */
  fetchedAt: number;
}

/** IO 依赖（可注入 ⇒ 测试能真的走这条路径，而不是断言源码长相）。 */
export interface SyncPolicyDeps {
  /** 取远端 JSON（解析后的对象）；失败必须抛错。 */
  fetchPolicy: () => Promise<unknown>;
  /** 读本地缓存；没有 ⇒ null。 */
  readCache: () => Promise<CachedSyncPolicy | null>;
  /** 写本地缓存。 */
  writeCache: (cached: CachedSyncPolicy) => Promise<void>;
  /** 当前时刻（毫秒），可注入以便测试。 */
  now: () => number;
  /**
   * 允许联网刷新吗？
   *
   * 默认实现判「是不是真的扩展环境」（chrome.runtime.id 存在）——
   * node 也有 fetch，于是单测里会真的去拉远端：测试变成联网的
   * （慢、 flaky，还会在断网时把失败误判成产品缺陷）。
   * 注入依赖时由测试自己决定。
   */
  canReachNetwork?: () => boolean;
}

/**
 * 默认依赖：真 fetch + 真 KV。
 *
 * ⚠️ fetch 必须带超时与 `cache: 'no-store'`：
 *  · 超时：不带超时的 fetch 在弱网下能挂到分钟级，而它在**后台轮询的关键路径**上；
 *  · no-store：CDN 缓存的旧策略会让「我改了配置怎么没生效」变成又一件极难自查的事。
 */
const defaultDeps: SyncPolicyDeps = {
  fetchPolicy: async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SYNC_POLICY_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(SYNC_POLICY_URL, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`远端策略 HTTP ${res.status}`);
      return (await res.json()) as unknown;
    } finally {
      clearTimeout(timer);
    }
  },
  readCache: async () => {
    const raw = await kvGet<unknown>(STORAGE_KEYS.SYNC_POLICY_CACHE);
    if (!raw || typeof raw !== 'object') return null;
    const c = raw as Partial<CachedSyncPolicy>;
    if (typeof c.fetchedAt !== 'number') return null;
    const policy = mergeSyncPolicy(c.policy);
    return { policy, fetchedAt: c.fetchedAt };
  },
  writeCache: async (cached: CachedSyncPolicy) => {
    await kvSet(STORAGE_KEYS.SYNC_POLICY_CACHE, cached);
  },
  now: () => Date.now(),
};

/**
 * 能不能联网刷新策略。
 *
 * ⚠️ 判据是「**是不是真的扩展环境**」（`chrome.runtime.id` 存在），
 * 而不是「fetch 存不存在」—— node 也有 fetch，于是单测里会真的去拉远端：
 * 测试变成联网的（慢、 flaky、还会在断网时把失败误判成产品缺陷）。
 * ⇒ 测试环境只读缓存、绝不联网；真实扩展里 chrome.runtime.id 恒存在。
 */
const canReachNetwork = (): boolean => {
  try {
    return typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
  } catch {
    return false;
  }
};

/** 读策略时的可选参数。 */
export interface ReadPolicyOptions {
  /** true = 同步等一次远端刷新（不阻塞的默认路径不这么做）。 */
  forceRefresh?: boolean;
}

/**
 * 造一个策略服务。
 *
 * 抽成工厂是为了让测试能**真的调用这条路径**（注入假的 fetch / KV），
 * 而不是去断言源码里「出现了某段代码」——那种守卫零检测力。
 *
 * ⚠️ 这里用**箭头函数属性**而不是对象方法简写（`readPolicy() {}`）：
 * node 的 `--experimental-strip-types`（本仓测试的加载方式）在「对象字面量里的
 * 方法简写 + 可选参数」这个组合上会把 `?` 留在输出里 ⇒ 整个模块解析失败。
 */
export const createSyncPolicyService = (deps: SyncPolicyDeps = defaultDeps) => ({
  /**
   * 读一份**当前生效**的策略。
   *
   * 流程：缓存新鲜 ⇒ 直接用；否则**后台**刷新（不阻塞本轮）⇒ 本轮仍用旧缓存
   * （再没有 ⇒ 默认）。
   *
   * ⚠️ 为什么刷新**不阻塞**：策略读发生在同步的关键路径上，而远端拉取最坏要
   * 5 秒（超时）⇒ 让每一轮同步都去等一次网络，是拿同步时延换一份「慢变量」。
   * 任何一步都不抛错：策略读不到**不该**让同步停摆。
   */
  readPolicy: async (options?: ReadPolicyOptions): Promise<SyncPolicy> => {
    let cached: CachedSyncPolicy | null = null;
    try {
      cached = await deps.readCache();
    } catch (err) {
      logWarn('[SyncPolicy] 读不到本地策略缓存，本轮按默认策略走:', err);
    }
    const now = deps.now();
    const fresh = cached != null && now - cached.fetchedAt < SYNC_POLICY_TTL_MS;
    if (fresh && !options?.forceRefresh) {
      return cached!.policy;
    }
    const refresh = async (): Promise<void> => {
      try {
        const remote = await deps.fetchPolicy();
        const policy = mergeSyncPolicy(remote);
        try {
          await deps.writeCache({ policy, fetchedAt: deps.now() });
        } catch (err) {
          // 缓存写失败**不影响**策略本身（下一轮刷新会再试），
          // 但要出声：否则「策略改了却不生效」又变成查不出来的事故。
          logWarn('[SyncPolicy] 策略缓存写失败:', err);
        }
        logInfo(
          `[SyncPolicy] 已更新远端策略（revision=${policy.revision}，` +
            `自动同步=${policy.autoSyncEnabled ? '开' : '关'}，` +
            `空闲档=${policy.idleIntervalMinutes} 分钟，预览=${policy.previewEnabled ? '开' : '关'}）`,
        );
      } catch (err) {
        if (cached) {
          logWarn(
            `[SyncPolicy] 取不到远端策略，沿用上一次缓存（revision=${cached.policy.revision}）:`,
            err,
          );
        } else {
          logWarn('[SyncPolicy] 取不到远端策略且无缓存，本轮按默认策略走:', err);
        }
      }
    };
    if (options?.forceRefresh) {
      await refresh();
      // 刷完再读一次缓存（刷新成功时它是新的；失败时还是旧的）。
      try {
        const after = await deps.readCache();
        if (after) return after.policy;
      } catch {
        /* 读失败就沿用下面那份 */
      }
      return cached ? cached.policy : { ...DEFAULT_SYNC_POLICY };
    }
    // 非强制刷新：**不阻塞**本轮。刷新在后台跑（失败也不影响本轮）。
    // ⚠️ 非扩展环境（单测）默认不联网 —— 见 canReachNetwork 的理由。
    const canNetwork = deps.canReachNetwork ?? canReachNetwork;
    if (canNetwork()) {
      void refresh();
    }
    return cached ? cached.policy : { ...DEFAULT_SYNC_POLICY };
  },
});

/** 生产用的策略服务（真 fetch + 真 KV）。 */
export const syncPolicyService = createSyncPolicyService();

/** 便捷入口：读当前生效的策略。 */
export const readEffectiveSyncPolicy = async (options?: {
  forceRefresh?: boolean;
}): Promise<SyncPolicy> => syncPolicyService.readPolicy(options);

// ── 设备本地状态（空闲轮数 / 上次全量下载时刻）────────────────────────────
//
// 这两样**不是**远端策略，是「这台设备的事实」：
//   · 空闲轮数：连续多少轮探活判「无变更」；
//   · 上次全量下载时刻：指纹失败时的全量回退冷却基准。
// 放在 KV（IndexedDB）而不是 chrome.storage：换设备/换账号时它们会自然重置，
// 而 chrome.storage.local 是跨账号共享的（见 storage-kv/keys.ts 里
// ACCOUNT_SCOPE 那段关于「两个库各活各的」的论证）。

/** 读空闲轮数（读不到 ⇒ 0）。 */
export const getIdleRounds = async (): Promise<number> => {
  try {
    const raw = await kvGet<unknown>(STORAGE_KEYS.SYNC_IDLE_ROUNDS);
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
  } catch {
    return 0;
  }
};

/** 写空闲轮数（写失败不影响同步，只影响省流量的力度）。 */
export const setIdleRounds = async (rounds: number): Promise<void> => {
  try {
    await kvSet(STORAGE_KEYS.SYNC_IDLE_ROUNDS, Math.max(0, Math.floor(rounds)));
  } catch (err) {
    logWarn('[SyncPolicy] 写空闲轮数失败（不影响同步）:', err);
  }
};

/**
 * 记一轮同步的结果，得出新的空闲轮数。
 *
 * 有变更 ⇒ 归零（热档）；无变更 ⇒ +1（往空闲档走）。
 */
export const noteSyncRound = async (hadChanges: boolean): Promise<number> => {
  const current = await getIdleRounds();
  const next = hadChanges ? 0 : current + 1;
  await setIdleRounds(next);
  return next;
};

/** 读上次全量下载的时刻（毫秒；null = 从没发生过）。 */
export const getLastFullDownloadAt = async (): Promise<number | null> => {
  try {
    const raw = await kvGet<unknown>(STORAGE_KEYS.LAST_FULL_DOWNLOAD_AT);
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  } catch {
    return null;
  }
};

/** 记「刚刚做过一次全量下载」。 */
export const markFullDownloadDone = async (now: number = Date.now()): Promise<void> => {
  try {
    await kvSet(STORAGE_KEYS.LAST_FULL_DOWNLOAD_AT, now);
  } catch (err) {
    logWarn('[SyncPolicy] 写全量下载时刻失败（不影响同步）:', err);
  }
};

// ── 墓碑 TTL 清理的节流 ───────────────────────────────────────────────────

/** 墓碑清理的最小间隔：24 小时。TTL 本来就是 30 天粒度，不需要更勤。 */
export const PURGE_THROTTLE_MS = 24 * 60 * 60 * 1000;

/** 读上次墓碑清理的时刻（毫秒；null = 从没做过）。 */
export const getLastPurgeAt = async (): Promise<number | null> => {
  try {
    const raw = await kvGet<unknown>(STORAGE_KEYS.LAST_PURGE_AT);
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  } catch {
    return null;
  }
};

/** 记「刚刚清理过墓碑」。 */
export const markPurgeDone = async (now: number = Date.now()): Promise<void> => {
  try {
    await kvSet(STORAGE_KEYS.LAST_PURGE_AT, now);
  } catch (err) {
    logWarn('[SyncPolicy] 写墓碑清理时刻失败（不影响同步）:', err);
  }
};
