/**
 * 智能标签分析和搜索增强服务
 * 提供智能分组建议、增强搜索功能和标签元数据分析
 */

import { Tab } from '@/types/tab';

export interface TabMetadata {
  keywords: string[];
  category: string;
  readingTime?: number;
  importance: number;
  domain: string;
  contentType: string;
}

export interface GroupSuggestion {
  name: string;
  tabs: Tab[];
  confidence: number;
  type: 'domain' | 'topic' | 'time' | 'manual';
  description?: string;
}

export interface SearchResult {
  tab: Tab;
  score: number;
  highlights: SearchHighlight[];
  matchType: 'title' | 'url' | 'content' | 'tag';
}

export interface SearchHighlight {
  field: string;
  text: string;
  positions: { start: number; end: number }[];
}

export class SmartTabAnalyzer {
  private categoryRules: Map<string, string> = new Map();
  private stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by']);

  constructor() {
    this.initializeCategoryRules();
  }

  private initializeCategoryRules() {
    // 基于域名的分类规则
    this.categoryRules.set('github.com', '开发工具');
    this.categoryRules.set('stackoverflow.com', '技术问答');
    this.categoryRules.set('youtube.com', '视频娱乐');
    this.categoryRules.set('medium.com', '技术博客');
    this.categoryRules.set('twitter.com', '社交媒体');
    this.categoryRules.set('linkedin.com', '职业社交');
    this.categoryRules.set('amazon.com', '购物');
    this.categoryRules.set('taobao.com', '购物');
    this.categoryRules.set('jd.com', '购物');
    this.categoryRules.set('zhihu.com', '知识问答');
    this.categoryRules.set('juejin.cn', '技术博客');
    this.categoryRules.set('csdn.net', '技术博客');
    this.categoryRules.set('bilibili.com', '视频娱乐');
    this.categoryRules.set('weibo.com', '社交媒体');
  }

  /**
   * 分析单个标签页的元数据
   */
  async analyzeTab(tab: Tab): Promise<TabMetadata> {
    const url = new URL(tab.url);
    const domain = url.hostname;
    
    const [keywords, category, readingTime, importance] = await Promise.all([
      this.extractKeywords(tab.title, tab.url),
      this.categorizeContent(domain, tab.title),
      this.estimateReadingTime(tab.title, tab.url),
      this.calculateImportance(tab, domain)
    ]);

    return {
      keywords,
      category,
      readingTime,
      importance,
      domain,
      contentType: this.detectContentType(tab.url, tab.title)
    };
  }

  /**
   * 提取关键词
   */
  private async extractKeywords(title: string, url: string): Promise<string[]> {
    const text = `${title} ${url}`.toLowerCase();
    
    // 简单的关键词提取算法
    const words = text
      .replace(/[^\w\s\u4e00-\u9fa5]/g, ' ') // 保留字母、数字、空格和中文
      .split(/\s+/)
      .filter(word => 
        word.length > 2 && 
        !this.stopWords.has(word) &&
        !/^\d+$/.test(word) // 排除纯数字
      );

    // 计算词频
    const wordCount = new Map<string, number>();
    words.forEach(word => {
      wordCount.set(word, (wordCount.get(word) || 0) + 1);
    });

    // 返回出现频率最高的前5个词
    return Array.from(wordCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);
  }

  /**
   * 内容分类
   */
  private async categorizeContent(domain: string, title: string): Promise<string> {
    // 基于域名的分类
    for (const [ruleDomain, category] of this.categoryRules) {
      if (domain.includes(ruleDomain)) {
        return category;
      }
    }

    // 基于标题关键词的分类
    const titleLower = title.toLowerCase();
    
    if (this.matchKeywords(titleLower, ['api', 'documentation', 'docs', 'guide'])) {
      return '技术文档';
    }
    
    if (this.matchKeywords(titleLower, ['tutorial', 'how to', '教程', '如何'])) {
      return '教程指南';
    }
    
    if (this.matchKeywords(titleLower, ['news', '新闻', 'breaking'])) {
      return '新闻资讯';
    }
    
    if (this.matchKeywords(titleLower, ['shopping', 'buy', 'price', '购买', '价格'])) {
      return '购物';
    }

    return '其他';
  }

  private matchKeywords(text: string, keywords: string[]): boolean {
    return keywords.some(keyword => text.includes(keyword));
  }

  /**
   * 估算阅读时间
   */
  private async estimateReadingTime(title: string, url: string): Promise<number> {
    // 基于标题长度和URL类型估算阅读时间（分钟）
    const titleWords = title.split(/\s+/).length;
    let baseTime = Math.max(1, Math.ceil(titleWords / 20)); // 假设每分钟读20个词

    // 根据内容类型调整
    if (url.includes('youtube.com') || url.includes('bilibili.com')) {
      baseTime = 10; // 视频默认10分钟
    } else if (url.includes('github.com')) {
      baseTime = 5; // 代码仓库默认5分钟
    } else if (url.includes('twitter.com') || url.includes('weibo.com')) {
      baseTime = 1; // 社交媒体默认1分钟
    }

    return baseTime;
  }

