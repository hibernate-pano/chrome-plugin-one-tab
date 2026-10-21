/**
 * 搜索埋点的节流决策（纯函数，可单测）。
 *
 * 问题：SearchResultList 此前把 `filters` 对象直接放进上报 effect 的依赖，
 * 而 filters 每敲一个字符就是一个新对象 → 每敲一个字符发一次 search_performed
 * + search_filtered。事件量随打字速度线性膨胀，统计口径还全是中间态
 * （"gith" / "githu" / "github" 各一条），既没价值又挤掉真正的提交。
 *
 * 策略：leading + trailing 节流。
 * - 首个事件立即发（保证"用户确实搜过"这个事实一定被记录）；
 * - 窗口内的后续变化只更新签名，窗口结束时由调用方的 trailing 定时器补发**最新**一次；
 * - 签名没变就不发（结果集没动却重复上报是无意义的噪声）。
 *
 * 节流窗口默认 2s：覆盖一次连续输入的时长，同时保证用户停下后最终状态一定被记到。
 */
import type { ProductEventName } from '@/utils/productEvents';

export const SEARCH_EVENT_THROTTLE_MS = 2000;

export interface SearchEventSnapshot {
  query: string;
  domain: string | null;
  groupName: string | null;
  pinned: 'all' | 'only' | 'exclude';
  savedWithin: string | null;
  resultCount: number;
}

export type SearchEventName = Extract<ProductEventName, 'search_performed' | 'search_filtered'>;

/** 四个筛选维度里有没有生效的（文本去空格后仍算空，与组件内判空一致）。 */
export function hasActiveSearchFilters(filters: {
  domain?: string | null;
  groupName?: string | null;
  savedWithin?: string | null;
  pinned?: string | null;
}): boolean {
  return (
    !!filters.domain?.trim() ||
    !!filters.groupName?.trim() ||
    !!filters.savedWithin ||
    filters.pinned === 'only' ||
    filters.pinned === 'exclude'
  );
}

/** 签名分隔符：NUL 不可能出现在查询词/筛选值里，拼接因此无歧义。
 *  用 fromCharCode 写而不是字面量，源码里不出现控制字符。 */
const SIGNATURE_SEPARATOR = String.fromCharCode(0);

/** 快照的稳定字符串形式：同内容必然同签名，任意一维变化必然签名变化。 */
export function buildSearchEventSignature(snapshot: SearchEventSnapshot): string {
  return [
    snapshot.query,
    snapshot.domain ?? '',
    snapshot.groupName ?? '',
    snapshot.pinned,
    snapshot.savedWithin ?? '',
    String(snapshot.resultCount),
  ].join(SIGNATURE_SEPARATOR);
}

export interface ShouldEmitArgs {
  lastSignature: string;
  nextSignature: string;
  /** 上次实际发出的时刻（epoch ms）；从未发出过传 0 */
  lastEmitAt: number;
  now: number;
  minIntervalMs?: number;
}

/** 本次变化是否应当**立即**发出。false 时调用方应排一个 trailing 补发。 */
export function shouldEmitSearchEvents({
  lastSignature,
  nextSignature,
  lastEmitAt,
  now,
  minIntervalMs = SEARCH_EVENT_THROTTLE_MS,
}: ShouldEmitArgs): boolean {
  // 签名没变 = 结果集与筛选都没动，重复上报没有信息量
  if (lastSignature !== '' && lastSignature === nextSignature) return false;
  if (lastEmitAt === 0) return true;
  return now - lastEmitAt >= minIntervalMs;
}

/** 距离下一次允许发出还差多少毫秒（0 = 现在就能发）。 */
export function remainingMsUntilAllowed(
  lastEmitAt: number,
  now: number,
  minIntervalMs: number = SEARCH_EVENT_THROTTLE_MS
): number {
  if (lastEmitAt === 0) return 0;
  return Math.max(0, minIntervalMs - (now - lastEmitAt));
}

/**
 * 该快照该发哪些事件。
 *
 * ── 为什么「没有搜索词」时可能一条都不发 ──────────────────────────────────
 *
 * `search_performed` 的含义是「用户搜了某个词」。没有搜索词时用户**没有搜过**
 * —— 他可能只是打开了扩展、翻了一下列表。把这种情况记成 `search_performed`
 * 会让统计口径里出现「搜索次数」凭空多出来的量。
 *
 * ── 为什么「有筛选、没有搜索词」要发 search_filtered ─────────────────────
 *
 * 空搜索词下的筛选浏览**是一个真实的检索行为**（「按域名找那些标签」），
 * 不是「什么都没做」。它的口径就是「筛选」⇒ 记 `search_filtered`，
 * 且**不**记 `search_performed`（两件事不许混成一件）。
 *
 * 判定只看两件事：有没有搜索词、有没有生效的筛选条件。
 */
export function searchEventNames(snapshot: SearchEventSnapshot): SearchEventName[] {
  const names: SearchEventName[] = [];
  if (snapshot.query.trim()) names.push('search_performed');
  if (hasActiveSearchFilters(snapshot)) names.push('search_filtered');
  return names;
}
