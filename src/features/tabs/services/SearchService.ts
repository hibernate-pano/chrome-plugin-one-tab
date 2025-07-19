import { TabGroup, Tab } from '@/shared/types/tab';
import { logger } from '@/shared/utils/logger';

/**
 * 搜索模式枚举
 */
export enum SearchMode {
  SIMPLE = 'simple',           // 简单文本搜索
  FUZZY = 'fuzzy',            // 模糊匹配
  REGEX = 'regex',            // 正则表达式
  ADVANCED = 'advanced'       // 高级搜索（组合多种模式）
}

/**
 * 搜索查询接口
 */
export interface SearchQuery {
  keyword: string;
  mode: SearchMode;
  fuzzyThreshold?: number;     // 模糊匹配阈值 (0-1)
  caseSensitive?: boolean;     // 是否区分大小写
  wholeWord?: boolean;         // 是否全词匹配
  filters: {
    groupName?: string;
    domain?: string;
    dateRange?: {
      start: Date;
      end: Date;
    };
    isLocked?: boolean;
    hasIcon?: boolean;         // 是否有图标
    tabCount?: {               // 标签数量范围
      min?: number;
      max?: number;
    };
    tags?: string[];           // 标签过滤
  };
  sortBy: 'relevance' | 'date' | 'name' | 'domain' | 'tabCount';
  sortOrder: 'asc' | 'desc';
}

/**
 * 搜索结果接口
 */
export interface SearchResult {
  groups: TabGroup[];
  tabs: Array<{
    tab: Tab;
    groupId: string;
    groupName: string;
    relevanceScore: number;
  }>;
  totalCount: number;
  searchTime: number;
}

/**
 * 搜索领域服务
 * 负责标签和标签组的搜索、过滤、排序等功能
 * 支持简单搜索、模糊匹配、正则表达式和高级搜索
 */
export class SearchService {