  /**
   * 计算重要性评分
   */
  private async calculateImportance(tab: Tab, domain: string): Promise<number> {
    let score = 5; // 基础分数

    // 基于访问频率（如果有数据）
    const visitCount = (tab as any).visitCount || 0;
    score += Math.min(visitCount / 10, 3);

    // 基于域名权重
    const domainWeights = new Map([
      ['github.com', 2],
      ['stackoverflow.com', 2],
      ['developer.mozilla.org', 2],
      ['google.com', 1],
      ['youtube.com', -1],
      ['facebook.com', -1],
      ['twitter.com', -1]
    ]);

    const domainWeight = domainWeights.get(domain) || 0;
    score += domainWeight;

    // 基于标题特征
    const title = tab.title.toLowerCase();
    if (title.includes('important') || title.includes('urgent') || title.includes('重要')) {
      score += 2;
    }
    
    if (title.includes('todo') || title.includes('task') || title.includes('待办')) {
      score += 1;
    }

    return Math.max(1, Math.min(10, score));
  }

  /**
   * 检测内容类型
   */
  private detectContentType(url: string, title: string): string {
    if (url.includes('.pdf')) return 'PDF文档';
    if (url.includes('youtube.com') || url.includes('bilibili.com')) return '视频';
    if (url.includes('github.com')) return '代码仓库';
    if (url.includes('medium.com') || url.includes('juejin.cn')) return '技术文章';
    if (title.includes('API') || title.includes('文档')) return '技术文档';
    
    return '网页';
  }

  /**
   * 智能分组建议
   */
  async suggestGroups(tabs: Tab[]): Promise<GroupSuggestion[]> {
    const suggestions: GroupSuggestion[] = [];
    
    // 1. 按域名分组
    const domainGroups = await this.groupByDomain(tabs);
    suggestions.push(...domainGroups);
    
    // 2. 按主题分组
    const topicGroups = await this.groupByTopic(tabs);
    suggestions.push(...topicGroups);
    
    // 3. 按时间分组
    const timeGroups = await this.groupByTime(tabs);
    suggestions.push(...timeGroups);
    
    // 4. 按重要性分组
    const importanceGroups = await this.groupByImportance(tabs);
    suggestions.push(...importanceGroups);

    // 过滤掉置信度过低的建议
    return suggestions.filter(suggestion => suggestion.confidence > 0.6);
  }

  private async groupByDomain(tabs: Tab[]): Promise<GroupSuggestion[]> {
    const domainMap = new Map<string, Tab[]>();
    
    tabs.forEach(tab => {
      try {
        const domain = new URL(tab.url).hostname;
        if (!domainMap.has(domain)) {
          domainMap.set(domain, []);
        }
        domainMap.get(domain)!.push(tab);
      } catch (error) {
        // 忽略无效URL
      }
    });
    
    return Array.from(domainMap.entries())
      .filter(([_, tabList]) => tabList.length >= 2)
      .map(([domain, tabList]) => ({
        name: `${domain} (${tabList.length} 个标签)`,
        tabs: tabList,
        confidence: Math.min(0.9, 0.5 + tabList.length * 0.1),
        type: 'domain' as const,
        description: `来自 ${domain} 的所有标签页`
      }));
  }

  private async groupByTopic(tabs: Tab[]): Promise<GroupSuggestion[]> {
    const topicMap = new Map<string, Tab[]>();
    
    for (const tab of tabs) {
      const metadata = await this.analyzeTab(tab);
      const category = metadata.category;
      
      if (!topicMap.has(category)) {
        topicMap.set(category, []);
      }
      topicMap.get(category)!.push(tab);
    }
    
    return Array.from(topicMap.entries())
      .filter(([_, tabList]) => tabList.length >= 2)
      .map(([topic, tabList]) => ({
        name: `${topic} (${tabList.length} 个标签)`,
        tabs: tabList,
        confidence: 0.8,
        type: 'topic' as const,
        description: `${topic}相关的标签页`
      }));
  }

  private async groupByTime(tabs: Tab[]): Promise<GroupSuggestion[]> {
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const thisWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    const timeGroups = {
      today: tabs.filter(tab => new Date(tab.createdAt) >= yesterday),
      thisWeek: tabs.filter(tab => {
        const created = new Date(tab.createdAt);
        return created >= thisWeek && created < yesterday;
      }),
      older: tabs.filter(tab => new Date(tab.createdAt) < thisWeek)
    };
    
    const suggestions: GroupSuggestion[] = [];
    
    if (timeGroups.today.length >= 3) {
      suggestions.push({
        name: `今日标签 (${timeGroups.today.length} 个)`,
        tabs: timeGroups.today,
        confidence: 0.7,
        type: 'time',
        description: '今天打开的标签页'
      });
    }
    
    if (timeGroups.thisWeek.length >= 5) {
      suggestions.push({
        name: `本周标签 (${timeGroups.thisWeek.length} 个)`,
        tabs: timeGroups.thisWeek,
        confidence: 0.6,
        type: 'time',
        description: '本周打开的标签页'
      });
    }
    
    return suggestions;
  }

