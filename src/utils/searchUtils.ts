import { Tab, TabGroup } from '@/types/tab';

export type SearchMode = 'simple' | 'fuzzy' | 'regex';

export interface SearchOptions {
  mode?: SearchMode;
  caseSensitive?: boolean;
  includeUrl?: boolean;
  includeTitle?: boolean;
}

export interface SearchMatch {
  tab: Tab;
  group: TabGroup;
  score: number;
}

export interface SearchSuggestion {
  type: 'keyword' | 'domain' | 'group';
  label: string;
  value: string;
  count: number;
}

const DEFAULT_OPTIONS: SearchOptions = {
  mode: 'simple',
  caseSensitive: false,
  includeUrl: true,
  includeTitle: true,
};

/**
 * 简单搜索 - 包含匹配
 */
function simpleMatch(text: string, query: string, caseSensitive: boolean): boolean {
  if (!caseSensitive) {
    return text.toLowerCase().includes(query.toLowerCase());
  }
  return text.includes(query);
}

/**
 * 模糊搜索 - 使用编辑距离算法
 */
function fuzzyMatch(text: string, query: string, caseSensitive: boolean): number {
  const source = caseSensitive ? text : text.toLowerCase();
  const target = caseSensitive ? query : query.toLowerCase();

  if (source.includes(target)) {
    return 1;
  }

  const len1 = source.length;
  const len2 = target.length;

  if (len2 > len1) return 0;

  const dp: number[][] = Array(len2 + 1)
    .fill(0)
    .map(() => Array(len1 + 1).fill(0));

  for (let i = 0; i <= len2; i++) {
    dp[i][0] = i;
  }

  for (let j = 0; j <= len1; j++) {
    dp[0][j] = j;
  }

  for (let i = 1; i <= len2; i++) {
    for (let j = 1; j <= len1; j++) {
      if (source[j - 1] === target[i - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + 1);
      }
    }
  }

  const maxDistance = Math.floor(len2 * 0.4);
  if (dp[len2][len1] > maxDistance) return 0;

  return 1 - dp[len2][len1] / len2;
}

/**
 * 正则表达式搜索
 */
function regexMatch(text: string, query: string, caseSensitive: boolean): boolean {
  try {
    const flags = caseSensitive ? 'g' : 'gi';
    const regex = new RegExp(query, flags);
    return regex.test(text);
  } catch {
    return false;
  }
}

/**
 * 搜索标签页
 * @param groups 标签组数组
 * @param query 搜索查询
 * @param options 搜索选项
 * @returns 匹配的标签页列表（按分数排序）
 */
export function searchTabs(
  groups: TabGroup[],
  query: string,
  options: SearchOptions = {}
): SearchMatch[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (!query.trim()) {
    return [];
  }

  const matches: SearchMatch[] = [];

  for (const group of groups) {
    for (const tab of group.tabs) {
      let score = 0;
      let matched = false;

      if (opts.includeTitle) {
        const titleScore = matchField(tab.title, query, opts);
        if (titleScore > 0) {
          score += titleScore * 1.5;
          matched = true;
        }
      }

      if (opts.includeUrl) {
        const urlScore = matchField(tab.url, query, opts);
        if (urlScore > 0) {
          score += urlScore;
          matched = true;
        }
      }

      if (matched) {
        matches.push({ tab, group, score });
      }
    }
  }

  return matches.sort((a, b) => b.score - a.score);
}

function matchField(text: string, query: string, options: SearchOptions): number {
  switch (options.mode) {
    case 'fuzzy':
      return fuzzyMatch(text, query, options.caseSensitive || false);
    case 'regex':
      return regexMatch(text, query, options.caseSensitive || false) ? 1 : 0;
    case 'simple':
    default:
      return simpleMatch(text, query, options.caseSensitive || false) ? 1 : 0;
  }
}

/**
 * 提取搜索建议
 * @param groups 标签组数组
 * @param query 当前搜索查询
 * @returns 搜索建议列表
 */
export function getSearchSuggestions(groups: TabGroup[], query: string): SearchSuggestion[] {
  const suggestions: SearchSuggestion[] = [];
  const keywordCounts = new Map<string, number>();
  const domainCounts = new Map<string, number>();

  const queryLower = query.toLowerCase();

  groups.forEach(group => {
    const groupMatch = group.name.toLowerCase().includes(queryLower);
    if (groupMatch && group.tabs.length > 0) {
      suggestions.push({
        type: 'group',
        label: group.name,
        value: group.name,
        count: group.tabs.length,
      });
    }

    group.tabs.forEach(tab => {
      const keywords = extractKeywords(tab.title, tab.url);

      keywords.forEach(keyword => {
        if (keyword.toLowerCase().includes(queryLower) && keyword.length > 2) {
          keywordCounts.set(keyword, (keywordCounts.get(keyword) || 0) + 1);
        }
      });

      const domain = extractDomain(tab.url);
      if (domain && domain.toLowerCase().includes(queryLower)) {
        domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
      }
    });
  });

  keywordCounts.forEach((count, keyword) => {
    if (count >= 2) {
      suggestions.push({
        type: 'keyword',
        label: keyword,
        value: keyword,
        count,
      });
    }
  });

  domainCounts.forEach((count, domain) => {
    if (count >= 2) {
      suggestions.push({
        type: 'domain',
        label: domain,
        value: domain,
        count,
      });
    }
  });

  return suggestions.slice(0, 10);
}

function extractKeywords(title: string, url: string): string[] {
  const keywords: string[] = [];

  const words = title.split(/[\s\-_\.\/]/).filter(word => word.length > 2);

  keywords.push(...words);

  const domain = extractDomain(url);
  if (domain) {
    keywords.push(domain);
  }

  return keywords;
}

function extractDomain(url: string): string | null {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace('www.', '');
  } catch {
    return null;
  }
}

/**
 * 按域名分组搜索结果
 * @param matches 搜索匹配结果
 * @returns 按域名分组的标签页
 */
export function groupMatchesByDomain(matches: SearchMatch[]): Map<string, SearchMatch[]> {
  const grouped = new Map<string, SearchMatch[]>();

  matches.forEach(match => {
    const domain = extractDomain(match.tab.url) || 'other';
    if (!grouped.has(domain)) {
      grouped.set(domain, []);
    }
    grouped.get(domain)!.push(match);
  });

  return grouped;
}
