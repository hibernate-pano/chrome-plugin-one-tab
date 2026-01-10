/**
 * 智能分组服务
 * 
 * 提供智能标签分组建议功能：
 * 1. 基于域名的分组建议
 * 2. 基于标题关键词的分组建议
 * 3. 重复标签检测
 */

import { Tab, TabGroup } from '@/types/tab';
import { logSanitizer } from '@/utils/logSanitizer';

/**
 * 分组建议
 */
export interface GroupSuggestion {
  name: string;
  tabs: Tab[];
  reason: 'domain' | 'keyword' | 'mixed';
  confidence: number; // 0-1 的置信度
}

/**
 * 重复标签信息
 */
export interface DuplicateInfo {
  url: string;
  normalizedUrl: string;
  tabs: Array<{
    tab: Tab;
    groupId: string;
    groupName: string;
  }>;
}

/**
 * 域名分类映射
 */
const DOMAIN_CATEGORIES: Record<string, string> = {
  // 社交媒体
  'twitter.com': '社交媒体',
  'x.com': '社交媒体',
  'facebook.com': '社交媒体',
  'instagram.com': '社交媒体',
  'linkedin.com': '社交媒体',
  'weibo.com': '社交媒体',
  
  // 开发工具
  'github.com': '开发',
  'gitlab.com': '开发',
  'stackoverflow.com': '开发',
  'npmjs.com': '开发',
  'developer.mozilla.org': '开发',
  
  // 视频
  'youtube.com': '视频',
  'bilibili.com': '视频',
  'vimeo.com': '视频',
  'netflix.com': '视频',
  
  // 新闻
  'news.ycombinator.com': '新闻',
  'reddit.com': '新闻',
  'medium.com': '新闻',
  
  // 购物
  'amazon.com': '购物',
  'taobao.com': '购物',
  'jd.com': '购物',
  'ebay.com': '购物',
  
  // 文档
  'docs.google.com': '文档',
  'notion.so': '文档',
  'confluence.com': '文档',
};

/**
 * 常见停用词（中英文）
 */
const STOP_WORDS = new Set([
  // 英文
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
  'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he',
  'she', 'we', 'they', 'what', 'which', 'who', 'whom', 'whose', 'where',
  'when', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more',
  'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
  'same', 'so', 'than', 'too', 'very', 'just', 'also',
  // 中文
  '的', '了', '和', '是', '在', '有', '我', '他', '她', '它', '们',
  '这', '那', '个', '上', '下', '不', '与', '及', '或', '等', '也',
  '就', '都', '而', '及', '着', '把', '被', '让', '给', '向', '从',
]);