  private async groupByImportance(tabs: Tab[]): Promise<GroupSuggestion[]> {
    const importantTabs = [];
    
    for (const tab of tabs) {
      const metadata = await this.analyzeTab(tab);
      if (metadata.importance >= 8) {
        importantTabs.push(tab);
      }
    }
    
    if (importantTabs.length >= 2) {
      return [{
        name: `重要标签 (${importantTabs.length} 个)`,
        tabs: importantTabs,
        confidence: 0.9,
        type: 'manual',
        description: '标记为重要的标签页'
      }];
    }
    
    return [];
  }
}

/**
 * 增强搜索服务
 */
export class EnhancedSearchService {
  private analyzer: SmartTabAnalyzer;
  
  constructor() {
    this.analyzer = new SmartTabAnalyzer();
  }

  /**
   * 智能搜索
   */
  async search(tabs: Tab[], query: string): Promise<SearchResult[]> {
    if (!query.trim()) return [];
    
    const results: SearchResult[] = [];
    
    // 处理特殊搜索语法
    if (query.startsWith('#')) {
      return this.searchByTag(tabs, query.slice(1));
    }
    
    if (query.startsWith('domain:')) {
      return this.searchByDomain(tabs, query.slice(7));
    }
    
    if (query.startsWith('category:')) {
      return this.searchByCategory(tabs, query.slice(9));
    }
    
    if (query.startsWith('/') && query.endsWith('/')) {
      return this.searchByRegex(tabs, query.slice(1, -1));
    }
    
    // 普通模糊搜索
    for (const tab of tabs) {
      const result = await this.scoreTab(tab, query);
      if (result.score > 0) {
        results.push(result);
      }
    }
    
    // 按相关性排序
    return results.sort((a, b) => b.score - a.score);
  }

  private async scoreTab(tab: Tab, query: string): Promise<SearchResult> {
    const queryLower = query.toLowerCase();
    let score = 0;
    const highlights: SearchHighlight[] = [];
    let matchType: SearchResult['matchType'] = 'title';
    
    // 标题匹配
    const titleMatches = this.findMatches(tab.title, queryLower);
    if (titleMatches.length > 0) {
      score += titleMatches.length * 3; // 标题匹配权重高
      highlights.push({
        field: 'title',
        text: tab.title,
        positions: titleMatches
      });
      matchType = 'title';
    }
    
    // URL匹配
    const urlMatches = this.findMatches(tab.url, queryLower);
    if (urlMatches.length > 0) {
      score += urlMatches.length * 2; // URL匹配权重中等
      highlights.push({
        field: 'url',
        text: tab.url,
        positions: urlMatches
      });
      if (matchType !== 'title') matchType = 'url';
    }
    
    // 元数据匹配
    const metadata = await this.analyzer.analyzeTab(tab);
    const keywordMatches = metadata.keywords.filter(keyword => 
      keyword.toLowerCase().includes(queryLower)
    );
    if (keywordMatches.length > 0) {
      score += keywordMatches.length;
      if (matchType === 'title') matchType = 'content';
    }
    
    return {
      tab,
      score,
      highlights,
      matchType
    };
  }

  private findMatches(text: string, query: string): { start: number; end: number }[] {
    const matches: { start: number; end: number }[] = [];
    const textLower = text.toLowerCase();
    let startIndex = 0;
    
    while (true) {
      const index = textLower.indexOf(query, startIndex);
      if (index === -1) break;
      
      matches.push({
        start: index,
        end: index + query.length
      });
      
      startIndex = index + 1;
    }
    
    return matches;
  }

  private async searchByTag(_tabs: Tab[], _tag: string): Promise<SearchResult[]> {
    // 这里需要标签系统的支持
    return [];
  }

  private async searchByDomain(tabs: Tab[], domain: string): Promise<SearchResult[]> {
    return tabs
      .filter(tab => {
        try {
          return new URL(tab.url).hostname.includes(domain.toLowerCase());
        } catch {
          return false;
        }
      })
      .map(tab => ({
        tab,
        score: 1,
        highlights: [{
          field: 'url',
          text: tab.url,
          positions: [{ start: 0, end: domain.length }]
        }],
        matchType: 'url' as const
      }));
  }

  private async searchByCategory(tabs: Tab[], category: string): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    
    for (const tab of tabs) {
      const metadata = await this.analyzer.analyzeTab(tab);
      if (metadata.category.toLowerCase().includes(category.toLowerCase())) {
        results.push({
          tab,
          score: 1,
          highlights: [],
          matchType: 'content'
        });
      }
    }
    
    return results;
  }

  private async searchByRegex(tabs: Tab[], pattern: string): Promise<SearchResult[]> {
    try {
      const regex = new RegExp(pattern, 'i');
      return tabs
        .filter(tab => regex.test(tab.title) || regex.test(tab.url))
        .map(tab => ({
          tab,
          score: 1,
          highlights: [],
          matchType: 'title' as const
        }));
    } catch {
      return [];
    }
  }
}

// 导出实例
export const smartTabAnalyzer = new SmartTabAnalyzer();
export const enhancedSearchService = new EnhancedSearchService();
