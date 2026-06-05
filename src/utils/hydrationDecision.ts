import type { TabGroup, UserSettings } from '@/types/tab';

/**
 * Popup 首屏 hydration 决策（纯函数，零依赖，可单测）
 *
 * 背景（刷新后数据丢失的根因）：
 * popup/index.tsx 的 bootstrap() 会在 createRoot 之前读本地数据塞进
 * preloadedState，并设置 lastLoadedAt。TabList 看到 lastLoadedAt 非空
 * 就**永久跳过 loadGroups**（见 TabList useEffect: `if (lastLoadedAt) return`）。
 *
 * 问题在于 storage.getGroups() 有多条「不抛异常但返回 []」的路径：
 *   - decryptLocalBlob 解密失败 → 返回 null → getGroups 返回 []
 *   - IndexedDB 冷启动 getItem 出错 → driver 内部 catch 吞掉 → []
 *   - 这个 [] 还会被 cachedAsyncFn 缓存 30s
 *
 * 一旦 bootstrap 把「瞬时空读」当成「已加载」并固化 lastLoadedAt，
 * TabList 就不再重试，用户看到 EmptyState——表现为「刷新后数据丢了」，
 * 但 IndexedDB 里数据其实还在，下次冷读成功又会回来（偶发、与刷新强相关）。
 *
 * 决策原则：
 *   只有当本地**确实读到了非空数据**时，才把它当作「已加载」并固化
 *   lastLoadedAt / lastSyncStatus='local'。读到空时不固化——交给 TabList
 *   走正常的 loadGroups 路径（它带 isLoading 状态，能区分「加载中」与「真的空」，
 *   且在失败时显示可重试的错误态，而不是误导性的 EmptyState）。
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
  /**
   * 是否把本地数据视为「权威的已加载状态」。
   * true  → 固化 lastLoadedAt，首屏直接显示，TabList 跳过 loadGroups
   * false → 不固化，让 TabList 走 loadGroups 重试（避免空读被固化）
   */
  treatAsLoaded: boolean;
  /** treatAsLoaded 为 true 时的 lastLoadedAt，否则 null */
  lastLoadedAt: string | null;
  /** treatAsLoaded 为 true 时为 'local'，否则 null */
  lastSyncStatus: 'local' | null;
}

/**
 * 根据本地读到的 groups 决定如何 hydrate。
 *
 * 关键不变量：groups 读到空（[] / null / 全是软删）时，treatAsLoaded=false，
 * lastLoadedAt=null——这样 TabList 不会永久跳过 loadGroups。
 */
export function decideTabsHydration(input: HydrationInput): HydrationDecision {
  const raw = Array.isArray(input.groups) ? input.groups : [];
  const activeGroups = raw.filter(g => !g.isDeleted);

  // 只有读到至少一个活跃组，才认为本地数据是可信的「已加载」状态。
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
 *
 * 注意：Redux 的 preloadedState 是**整体替换** slice，调用方必须用
 * `{ ...initialTabState, ...buildTabsPreloadedState(...) }` 合并，
 * 否则 isLoading / error / searchQuery / activeGroupId 等会变成 undefined。
 *
 * 当 treatAsLoaded=false（空读）时，返回 null——表示「不要 hydrate tabs」，
 * 让 store 用 initialTabState（lastLoadedAt=null），TabList 正常 loadGroups。
 */
export function buildTabsPreloadedState(
  decision: HydrationDecision
): Pick<
  import('@/types/tab').TabState,
  'groups' | 'lastLoadedAt' | 'lastSyncStatus'
> | null {
  if (!decision.treatAsLoaded) return null;
  return {
    groups: decision.activeGroups,
    lastLoadedAt: decision.lastLoadedAt,
    lastSyncStatus: decision.lastSyncStatus,
  };
}

/** settings hydration 永远安全（getSettings 有 DEFAULT_SETTINGS 兜底，不会"丢"） */
export function shouldHydrateSettings(settings: UserSettings | null | undefined): boolean {
  return settings != null && typeof settings === 'object';
}
