import type { TabGroup } from '@/types/tab';

export interface HydrationInput {
  groups: TabGroup[] | null | undefined;
  now: string;
  readFailed?: boolean;
}

export interface HydrationDecision {
  activeGroups: TabGroup[];
  treatAsLoaded: boolean;
  lastLoadedAt: string | null;
  lastSyncStatus: 'local' | null;
  skipPreloadedState: boolean;
}

/**
 * 只有真正读到非空数据时才把本地状态固化为“已加载”。
 * 真空、全部软删、读失败都不能让 TabList 永久跳过 loadGroups。
 */
export function decideTabsHydration(input: HydrationInput): HydrationDecision {
  const raw = Array.isArray(input.groups) ? input.groups : [];
  const activeGroups = raw.filter(g => !g.isDeleted);
  const readFailed = input.readFailed === true;
  const treatAsLoaded = !readFailed && activeGroups.length > 0;

  return {
    activeGroups,
    treatAsLoaded,
    lastLoadedAt: treatAsLoaded ? input.now : null,
    lastSyncStatus: treatAsLoaded ? 'local' : null,
    skipPreloadedState: readFailed,
  };
}

export function buildTabsPreloadedState(
  decision: HydrationDecision
): Pick<
  import('@/types/tab').TabState,
  'groups' | 'lastLoadedAt' | 'lastSyncStatus'
> | null {
  if (!decision.treatAsLoaded || decision.skipPreloadedState) return null;
  return {
    groups: decision.activeGroups,
    lastLoadedAt: decision.lastLoadedAt,
    lastSyncStatus: decision.lastSyncStatus,
  };
}
