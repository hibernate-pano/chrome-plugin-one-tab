import { Tab, TabGroup } from '@/types/tab';
import { hostMatchesDomainFilter } from '@/core/hostName';
import { hasUnknownSaveTime } from '@/core/sessionSaveTime';

export const SCORE_WEIGHTS = {
  TITLE_EXACT: 100,
  TITLE_PARTIAL: 50,
  URL_EXACT: 80,
  URL_PARTIAL: 30,
  GROUP_NAME_EXACT: 75,
  GROUP_NAME_PARTIAL: 40,
  PINNED_BONUS: 10,
} as const;

export interface SearchOptions {
  query?: string;
  caseSensitive?: boolean;
  exactMatch?: boolean;
  searchUrls?: boolean;
  searchTitles?: boolean;
  searchPinned?: boolean;
  domainFilter?: string;
  groupNameFilter?: string;
  pinnedOnly?: boolean;
  unpinnedOnly?: boolean;
}

export interface MatchDetail {
  field: 'title' | 'url' | 'groupName';
  matchedText: string;
  startIndex: number;
}

export interface SearchResult {
  tab: Tab;
  group: TabGroup;
  score: number;
  matches: MatchDetail[];
}

export interface SessionSearchResult {
  group: TabGroup;
  matches: SearchResult[];
  score: number;
}

export interface SearchFilters {
  domain?: string;
  groupName?: string;
  pinned?: 'all' | 'only' | 'exclude';
  /**
   * 保存时间桶。
   *
   * ⚠️ `'unknown'` = **「时间未知」**（2026-10-25 新增）：来源格式不带时间戳的
   * 导入件（OneTab）**没有保存时间**可填 ⇒ 它不属于「24 小时内 / 7 天内 /
   * 30 天内 / 30 天前」里的任何一个 —— 说它「24 小时内」是假的，说它「30 天前」
   * 同样是假的（我们**不知道**）。⇒ 它只在「时间未知」这个桶里出现，
   * 这样它既不会混进「最近保存的」里，也**不会**被时间筛选静默藏起来。
   */
  savedWithin?: '24h' | '7d' | '30d' | 'older' | 'unknown';
}

const normalizeText = (value: string, caseSensitive: boolean) => {
  return caseSensitive ? value : value.toLowerCase();
};

const buildMatchDetail = (
  field: MatchDetail['field'],
  sourceText: string,
  searchTerm: string,
  exactMatch: boolean,
  caseSensitive: boolean
): MatchDetail => {
  const normalizedSource = normalizeText(sourceText, caseSensitive);
  const startIndex = exactMatch ? 0 : normalizedSource.indexOf(searchTerm);

  return {
    field,
    matchedText: sourceText.substring(startIndex, startIndex + searchTerm.length),
    startIndex,
  };
};

const matchesSavedWithin = (group: TabGroup, savedWithin?: SearchFilters['savedWithin']) => {
  if (!savedWithin) {
    return true;
  }

  // ⚠️ 保存时间**未知**的会话（来源格式不带时间戳的导入件）——
  // 2026-10-25：它不属于任何时间桶。
  //
  // 【为什么不塞进「30 天前」】那是个断言（比 30 天早），而我们**不知道**它多久；
  // 【为什么不塞进「24 小时内」】那更假（导入时刻就是「现在」）——
  // 这正是本条判据要修的那个谎：导入的一批两年前的会话被算成「24 小时内」。
  //
  // ⇒ 只在「时间未知」这个桶里出现：**不混进「最近保存的」，也不被静默藏起来**。
  if (hasUnknownSaveTime(group)) {
    return savedWithin === 'unknown';
  }

  const createdAt = new Date(group.createdAt).getTime();

  if (Number.isNaN(createdAt)) {
    return savedWithin === 'older';
  }

  const ageMs = Date.now() - createdAt;
  const dayMs = 24 * 60 * 60 * 1000;

  switch (savedWithin) {
    case '24h':
      return ageMs <= dayMs;
    case '7d':
      return ageMs <= 7 * dayMs;
    case '30d':
      return ageMs <= 30 * dayMs;
    case 'older':
      return ageMs > 30 * dayMs;
    case 'unknown':
      // 上面已经return了（保存时间未知的会话才会走到这里）——
      // 留这一支是为了 switch 的**穷尽性**：漏掉一个取值 ⇒ TS 报错，
      // 而不是运行时悄悄按「匹配」处理。
      return false;
    default:
      return true;
  }
};

