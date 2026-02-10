/**
 * 高级搜索和过滤工具
 */

import { Tab, TabGroup } from '@/types/tab';

/**
 * 搜索评分权重配置
 */
export const SCORE_WEIGHTS = {
  /** 标题精确匹配得分 */
  TITLE_EXACT: 100,
  /** 标题部分匹配得分 */
  TITLE_PARTIAL: 50,
  /** URL 精确匹配得分 */
  URL_EXACT: 80,
  /** URL 部分匹配得分 */
  URL_PARTIAL: 30,
  /** 固定标签页额外加分 */
  PINNED_BONUS: 10,
} as const;

/**
 * 搜索选项
 */
export interface SearchOptions {
  /** 搜索查询字符串 */
  query?: string;
  /** 是否区分大小写，默认 false */
  caseSensitive?: boolean;
  /** 是否精确匹配，默认 false */
  exactMatch?: boolean;
  /** 是否搜索 URL，默认 true */
  searchUrls?: boolean;
  /** 是否搜索标题，默认 true */
  searchTitles?: boolean;
  /** 是否搜索固定标签页，默认 true */
  searchPinned?: boolean;
  /** 是否按域名过滤 */
  domainFilter?: string;
  /** 是否按标签组名称过滤 */
  groupNameFilter?: string;
  /** 是否只显示固定标签页 */
  pinnedOnly?: boolean;
  /** 是否只显示非固定标签页 */
  unpinnedOnly?: boolean;
}

/**
 * 搜索结果
 */
export interface SearchResult {
  tab: Tab;
  group: TabGroup;
  /** 匹配的分数，数值越高匹配度越高 */
  score: number;
  /** 匹配的详细信息 */
  matches: MatchDetail[];
}

/**
 * 匹配详情
 */
export interface MatchDetail {
  field: 'title' | 'url' | 'groupName';
  matchedText: string;
  startIndex: number;
}

/**
 * 高级搜索功能
 */
export class AdvancedSearch {
  /**
   * 执行高级搜索
   */
  static search(
    groups: TabGroup[],
    options: SearchOptions = {}
  ): SearchResult[] {
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
      unpinnedOnly = false
    } = options;

    // 防御：空 query 时返回空数组
    // 如果需要返回所有结果，请显式传入 query: '*' 或其他标识
    if (!query || query.trim().length === 0) {
      return [];
    }

    const results: SearchResult[] = [];
    const searchTerm = caseSensitive ? query : query.toLowerCase();

    groups.forEach(group => {
      // 检查标签组名称过滤
      if (groupNameFilter) {
        const groupName = caseSensitive 
          ? group.name 
          : group.name.toLowerCase();
        if (!groupName.includes(caseSensitive ? groupNameFilter : groupNameFilter.toLowerCase())) {
          return; // 跳过不匹配的标签组
        }
      }

      group.tabs.forEach(tab => {
        // 检查固定标签页过滤
        if (pinnedOnly && !tab.pinned) return;
        if (unpinnedOnly && tab.pinned) return;
        if (!searchPinned && tab.pinned) return;

        // 检查域名过滤
        if (domainFilter) {
          try {
            const url = new URL(tab.url);
            const domain = url.hostname.toLowerCase();
            if (!domain.includes(domainFilter.toLowerCase())) {
              return; // 跳过不匹配的域名
            }
          } catch (error) {
            // URL 无效，跳过该标签页
            if (process.env.NODE_ENV === 'development') {
              console.warn(`Invalid URL in tab: ${tab.url}`, error);
            }
            return;
          }
        }

        const matches: MatchDetail[] = [];
        let score = 0;

        // 检查标题匹配
        if (searchTitles) {
          const title = caseSensitive ? tab.title : tab.title.toLowerCase();
          if (exactMatch ? title === searchTerm : title.includes(searchTerm)) {
            const startIndex = exactMatch ? 0 : title.indexOf(searchTerm);
            matches.push({
              field: 'title',
              matchedText: tab.title.substring(startIndex, startIndex + searchTerm.length),
              startIndex
            });
            score += exactMatch ? SCORE_WEIGHTS.TITLE_EXACT : SCORE_WEIGHTS.TITLE_PARTIAL;
          }
        }

        // 检查URL匹配
        if (searchUrls) {
          const url = caseSensitive ? tab.url : tab.url.toLowerCase();
          if (exactMatch ? url === searchTerm : url.includes(searchTerm)) {
            const startIndex = exactMatch ? 0 : url.indexOf(searchTerm);
            matches.push({
              field: 'url',
              matchedText: tab.url.substring(startIndex, startIndex + searchTerm.length),
              startIndex
            });
            score += exactMatch ? SCORE_WEIGHTS.URL_EXACT : SCORE_WEIGHTS.URL_PARTIAL;
          }
        }

        // 如果有任何匹配，添加到结果中
        if (matches.length > 0) {
          // 额外加分因素
          if (tab.pinned) score += SCORE_WEIGHTS.PINNED_BONUS;
          
          results.push({
            tab,
            group,
            score,
            matches
          });
        }
      });
    });