  /**
   * 计算两个字符串的编辑距离（Levenshtein距离）
   * 用于模糊匹配
   */
  private calculateEditDistance(str1: string, str2: string): number {
    const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null));

    for (let i = 0; i <= str1.length; i++) {
      matrix[0][i] = i;
    }

    for (let j = 0; j <= str2.length; j++) {
      matrix[j][0] = j;
    }

    for (let j = 1; j <= str2.length; j++) {
      for (let i = 1; i <= str1.length; i++) {
        const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j][i - 1] + 1,     // deletion
          matrix[j - 1][i] + 1,     // insertion
          matrix[j - 1][i - 1] + indicator // substitution
        );
      }
    }

    return matrix[str2.length][str1.length];
  }

  /**
   * 计算模糊匹配相似度
   */
  private calculateSimilarity(str1: string, str2: string): number {
    const maxLength = Math.max(str1.length, str2.length);
    if (maxLength === 0) return 1;

    const distance = this.calculateEditDistance(str1, str2);
    return (maxLength - distance) / maxLength;
  }

  /**
   * 执行模糊匹配
   */
  private fuzzyMatch(text: string, pattern: string, threshold: number = 0.6): boolean {
    if (!pattern) return true;
    if (!text) return false;

    const similarity = this.calculateSimilarity(text.toLowerCase(), pattern.toLowerCase());
    return similarity >= threshold;
  }

  /**
   * 执行正则表达式匹配
   */
  private regexMatch(text: string, pattern: string, caseSensitive: boolean = false): boolean {
    try {
      const flags = caseSensitive ? 'g' : 'gi';
      const regex = new RegExp(pattern, flags);
      return regex.test(text);
    } catch (error) {
      // 如果正则表达式无效，回退到简单文本匹配
      logger.warn('无效的正则表达式，回退到简单匹配', { pattern, error });
      return this.simpleMatch(text, pattern, caseSensitive);
    }
  }

  /**
   * 执行简单文本匹配
   */
  private simpleMatch(text: string, pattern: string, caseSensitive: boolean = false, wholeWord: boolean = false): boolean {
    if (!pattern) return true;
    if (!text) return false;

    const searchText = caseSensitive ? text : text.toLowerCase();
    const searchPattern = caseSensitive ? pattern : pattern.toLowerCase();

    if (wholeWord) {
      const wordRegex = new RegExp(`\\b${this.escapeRegExp(searchPattern)}\\b`, caseSensitive ? 'g' : 'gi');
      return wordRegex.test(text);
    }

    return searchText.includes(searchPattern);
  }

  /**
   * 转义正则表达式特殊字符
   */
  private escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * 根据搜索模式执行匹配
   */
  private executeMatch(text: string, pattern: string, query: SearchQuery): boolean {
    switch (query.mode) {
      case SearchMode.FUZZY:
        return this.fuzzyMatch(text, pattern, query.fuzzyThreshold || 0.6);
      case SearchMode.REGEX:
        return this.regexMatch(text, pattern, query.caseSensitive || false);
      case SearchMode.SIMPLE:
      default:
        return this.simpleMatch(text, pattern, query.caseSensitive || false, query.wholeWord || false);
    }
  }
  /**
   * 执行搜索
   */
  async search(groups: TabGroup[], query: SearchQuery): Promise<SearchResult> {
    const startTime = performance.now();
    
    try {
      logger.debug('开始搜索', { query });

      // 搜索标签组
      const matchedGroups = this.searchGroups(groups, query);
      
      // 搜索标签
      const matchedTabs = this.searchTabs(groups, query);

      // 排序结果
      const sortedGroups = this.sortGroups(matchedGroups, query);
      const sortedTabs = this.sortTabs(matchedTabs, query);

      const searchTime = performance.now() - startTime;
      
      const result: SearchResult = {
        groups: sortedGroups,
        tabs: sortedTabs,
        totalCount: sortedGroups.length + sortedTabs.length,
        searchTime
      };

      logger.debug('搜索完成', { 
        totalCount: result.totalCount, 
        searchTime: `${searchTime.toFixed(2)}ms` 
      });

      return result;
    } catch (error) {
      logger.error('搜索失败', error);
      throw error;
    }
  }

  /**
   * 快速搜索（仅关键词）
   */
  async quickSearch(groups: TabGroup[], keyword: string): Promise<SearchResult> {
    const query: SearchQuery = {
      keyword: keyword.trim(),
      filters: {},
      sortBy: 'relevance',
      sortOrder: 'desc'
    };

    return this.search(groups, query);
  }

  /**
   * 搜索标签组
   */
  private searchGroups(groups: TabGroup[], query: SearchQuery): TabGroup[] {
    return groups.filter(group => {
      // 关键词匹配
      if (query.keyword) {
        const nameMatch = this.executeMatch(group.name, query.keyword, query);
        const tabsMatch = group.tabs.some(tab =>
          this.executeMatch(tab.title, query.keyword, query) ||
          this.executeMatch(tab.url, query.keyword, query)
        );

        if (!nameMatch && !tabsMatch) {
          return false;
        }
      }

      // 过滤器匹配
      if (query.filters.groupName &&
          !this.executeMatch(group.name, query.filters.groupName, query)) {
        return false;
      }

      if (query.filters.isLocked !== undefined && group.isLocked !== query.filters.isLocked) {
        return false;
      }

      if (query.filters.dateRange) {
        const groupDate = new Date(group.createdAt);
        if (groupDate < query.filters.dateRange.start || groupDate > query.filters.dateRange.end) {
          return false;
        }
      }

      if (query.filters.domain) {
        const hasDomainMatch = group.tabs.some(tab => {
          try {
            const url = new URL(tab.url);
            return this.executeMatch(url.hostname, query.filters.domain!, query);
          } catch {
            return false;
          }
        });

        if (!hasDomainMatch) {
          return false;
        }
      }

      // 标签数量过滤
      if (query.filters.tabCount) {
        const tabCount = group.tabs.length;
        if (query.filters.tabCount.min !== undefined && tabCount < query.filters.tabCount.min) {
          return false;
        }
        if (query.filters.tabCount.max !== undefined && tabCount > query.filters.tabCount.max) {
          return false;
        }
      }

      // 图标过滤
      if (query.filters.hasIcon !== undefined) {
        const hasIcon = group.tabs.some(tab => tab.favIconUrl);
        if (hasIcon !== query.filters.hasIcon) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * 搜索标签
   */
  private searchTabs(groups: TabGroup[], query: SearchQuery): Array<{
    tab: Tab;
    groupId: string;
    groupName: string;
    relevanceScore: number;
  }> {
    const results: Array<{
      tab: Tab;
      groupId: string;
      groupName: string;
      relevanceScore: number;
    }> = [];

    groups.forEach(group => {
      group.tabs.forEach(tab => {
        let relevanceScore = 0;
        let matches = false;

        // 关键词匹配和相关性评分
        if (query.keyword) {
          const titleMatch = this.executeMatch(tab.title, query.keyword, query);
          const urlMatch = this.executeMatch(tab.url, query.keyword, query);

          if (titleMatch) {
            matches = true;
            // 根据匹配模式计算不同的相关性分数
            switch (query.mode) {
              case SearchMode.FUZZY:
                const titleSimilarity = this.calculateSimilarity(tab.title.toLowerCase(), query.keyword.toLowerCase());
                relevanceScore += titleSimilarity * 100;
                break;
              case SearchMode.REGEX:
                relevanceScore += 80; // 正则匹配给予固定高分
                break;
              case SearchMode.SIMPLE:
              default:
                const exactMatch = tab.title.toLowerCase() === query.keyword.toLowerCase();
                relevanceScore += exactMatch ? 100 : 50;
                relevanceScore += (query.keyword.length / tab.title.length) * 20;
                break;
            }
          }

          if (urlMatch) {
            matches = true;
            relevanceScore += 30;
          }
        } else {
          matches = true;
          relevanceScore = 1;
        }

        // 过滤器匹配
        if (matches && query.filters.domain) {
          try {
            const tabUrl = new URL(tab.url);
            if (!this.executeMatch(tabUrl.hostname, query.filters.domain, query)) {
              matches = false;
            }
          } catch {
            matches = false;
          }
        }

        // 图标过滤
        if (matches && query.filters.hasIcon !== undefined) {
          const hasIcon = !!tab.favIconUrl;
          if (hasIcon !== query.filters.hasIcon) {
            matches = false;
          }
        }

        if (matches) {
          results.push({
            tab,
            groupId: group.id,
            groupName: group.name,
            relevanceScore
          });
        }
      });
    });

    return results;
  }

  /**
   * 排序标签组
   */
  private sortGroups(groups: TabGroup[], query: SearchQuery): TabGroup[] {
    return groups.sort((a, b) => {
      let comparison = 0;

      switch (query.sortBy) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'date':
          comparison = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          break;
        case 'relevance':
          // 简单的相关性评分：名称匹配 > 标签数量
          const aScore = this.calculateGroupRelevance(a, query.keyword);
          const bScore = this.calculateGroupRelevance(b, query.keyword);
          comparison = bScore - aScore;
          break;
        default:
          comparison = 0;
      }

      return query.sortOrder === 'desc' ? -comparison : comparison;
    });
  }

  /**
   * 排序标签
   */
  private sortTabs(tabs: Array<{
    tab: Tab;
    groupId: string;
    groupName: string;
    relevanceScore: number;
  }>, query: SearchQuery): Array<{
    tab: Tab;
    groupId: string;
    groupName: string;
    relevanceScore: number;
  }> {
    return tabs.sort((a, b) => {
      let comparison = 0;

      switch (query.sortBy) {
        case 'name':
          comparison = a.tab.title.localeCompare(b.tab.title);
          break;
        case 'domain':
          const aDomain = this.extractDomain(a.tab.url);
          const bDomain = this.extractDomain(b.tab.url);
          comparison = aDomain.localeCompare(bDomain);
          break;
        case 'relevance':
          comparison = b.relevanceScore - a.relevanceScore;
          break;
        default:
          comparison = 0;
      }

      return query.sortOrder === 'desc' ? -comparison : comparison;
    });
  }

  /**
   * 计算标签组相关性评分
   */
  private calculateGroupRelevance(group: TabGroup, keyword: string): number {
    if (!keyword) return 1;

    let score = 0;
    const lowerKeyword = keyword.toLowerCase();

    // 名称匹配
    if (group.name.toLowerCase().includes(lowerKeyword)) {
      score += group.name.toLowerCase() === lowerKeyword ? 100 : 50;
    }

    // 标签匹配
    const matchingTabs = group.tabs.filter(tab => 
      tab.title.toLowerCase().includes(lowerKeyword) || 
      tab.url.toLowerCase().includes(lowerKeyword)
    );
    
    score += matchingTabs.length * 10;

    return score;
  }

  /**
   * 提取域名
   */
  private extractDomain(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }

  /**
   * 获取搜索建议
   */
  async getSearchSuggestions(groups: TabGroup[], keyword: string): Promise<string[]> {
    if (!keyword || keyword.length < 2) {
      return [];
    }

    const suggestions = new Set<string>();
    const lowerKeyword = keyword.toLowerCase();

    // 从标签组名称中提取建议
    groups.forEach(group => {
      if (group.name.toLowerCase().includes(lowerKeyword)) {
        suggestions.add(group.name);
      }

      // 从标签标题中提取建议
      group.tabs.forEach(tab => {
        if (tab.title.toLowerCase().includes(lowerKeyword)) {
          // 提取包含关键词的词语
          const words = tab.title.split(/\s+/);
          words.forEach(word => {
            if (word.toLowerCase().includes(lowerKeyword) && word.length > 2) {
              suggestions.add(word);
            }
          });
        }
      });
    });

    return Array.from(suggestions).slice(0, 10);
  }
}

// 导出单例实例
export const searchService = new SearchService();