class SmartGroupService {
  /**
   * 从 URL 提取域名
   */
  extractDomain(url: string): string {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.replace('www.', '');
    } catch {
      return '';
    }
  }

  /**
   * 规范化 URL（用于重复检测）
   */
  normalizeUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      // 移除协议、www、查询参数、锚点
      let normalized = urlObj.hostname.replace('www.', '') + urlObj.pathname;
      // 移除尾部斜杠
      normalized = normalized.replace(/\/+$/, '');
      return normalized.toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  }

  /**
   * 从标题提取关键词
   */
  extractKeywords(title: string): string[] {
    // 分词（支持中英文）
    const words = title
      .toLowerCase()
      // 移除特殊字符
      .replace(/[^\w\s\u4e00-\u9fa5]/g, ' ')
      // 分割
      .split(/\s+/)
      // 过滤空字符串和停用词
      .filter(word => word.length > 1 && !STOP_WORDS.has(word));

    return [...new Set(words)];
  }

  /**
   * 基于域名生成分组建议
   */
  suggestByDomain(tabs: Tab[]): GroupSuggestion[] {
    const domainGroups = new Map<string, Tab[]>();

    tabs.forEach(tab => {
      const domain = this.extractDomain(tab.url);
      if (!domain) return;

      // 检查是否有预定义分类
      const category = DOMAIN_CATEGORIES[domain];
      const groupKey = category || domain;

      if (!domainGroups.has(groupKey)) {
        domainGroups.set(groupKey, []);
      }
      domainGroups.get(groupKey)!.push(tab);
    });

    const suggestions: GroupSuggestion[] = [];

    domainGroups.forEach((groupTabs, domain) => {
      // 至少需要 2 个标签才建议分组
      if (groupTabs.length >= 2) {
        suggestions.push({
          name: domain,
          tabs: groupTabs,
          reason: 'domain',
          confidence: Math.min(0.9, 0.5 + groupTabs.length * 0.1),
        });
      }
    });

    return suggestions.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * 基于关键词生成分组建议
   */
  suggestByKeyword(tabs: Tab[]): GroupSuggestion[] {
    const keywordCounts = new Map<string, Tab[]>();

    tabs.forEach(tab => {
      const keywords = this.extractKeywords(tab.title);
      keywords.forEach(keyword => {
        if (!keywordCounts.has(keyword)) {
          keywordCounts.set(keyword, []);
        }
        keywordCounts.get(keyword)!.push(tab);
      });
    });

    const suggestions: GroupSuggestion[] = [];

    keywordCounts.forEach((groupTabs, keyword) => {
      // 至少需要 3 个标签且关键词长度 >= 2
      if (groupTabs.length >= 3 && keyword.length >= 2) {
        suggestions.push({
          name: keyword,
          tabs: groupTabs,
          reason: 'keyword',
          confidence: Math.min(0.8, 0.3 + groupTabs.length * 0.1),
        });
      }
    });

    return suggestions.sort((a, b) => b.confidence - a.confidence).slice(0, 5);
  }

  /**
   * 生成综合分组建议
   */
  generateSuggestions(tabs: Tab[]): GroupSuggestion[] {
    const domainSuggestions = this.suggestByDomain(tabs);
    const keywordSuggestions = this.suggestByKeyword(tabs);

    // 合并建议，去重
    const allSuggestions = [...domainSuggestions];
    const usedTabIds = new Set(domainSuggestions.flatMap(s => s.tabs.map(t => t.id)));

    keywordSuggestions.forEach(suggestion => {
      // 过滤掉已经被域名建议使用的标签
      const uniqueTabs = suggestion.tabs.filter(t => !usedTabIds.has(t.id));
      if (uniqueTabs.length >= 2) {
        allSuggestions.push({
          ...suggestion,
          tabs: uniqueTabs,
        });
      }
    });

    logSanitizer.debug(`[SmartGroup] 生成 ${allSuggestions.length} 个分组建议`);
    return allSuggestions.slice(0, 10);
  }

  /**
   * 检测重复标签
   */
  detectDuplicates(groups: TabGroup[]): DuplicateInfo[] {
    const urlMap = new Map<string, DuplicateInfo>();

    groups.forEach(group => {
      group.tabs.forEach(tab => {
        const normalizedUrl = this.normalizeUrl(tab.url);
        
        if (!urlMap.has(normalizedUrl)) {
          urlMap.set(normalizedUrl, {
            url: tab.url,
            normalizedUrl,
            tabs: [],
          });
        }
        
        urlMap.get(normalizedUrl)!.tabs.push({
          tab,
          groupId: group.id,
          groupName: group.name,
        });
      });
    });

    // 只返回有重复的
    const duplicates = Array.from(urlMap.values()).filter(info => info.tabs.length > 1);
    
    logSanitizer.debug(`[SmartGroup] 检测到 ${duplicates.length} 组重复标签`);
    return duplicates;
  }

  /**
   * 获取重复标签统计
   */
  getDuplicateStats(groups: TabGroup[]): {
    totalDuplicates: number;
    affectedGroups: number;
    duplicateUrls: number;
  } {
    const duplicates = this.detectDuplicates(groups);
    const affectedGroupIds = new Set<string>();
    let totalDuplicates = 0;

    duplicates.forEach(info => {
      totalDuplicates += info.tabs.length - 1; // 减去原始的一个
      info.tabs.forEach(t => affectedGroupIds.add(t.groupId));
    });

    return {
      totalDuplicates,
      affectedGroups: affectedGroupIds.size,
      duplicateUrls: duplicates.length,
    };
  }
}

export const smartGroupService = new SmartGroupService();
export default smartGroupService;