export class AdvancedSearch {
  static search(groups: TabGroup[], options: SearchOptions = {}): SearchResult[] {
    const {
      query = '',
      caseSensitive = false,
      exactMatch = false,
      searchUrls = true,
      searchTitles = true,
      searchPinned = true,
      domainFilter,
      groupNameFilter,
      pinnedOnly = false,
      unpinnedOnly = false,
    } = options;

    if (!query.trim()) {
      return [];
    }

    const searchTerm = normalizeText(query.trim(), caseSensitive);
    const results: SearchResult[] = [];

    groups.forEach(group => {
      const normalizedGroupName = normalizeText(group.name, caseSensitive);
      const groupNameMatchesQuery = exactMatch
        ? normalizedGroupName === searchTerm
        : normalizedGroupName.includes(searchTerm);

      if (groupNameFilter) {
        const normalizedFilter = normalizeText(groupNameFilter, caseSensitive);
        if (!normalizedGroupName.includes(normalizedFilter)) {
          return;
        }
      }

      group.tabs.forEach(tab => {
        if (pinnedOnly && !tab.pinned) {
          return;
        }

        if (unpinnedOnly && tab.pinned) {
          return;
        }

        if (!searchPinned && tab.pinned) {
          return;
        }

        if (domainFilter) {
          try {
            if (!hostMatchesDomainFilter(new URL(tab.url).hostname, domainFilter)) {
              return;
            }
          } catch {
            return;
          }
        }

        const matches: MatchDetail[] = [];
        let score = 0;

        if (searchTitles) {
          const normalizedTitle = normalizeText(tab.title, caseSensitive);
          if (exactMatch ? normalizedTitle === searchTerm : normalizedTitle.includes(searchTerm)) {
            matches.push(buildMatchDetail('title', tab.title, searchTerm, exactMatch, caseSensitive));
            score += exactMatch ? SCORE_WEIGHTS.TITLE_EXACT : SCORE_WEIGHTS.TITLE_PARTIAL;
          }
        }

        if (searchUrls) {
          const normalizedUrl = normalizeText(tab.url, caseSensitive);
          if (exactMatch ? normalizedUrl === searchTerm : normalizedUrl.includes(searchTerm)) {
            matches.push(buildMatchDetail('url', tab.url, searchTerm, exactMatch, caseSensitive));
            score += exactMatch ? SCORE_WEIGHTS.URL_EXACT : SCORE_WEIGHTS.URL_PARTIAL;
          }
        }

        if (groupNameMatchesQuery) {
          matches.push(buildMatchDetail('groupName', group.name, searchTerm, exactMatch, caseSensitive));
          score += exactMatch ? SCORE_WEIGHTS.GROUP_NAME_EXACT : SCORE_WEIGHTS.GROUP_NAME_PARTIAL;
        }

        if (matches.length === 0) {
          return;
        }

        if (tab.pinned) {
          score += SCORE_WEIGHTS.PINNED_BONUS;
        }

        results.push({
          tab,
          group,
          score,
          matches,
        });
      });
    });

    return results.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return new Date(right.group.updatedAt).getTime() - new Date(left.group.updatedAt).getTime();
    });
  }

  static getSuggestions(groups: TabGroup[], input: string, limit = 5): string[] {
    if (!input) {
      return [];
    }

    const suggestions = new Set<string>();
    const normalizedInput = input.toLowerCase();

    groups.forEach(group => {
      if (group.name.toLowerCase().includes(normalizedInput)) {
        suggestions.add(group.name);
      }

      group.tabs.forEach(tab => {
        if (tab.title.toLowerCase().includes(normalizedInput)) {
          suggestions.add(tab.title);
        }

        try {
          const hostname = new URL(tab.url).hostname;
          if (hostname.toLowerCase().includes(normalizedInput)) {
            suggestions.add(hostname);
          }
        } catch {
          // Ignore invalid URLs in suggestion generation.
        }
      });
    });

    return [...suggestions]
      .sort((left, right) => {
        const leftIndex = left.toLowerCase().indexOf(normalizedInput);
        const rightIndex = right.toLowerCase().indexOf(normalizedInput);

        if (leftIndex !== rightIndex) {
          return leftIndex - rightIndex;
        }

        if (left.length !== right.length) {
          return left.length - right.length;
        }

        return left.localeCompare(right);
      })
      .slice(0, limit);
  }

  static getFilterOptions(groups: TabGroup[]) {
    const domains = new Set<string>();
    const groupNames = new Set<string>();

    groups.forEach(group => {
      groupNames.add(group.name);

      group.tabs.forEach(tab => {
        try {
          domains.add(new URL(tab.url).hostname);
        } catch {
          // Ignore invalid URLs in filter options.
        }
      });
    });

    return {
      domains: [...domains].sort(),
      groupNames: [...groupNames].sort(),
    };
  }
}

export const applySearchFilters = (results: SearchResult[], filters: SearchFilters): SearchResult[] => {
  return results.filter(result => {
    if (filters.domain) {
      try {
        if (!hostMatchesDomainFilter(new URL(result.tab.url).hostname, filters.domain)) {
          return false;
        }
      } catch {
        return false;
      }
    }

    if (filters.groupName && !result.group.name.toLowerCase().includes(filters.groupName.toLowerCase())) {
      return false;
    }

    if (filters.pinned === 'only' && !result.tab.pinned) {
      return false;
    }

    if (filters.pinned === 'exclude' && result.tab.pinned) {
      return false;
    }

    return matchesSavedWithin(result.group, filters.savedWithin);
  });
};

export const buildSessionSearchResults = (results: SearchResult[]): SessionSearchResult[] => {
  const groupedResults = new Map<string, SessionSearchResult>();

  results.forEach(result => {
    const existing = groupedResults.get(result.group.id);

    if (existing) {
      existing.matches.push(result);
      existing.score = Math.max(existing.score, result.score);
      return;
    }

    groupedResults.set(result.group.id, {
      group: result.group,
      matches: [result],
      score: result.score,
    });
  });

  return [...groupedResults.values()].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }

    return new Date(right.group.updatedAt).getTime() - new Date(left.group.updatedAt).getTime();
  });
};