    // 按分数降序排序
    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * 搜索建议 - 根据输入提供可能的搜索词
   */
  static getSuggestions(
    groups: TabGroup[],
    input: string,
    limit: number = 5
  ): string[] {
    if (!input) return [];

    const suggestions = new Set<string>();
    const lowerInput = input.toLowerCase();

    groups.forEach(group => {
      // 检查标签组名称
      if (group.name.toLowerCase().includes(lowerInput)) {
        suggestions.add(group.name);
      }

      group.tabs.forEach(tab => {
        // 检查标题
        if (tab.title.toLowerCase().includes(lowerInput)) {
          suggestions.add(tab.title);
        }

        // 检查URL域名部分
        try {
          const url = new URL(tab.url);
          const hostname = url.hostname;
          if (hostname.toLowerCase().includes(lowerInput)) {
            suggestions.add(hostname);
          }
        } catch (error) {
          // 忽略无效URL
          if (process.env.NODE_ENV === 'development') {
            console.warn(`Invalid URL in tab: ${tab.url}`, error);
          }
        }
      });
    });

    // 返回最相关的建议（按匹配位置、长度排序）
    return Array.from(suggestions)
      .sort((a, b) => {
        const aLower = a.toLowerCase();
        const bLower = b.toLowerCase();
        const aIdx = aLower.indexOf(lowerInput);
        const bIdx = bLower.indexOf(lowerInput);

        // 优先匹配更靠前的
        if (aIdx !== bIdx) return aIdx - bIdx;

        // 其次更短的（更像关键词）
        if (a.length !== b.length) return a.length - b.length;

        // 最后字典序
        return a.localeCompare(b);
      })
      .slice(0, limit);
  }

  /**
   * 获取可用的过滤器选项
   */
  static getFilterOptions(groups: TabGroup[]) {
    const domains = new Set<string>();
    const groupNames = new Set<string>();

    groups.forEach(group => {
      groupNames.add(group.name);

      group.tabs.forEach(tab => {
        try {
          const url = new URL(tab.url);
          domains.add(url.hostname);
        } catch (error) {
          // 忽略无效URL
          if (process.env.NODE_ENV === 'development') {
            console.warn(`Invalid URL in tab: ${tab.url}`, error);
          }
        }
      });
    });

    return {
      domains: Array.from(domains).sort(),
      groupNames: Array.from(groupNames).sort()
    };
  }
}

/**
 * 搜索过滤器组件的类型定义
 */
export interface SearchFilters {
  domain?: string;
  groupName?: string;
  pinned?: 'all' | 'only' | 'exclude';
}

/**
 * 应用搜索过滤器
 */
export const applySearchFilters = (
  results: SearchResult[],
  filters: SearchFilters
): SearchResult[] => {
  return results.filter(result => {
    // 域名过滤
    if (filters.domain) {
      try {
        const url = new URL(result.tab.url);
        if (!url.hostname.toLowerCase().includes(filters.domain.toLowerCase())) {
          return false;
        }
      } catch (error) {
        // 无效URL，过滤掉
        if (process.env.NODE_ENV === 'development') {
          console.warn(`Invalid URL in result: ${result.tab.url}`, error);
        }
        return false;
      }
    }

    // 标签组名称过滤
    if (filters.groupName) {
      if (!result.group.name.toLowerCase().includes(filters.groupName.toLowerCase())) {
        return false;
      }
    }

    // 固定标签页过滤
    if (filters.pinned === 'only' && !result.tab.pinned) {
      return false;
    }
    if (filters.pinned === 'exclude' && result.tab.pinned) {
      return false;
    }

    return true;
  });
};