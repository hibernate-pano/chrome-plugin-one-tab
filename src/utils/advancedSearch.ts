/**
 * 高级搜索工具
 * 提供模糊匹配、高亮、历史记录等功能
 */

import { Tab, TabGroup } from '@/types/tab';

export interface SearchOptions {
  caseSensitive?: boolean;
  matchWhole?: boolean;
  useRegex?: boolean;
  searchIn?: ('title' | 'url' | 'group')[];
  maxResults?: number;
}

export interface SearchResult {
  group: TabGroup;
  tab?: Tab;
  matchType: 'title' | 'url' | 'group';
  matchText: string;
  score: number; // 相关度分数
  highlights: Array<{ start: number; end: number }>; // 高亮位置
}

const DEFAULT_OPTIONS: Required<SearchOptions> = {
  caseSensitive: false,
  matchWhole: false,
  useRegex: false,
  searchIn: ['title', 'url', 'group'],
  maxResults: 100,
};

/**
 * 计算字符串相似度（Levenshtein距离）
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * 计算相关度分数（0-100）
 */
function calculateRelevanceScore(query: string, text: string, options: Required<SearchOptions>): number {
  const normalizedQuery = options.caseSensitive ? query : query.toLowerCase();
  const normalizedText = options.caseSensitive ? text : text.toLowerCase();

  // 完全匹配得分最高
  if (normalizedText === normalizedQuery) {
    return 100;
  }

  // 开头匹配得分较高
  if (normalizedText.startsWith(normalizedQuery)) {
    return 90;
  }

  // 包含匹配
  if (normalizedText.includes(normalizedQuery)) {
    // 根据匹配位置计算分数
    const index = normalizedText.indexOf(normalizedQuery);
    const position = index / normalizedText.length;
    return 80 - Math.floor(position * 30); // 50-80分
  }

  // 模糊匹配（使用编辑距离）
  const distance = levenshteinDistance(normalizedQuery, normalizedText);
  const maxLength = Math.max(normalizedQuery.length, normalizedText.length);
  const similarity = 1 - distance / maxLength;

  return Math.floor(similarity * 50); // 0-50分
}

/**
 * 查找所有匹配位置
 */
function findMatchPositions(
  query: string,
  text: string,
  caseSensitive: boolean
): Array<{ start: number; end: number }> {
  const positions: Array<{ start: number; end: number }> = [];
  const searchQuery = caseSensitive ? query : query.toLowerCase();
  const searchText = caseSensitive ? text : text.toLowerCase();

  let startIndex = 0;
  while (true) {
    const index = searchText.indexOf(searchQuery, startIndex);
    if (index === -1) break;

    positions.push({
      start: index,
      end: index + query.length,
    });

    startIndex = index + query.length;
  }

  return positions;
}

/**
 * 执行搜索
 */
export function search(
  query: string,
  groups: TabGroup[],
  options: SearchOptions = {}
): SearchResult[] {
  if (!query || query.trim() === '') {
    return [];
  }

  const opts = { ...DEFAULT_OPTIONS, ...options };
  const results: SearchResult[] = [];

  // 搜索每个标签组
  for (const group of groups) {
    // 搜索组名
    if (opts.searchIn.includes('group')) {
      const score = calculateRelevanceScore(query, group.name, opts);
      if (score > 30) {
        // 阈值：30分
        results.push({
          group,
          matchType: 'group',
          matchText: group.name,
          score,
          highlights: findMatchPositions(query, group.name, opts.caseSensitive),
        });
      }
    }

    // 搜索标签页
    for (const tab of group.tabs) {
      // 搜索标题
      if (opts.searchIn.includes('title')) {
        const score = calculateRelevanceScore(query, tab.title, opts);
        if (score > 30) {
          results.push({
            group,
            tab,
            matchType: 'title',
            matchText: tab.title,
            score,
            highlights: findMatchPositions(query, tab.title, opts.caseSensitive),
          });
        }
      }

      // 搜索URL
      if (opts.searchIn.includes('url')) {
        const score = calculateRelevanceScore(query, tab.url, opts);
        if (score > 30) {
          results.push({
            group,
            tab,
            matchType: 'url',
            matchText: tab.url,
            score,
            highlights: findMatchPositions(query, tab.url, opts.caseSensitive),
          });
        }
      }
    }
  }

  // 按相关度排序并限制结果数量
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.maxResults);
}

/**
 * 高亮匹配文本
 */
export function highlightMatches(
  text: string,
  highlights: Array<{ start: number; end: number }>
): string {
  if (highlights.length === 0) {
    return text;
  }

  let result = '';
  let lastIndex = 0;

  for (const { start, end } of highlights) {
    result += text.substring(lastIndex, start);
    result += `<mark class="search-highlight">${text.substring(start, end)}</mark>`;
    lastIndex = end;
  }

  result += text.substring(lastIndex);
  return result;
}

/**
 * 搜索历史管理
 */
export class SearchHistory {
  private static readonly STORAGE_KEY = 'search_history';
  private static readonly MAX_HISTORY = 20;

  static async getHistory(): Promise<string[]> {
    try {
      const data = await chrome.storage.local.get(this.STORAGE_KEY);
      return Array.isArray(data[this.STORAGE_KEY]) ? data[this.STORAGE_KEY] : [];
    } catch (error) {
      console.error('获取搜索历史失败:', error);
      return [];
    }
  }

  static async addToHistory(query: string): Promise<void> {
    if (!query || query.trim() === '') return;

    try {
      const history = await this.getHistory();

      // 移除重复项
      const filtered = history.filter(item => item !== query);

      // 添加到开头
      const updated = [query, ...filtered].slice(0, this.MAX_HISTORY);

      await chrome.storage.local.set({ [this.STORAGE_KEY]: updated });
    } catch (error) {
      console.error('保存搜索历史失败:', error);
    }
  }

  static async clearHistory(): Promise<void> {
    try {
      await chrome.storage.local.remove(this.STORAGE_KEY);
    } catch (error) {
      console.error('清空搜索历史失败:', error);
    }
  }

  static async removeFromHistory(query: string): Promise<void> {
    try {
      const history = await this.getHistory();
      const filtered = history.filter(item => item !== query);
      await chrome.storage.local.set({ [this.STORAGE_KEY]: filtered });
    } catch (error) {
      console.error('删除搜索历史失败:', error);
    }
  }
}

/**
 * 搜索建议
 */
export function getSuggestions(
  query: string,
  groups: TabGroup[],
  maxSuggestions: number = 5
): string[] {
  if (!query || query.trim() === '') {
    return [];
  }

  const suggestions = new Set<string>();

  for (const group of groups) {
    // 从组名提取建议
    if (group.name.toLowerCase().includes(query.toLowerCase())) {
      suggestions.add(group.name);
    }

    // 从标签页提取建议
    for (const tab of group.tabs) {
      if (tab.title.toLowerCase().includes(query.toLowerCase())) {
        // 提取关键词（简单实现）
        const words = tab.title.split(/\s+/).filter(word => word.length > 3);
        for (const word of words) {
          if (word.toLowerCase().includes(query.toLowerCase())) {
            suggestions.add(word);
          }
        }
      }
    }

    if (suggestions.size >= maxSuggestions) {
      break;
    }
  }

  return Array.from(suggestions).slice(0, maxSuggestions);
}
