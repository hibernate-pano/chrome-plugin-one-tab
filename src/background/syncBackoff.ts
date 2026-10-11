/**
 * 后台轮询同步的**失败退避**（F3）——纯函数 + 持久化策略，与 chrome.* 完全解耦。
 *
 * ── 为什么需要它（缺陷描述）────────────────────────────────────────────────
 * 修复前：backgroundSync 用一个 `periodInMinutes: 1` 的 alarm 驱动整条管线，
 * 失败**没有任何退避、没有 maxRetries**。网络断着、Supabase 500、或设置读失败时，
 * alarm 每 60s 准时重跑一次整条管线（上传 + 全量下载 + 合并 + 写盘），
 * 无限重试地消耗流量与电量，而且这些重试**永远不可能成功**（故障没恢复前）。
 *
 * ── 设计要求（用户已拍板）─────────────────────────────────────────────────
 *   · 指数退避：60s → 120s → 300s 封顶（不做过细的梯度，避免过度设计）；
 *   · **成功必须复位**（连续失败次数与退避状态都要清零，否则一次网络抖动
 *     会把用户永久锁在 5 分钟一轮的慢同步里）；
 *   · **状态必须活过 SW 回收**：MV3 Service Worker 随时会被系统杀掉，任何写在
 *     模块级变量里的计数器在下一次唤醒时就是 0 —— 退避等于没做。
 *     所以状态存在 chrome.storage.local（本文件通过注入的 KV 接口访问），
 *     而**节奏**本身交给 chrome.alarms：alarms 是持久化的、被 SW 回收不影响，
 *     我们只负责在失败后重排 `delayInMinutes`。
 *
 * ── 为什么不用「内存计数器 + setTimeout」────────────────────────────────────
 * setTimeout 在 MV3 SW idle 被杀后必然丢失，MV3 里只有 chrome.alarms 能可靠
 * 表达「N 分钟后再跑」。本模块不碰 chrome.*，由 backgroundSync 注入：
 *   · kv   —— { get(key), set(key, value), remove(key) }（production = chrome.storage.local）
 *   · now  —— 时钟（测试注入假时钟，避免真等）
 *   这样退避逻辑本身可以 node:test 直测，chrome 行为由 backgroundSync 那层薄壳负责。
 */

// ── 参数 ────────────────────────────────────────────────────────────

/** 退避阶梯（分钟）。失败一次走一格，到顶后停在封顶值。 */
export const BACKOFF_LADDER_MINUTES = [1, 2, 5] as const;

/** 正常轮询周期（分钟）——未处于退避时的节奏。 */
export const NORMAL_INTERVAL_MINUTES = 1;

/** 一次故障后最多连续退避多少轮；超过则停下来等用户手动同步 / 下次浏览器启动。
 *  为什么要有上限：无限退避意味着「一次长期故障后同步永远不再自动恢复」，
 *  而用户完全不知情（没有 UI 提示）。停在封顶间隔继续重试（而不是 0 次）
 *  仍能自愈——故障恢复后的下一次 alarm 就会成功并复位。
 */
export const MAX_CONSECUTIVE_FAILURES = 8;

export const BACKOFF_STATE_KEY = 'background_sync_backoff_state';

/** 持久化的退避状态形状。consecutiveFailures=0 表示未处于退避。 */
export interface BackoffState {
  /** 连续失败次数（成功即清零）。 */
  consecutiveFailures: number;
  /** 下次允许同步的最早时间戳（epoch ms）。0/未设 = 不限。 */
  nextAllowedAt: number;
  /** 仅供日志/诊断：最近一次失败原因摘要。 */
  lastFailureReason?: string;
  /** 最近一次记录的时间戳（epoch ms），便于排查「退避卡住」的报告。 */
  updatedAt?: number;
}

export const EMPTY_BACKOFF_STATE: BackoffState = { consecutiveFailures: 0, nextAllowedAt: 0 };

// ── 依赖注入契约 ─────────────────────────────────────────────────────

