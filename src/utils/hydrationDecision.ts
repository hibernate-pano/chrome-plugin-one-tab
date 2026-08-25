import type { TabGroup, UserSettings } from '@/types/tab';

/**
 * Popup 首屏 hydration 决策（纯函数，零依赖，可单测）。
 *
 * 背景（刷新后数据丢失的根因）：
 * popup/index.tsx bootstrap() 会在 createRoot 之前读本地数据塞进 preloadedState，
 * 并设置 lastLoadedAt。TabList 看到 lastLoadedAt 非空就**永久跳过 loadGroups**
 * （见 TabList useEffect: `if (lastLoadedAt) return`）。
 *
 * 问题在于 storage.getGroups() 有「不抛异常但返回 []」的路径（解密失败、IndexedDB
 * 冷启动错误被吞、cachedAsyncFn 缓存），一旦把「瞬时空读」当成「已加载」并固化
 * lastLoadedAt，TabList 就不再重试 → 用户看到 EmptyState，但数据其实还在。
 *
 * 决策原则：只有本地**确实读到非空数据**才固化 lastLoadedAt。
 * 读到空不固化，交给 TabList 走正常 loadGroups 路径（带重试）。
 */

export interface HydrationInput {
  /** storage.getGroups() 的原始返回（可能因静默失败而为 []） */
  groups: TabGroup[] | null | undefined;
  /** 当前 ISO 时间戳（由调用方注入，便于测试） */
  now: string;
}

export interface HydrationDecision {
  /** 过滤掉软删后、要注入 preloadedState 的活跃组 */
  activeGroups: TabGroup[];
  /** 是否把本地数据视为「权威的已加载状态」 */
  treatAsLoaded: boolean;
  /** treatAsLoaded 为 true 时的 lastLoadedAt，否则 null */
  lastLoadedAt: string | null;
  /** treatAsLoaded 为 true 时为 'local'，否则 null */
  lastSyncStatus: 'local' | null;
}

/**
 * 根据本地读到的 groups 决定如何 hydrate。
 * 关键不变量：groups 读到空时 treatAsLoaded=false，lastLoadedAt=null。
 */
export function decideTabsHydration(input: HydrationInput): HydrationDecision {
  const raw = Array.isArray(input.groups) ? input.groups : [];
  const activeGroups = raw.filter(g => !g.isDeleted);
  const treatAsLoaded = activeGroups.length > 0;

  return {
    activeGroups,
    treatAsLoaded,
    lastLoadedAt: treatAsLoaded ? input.now : null,
    lastSyncStatus: treatAsLoaded ? 'local' : null,
  };
}

/**
 * 构造 tabs 分片的 preloadedState 局部对象。
 * 调用方须用 `{ ...initialTabState, ...buildTabsPreloadedState(...) }` 合并。
 * 当 treatAsLoaded=false 返回 null——不 hydrate tabs，让 store 用 initialTabState。
 */
export function buildTabsPreloadedState(
  decision: HydrationDecision
): Partial<Pick<import('@/types/tab').TabState, 'groups' | 'lastLoadedAt' | 'lastSyncStatus'>> | null {
  if (!decision.treatAsLoaded) return null;
  return {
    groups: decision.activeGroups,
    lastLoadedAt: decision.lastLoadedAt,
    lastSyncStatus: decision.lastSyncStatus,
  };
}

/** settings hydration 永远安全（getSettings 有 DEFAULT_SETTINGS 兜底） */
export function shouldHydrateSettings(settings: UserSettings | null | undefined): boolean {
  return settings != null && typeof settings === 'object';
}
