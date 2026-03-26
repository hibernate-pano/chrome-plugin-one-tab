import { Tab, TabGroup } from '@/types/tab';

export const SCORE_WEIGHTS = {
  TITLE_EXACT: 100,
  TITLE_PARTIAL: 50,
  URL_EXACT: 80,
  URL_PARTIAL: 30,
  GROUP_NAME_EXACT: 75,
  GROUP_NAME_PARTIAL: 40,
  NOTES_EXACT: 60,
  NOTES_PARTIAL: 30,
  PINNED_BONUS: 10,
} as const;

export interface SearchOptions {
  query?: string;
  caseSensitive?: boolean;
  exactMatch?: boolean;
  searchUrls?: boolean;
  searchTitles?: boolean;
  searchNotes?: boolean;
  searchPinned?: boolean;
  domainFilter?: string;
  groupNameFilter?: string;
  pinnedOnly?: boolean;
  unpinnedOnly?: boolean;
}

export interface MatchDetail {
  field: 'title' | 'url' | 'groupName' | 'notes';
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
  savedWithin?: '24h' | '7d' | '30d' | 'older';
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
      searchNotes = true,
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
      const normalizedNotes = normalizeText(group.notes || '', caseSensitive);
      const groupNameMatchesQuery = exactMatch
        ? normalizedGroupName === searchTerm
        : normalizedGroupName.includes(searchTerm);
      const notesMatchQuery = searchNotes && normalizedNotes
        ? exactMatch
          ? normalizedNotes === searchTerm
          : normalizedNotes.includes(searchTerm)
        : false;

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
            const hostname = new URL(tab.url).hostname.toLowerCase();
            if (!hostname.includes(domainFilter.toLowerCase())) {
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

        if (notesMatchQuery && group.notes) {
          matches.push(buildMatchDetail('notes', group.notes, searchTerm, exactMatch, caseSensitive));
          score += exactMatch ? SCORE_WEIGHTS.NOTES_EXACT : SCORE_WEIGHTS.NOTES_PARTIAL;
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

      if (group.notes?.toLowerCase().includes(normalizedInput)) {
        suggestions.add(group.notes);
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
        const hostname = new URL(result.tab.url).hostname.toLowerCase();
        if (!hostname.includes(filters.domain.toLowerCase())) {
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