export interface BackoffKv {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

// ── 纯函数：阶梯与推进 ───────────────────────────────────────────────

/**
 * 连续失败 n 次后应等待的**分钟数**。
 * n=0 → 正常周期；n=1 → 1 分钟；n=2 → 2 分钟；n≥3 → 5 分钟（封顶）。
 */
export function backoffMinutesFor(failures: number): number {
  if (failures <= 0) return NORMAL_INTERVAL_MINUTES;
  const idx = Math.min(failures, BACKOFF_LADDER_MINUTES.length) - 1;
  return BACKOFF_LADDER_MINUTES[Math.max(idx, 0)];
}

/** 是否已连续失败达到上限（达到后不再自动重排 alarm，等下一次手动/启动触发）。 */
export function isBackoffExhausted(failures: number): boolean {
  return failures >= MAX_CONSECUTIVE_FAILURES;
}

/** 下一轮允许执行的时间戳。 */
export function nextAllowedAt(now: number, failures: number): number {
  return now + backoffMinutesFor(failures) * 60_000;
}

// ── 状态机 ──────────────────────────────────────────────────────────

/** 读持久化状态；读失败按「无退避」处理（fail-open：本模块不阻塞同步主流程）。 */
export async function readBackoffState(kv: BackoffKv): Promise<BackoffState> {
  try {
    const raw = await kv.get(BACKOFF_STATE_KEY);
    if (raw && typeof raw === 'object') {
      const o = raw as Partial<BackoffState>;
      const failures = Number(o.consecutiveFailures ?? 0);
      return {
        consecutiveFailures: Number.isFinite(failures) && failures > 0 ? Math.floor(failures) : 0,
        nextAllowedAt: Number.isFinite(Number(o.nextAllowedAt)) ? Number(o.nextAllowedAt) : 0,
        lastFailureReason: typeof o.lastFailureReason === 'string' ? o.lastFailureReason : undefined,
        updatedAt: Number.isFinite(Number(o.updatedAt)) ? Number(o.updatedAt) : undefined,
      };
    }
  } catch {
    // 读不到就当没有退避状态；退避只是省流量，不该反过来阻塞同步。
  }
  return { ...EMPTY_BACKOFF_STATE };
}

async function writeBackoffState(kv: BackoffKv, state: BackoffState): Promise<void> {
  try {
    if (state.consecutiveFailures <= 0) {
      await kv.remove(BACKOFF_STATE_KEY);
      return;
    }
    await kv.set(BACKOFF_STATE_KEY, state);
  } catch {
    // 写失败：退避降级为「下一轮进程内生效」，不抛、不影响同步结果。
    // 下一次成功会 remove，即使这次 remove 失败，最坏也只是多等一轮。
  }
}

/**
 * 成功 → **复位**：清空连续失败次数与 nextAllowedAt，并删掉持久化键。
 * 成功必须复位（拍板要求）：否则一次网络抖动过后，用户的同步会被永久锁在
 * 5 分钟一轮，即使网络早已恢复。
 */
export async function recordSyncSuccess(kv: BackoffKv, now: number): Promise<BackoffState> {
  await writeBackoffState(kv, { consecutiveFailures: 0, nextAllowedAt: 0, updatedAt: now });
  return { ...EMPTY_BACKOFF_STATE };
}

/**
 * 失败 → **推进**：consecutiveFailures +1，并按新次数算出 nextAllowedAt。
 * 返回新的状态，调用方据此重排 alarm（delayInMinutes = backoffMinutesFor(n)）。
 */
export async function recordSyncFailure(
  kv: BackoffKv,
  now: number,
  reason?: string
): Promise<BackoffState> {
  const prev = await readBackoffState(kv);
  const failures = prev.consecutiveFailures + 1;
  const state: BackoffState = {
    consecutiveFailures: failures,
    nextAllowedAt: nextAllowedAt(now, failures),
    lastFailureReason: reason,
    updatedAt: now,
  };
  await writeBackoffState(kv, state);
  return state;
}

/**
 * 当前是否应**跳过**本轮同步（还在退避窗口内）。
 * 判据只看 now vs nextAllowedAt；连续失败次数已超上限时不由这里处理
 * （alarm 根本不会被重排，见 isBackoffExhausted 的调用方）。
 */
export function shouldSkipDueToBackoff(state: BackoffState, now: number): boolean {
  return state.consecutiveFailures > 0 && state.nextAllowedAt > now;
}