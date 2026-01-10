/**
 * 模糊搜索服务
 * 
 * 提供高级搜索功能：
 * 1. 模糊匹配（容错搜索）
 * 2. 拼音搜索支持
 * 3. 搜索结果高亮
 */

import { Tab, TabGroup } from '@/types/tab';
import { logSanitizer } from '@/utils/logSanitizer';

/**
 * 搜索结果
 */
export interface SearchResult {
  tab: Tab;
  group: TabGroup;
  score: number;
  matches: SearchMatch[];
}

/**
 * 匹配信息
 */
export interface SearchMatch {
  field: 'title' | 'url';
  indices: Array<[number, number]>; // 匹配的字符范围
}

/**
 * 搜索选项
 */
export interface SearchOptions {
  threshold?: number; // 模糊匹配阈值 (0-1)，越低越严格
  maxResults?: number;
  searchFields?: Array<'title' | 'url'>;
  enablePinyin?: boolean;
}

const DEFAULT_OPTIONS: Required<SearchOptions> = {
  threshold: 0.4,
  maxResults: 50,
  searchFields: ['title', 'url'],
  enablePinyin: true,
};

/**
 * 简单的拼音首字母映射（常用字）
 */
const PINYIN_MAP: Record<string, string> = {
  // 这里只放一些常用字的首字母，完整实现需要引入 pinyin 库
  '标': 'b', '签': 'q', '页': 'y', '组': 'z', '搜': 's', '索': 's',
  '删': 's', '除': 'c', '移': 'y', '动': 'd', '导': 'd', '出': 'c',
  '入': 'r', '新': 'x', '建': 'j', '编': 'b', '辑': 'j', '保': 'b',
  '存': 'c', '打': 'd', '开': 'k', '关': 'g', '闭': 'b', '设': 's',
  '置': 'z', '同': 't', '步': 'b', '云': 'y', '端': 'd', '本': 'b',
  '地': 'd', '文': 'w', '件': 'j', '夹': 'j', '收': 's', '藏': 'c',
};

class FuzzySearchService {
  /**
   * 计算两个字符串的编辑距离（Levenshtein Distance）
   */
  private levenshteinDistance(a: string, b: string): number {
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
            matrix[i - 1][j - 1] + 1, // 替换
            matrix[i][j - 1] + 1,     // 插入
            matrix[i - 1][j] + 1      // 删除
          );
        }
      }
    }

    return matrix[b.length][a.length];
  }

  /**
   * 计算模糊匹配分数 (0-1)
   */
  private fuzzyScore(query: string, text: string): number {
    const queryLower = query.toLowerCase();
    const textLower = text.toLowerCase();

    // 完全匹配
    if (textLower === queryLower) return 1;

    // 包含匹配
    if (textLower.includes(queryLower)) {
      // 根据位置和长度比例计算分数
      const position = textLower.indexOf(queryLower);
      const positionScore = 1 - (position / textLower.length) * 0.3;
      const lengthScore = queryLower.length / textLower.length;
      return Math.min(0.95, positionScore * 0.7 + lengthScore * 0.3);
    }

    // 编辑距离匹配
    const distance = this.levenshteinDistance(queryLower, textLower);
    const maxLength = Math.max(queryLower.length, textLower.length);
    const similarity = 1 - distance / maxLength;

    return Math.max(0, similarity);
  }

  /**
   * 获取中文字符的拼音首字母
   */
  private getPinyinInitials(text: string): string {
    return text
      .split('')
      .map(char => PINYIN_MAP[char] || char)
      .join('');
  }

  /**
   * 查找匹配的字符索引
   */
  private findMatchIndices(query: string, text: string): Array<[number, number]> {
    const indices: Array<[number, number]> = [];
    const queryLower = query.toLowerCase();
    const textLower = text.toLowerCase();

    let startIndex = 0;
    let matchIndex: number;

    while ((matchIndex = textLower.indexOf(queryLower, startIndex)) !== -1) {
      indices.push([matchIndex, matchIndex + queryLower.length - 1]);
      startIndex = matchIndex + 1;
    }

    return indices;
  }

  /**
   * 搜索标签
   */
  search(
    groups: TabGroup[],
    query: string,
    options: SearchOptions = {}
  ): SearchResult[] {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const queryLower = query.toLowerCase().trim();

    if (!queryLower) {
      return [];
    }

    const results: SearchResult[] = [];

    groups.forEach(group => {
      group.tabs.forEach(tab => {
        let bestScore = 0;
        const matches: SearchMatch[] = [];

        // 搜索标题
        if (opts.searchFields.includes('title')) {
          const titleScore = this.fuzzyScore(queryLower, tab.title);
          if (titleScore > bestScore) bestScore = titleScore;

          if (titleScore >= opts.threshold) {
            const indices = this.findMatchIndices(queryLower, tab.title);
            if (indices.length > 0) {
              matches.push({ field: 'title', indices });
            }
          }

          // 拼音搜索
          if (opts.enablePinyin) {
            const pinyinTitle = this.getPinyinInitials(tab.title);
            const pinyinScore = this.fuzzyScore(queryLower, pinyinTitle);
            if (pinyinScore > bestScore) bestScore = pinyinScore;
          }
        }

        // 搜索 URL
        if (opts.searchFields.includes('url')) {
          const urlScore = this.fuzzyScore(queryLower, tab.url);
          if (urlScore > bestScore) bestScore = urlScore;

          if (urlScore >= opts.threshold) {
            const indices = this.findMatchIndices(queryLower, tab.url);
            if (indices.length > 0) {
              matches.push({ field: 'url', indices });
            }
          }
        }

        // 如果分数超过阈值，添加到结果
        if (bestScore >= opts.threshold) {
          results.push({
            tab,
            group,
            score: bestScore,
            matches,
          });
        }
      });
    });

    // 按分数排序并限制结果数量
    const sortedResults = results
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.maxResults);

    logSanitizer.debug(
      `[FuzzySearch] 搜索 "${query}" 找到 ${sortedResults.length} 个结果`
    );

    return sortedResults;
  }

  /**
   * 高亮文本中的匹配部分
   */
  highlightMatches(
    text: string,
    indices: Array<[number, number]>,
    highlightClass = 'search-highlight'
  ): string {
    if (indices.length === 0) return text;

    // 按起始位置排序
    const sortedIndices = [...indices].sort((a, b) => a[0] - b[0]);

    let result = '';
    let lastIndex = 0;

    sortedIndices.forEach(([start, end]) => {
      // 添加未匹配部分
      result += text.slice(lastIndex, start);
      // 添加高亮部分
      result += `<span class="${highlightClass}">${text.slice(start, end + 1)}</span>`;
      lastIndex = end + 1;
    });

    // 添加剩余部分
    result += text.slice(lastIndex);

    return result;
  }

  /**
   * 快速搜索（仅返回匹配的标签，不计算详细分数）
   */
  quickSearch(groups: TabGroup[], query: string): Tab[] {
    const queryLower = query.toLowerCase().trim();
    if (!queryLower) return [];

    const results: Tab[] = [];

    groups.forEach(group => {
      group.tabs.forEach(tab => {
        const titleMatch = tab.title.toLowerCase().includes(queryLower);
        const urlMatch = tab.url.toLowerCase().includes(queryLower);

        if (titleMatch || urlMatch) {
          results.push(tab);
        }
      });
    });

    return results;
  }
}

export const fuzzySearchService = new FuzzySearchService();
export default fuzzySearchService;
