/**
 * 智能分组工具
 * 提供基于域名、时间、内容的智能分组功能
 */

import { TabGroup, Tab } from '@/types/tab';
import { nanoid } from '@reduxjs/toolkit';

// 分组策略类型
export type GroupingStrategy = 'domain' | 'time' | 'keyword' | 'custom';

// 时间范围类型
export type TimeRange = 'today' | 'yesterday' | 'thisWeek' | 'thisMonth' | 'older';

// 分组结果
export interface GroupingResult {
  key: string;
  name: string;
  tabs: Tab[];
}

/**
 * 从 URL 提取域名
 */
export function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

/**
 * 从 URL 提取主域名（不包含子域名）
 */
export function extractMainDomain(url: string): string {
  const domain = extractDomain(url);
  const parts = domain.split('.');

  // 处理特殊情况，如 co.uk, com.cn 等
  const specialTLDs = ['co.uk', 'com.cn', 'com.au', 'co.jp', 'co.kr'];
  for (const tld of specialTLDs) {
    if (domain.endsWith(tld)) {
      return parts.slice(-3).join('.');
    }
  }

  // 一般情况，返回最后两部分
  return parts.slice(-2).join('.');
}

/**
 * 获取时间范围
 */
export function getTimeRange(dateStr: string): TimeRange {
  const date = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const weekStart = new Date(today.getTime() - today.getDay() * 24 * 60 * 60 * 1000);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  if (date >= today) return 'today';
  if (date >= yesterday) return 'yesterday';
  if (date >= weekStart) return 'thisWeek';
  if (date >= monthStart) return 'thisMonth';
  return 'older';
}

/**
 * 时间范围的显示名称
 */
export function getTimeRangeName(range: TimeRange): string {
  const names: Record<TimeRange, string> = {
    today: '今天',
    yesterday: '昨天',
    thisWeek: '本周',
    thisMonth: '本月',
    older: '更早',
  };
  return names[range];
}

/**
 * 按域名分组
 */
export function groupByDomain(tabs: Tab[]): GroupingResult[] {
  const domainMap = new Map<string, Tab[]>();

  tabs.forEach(tab => {
    const domain = extractMainDomain(tab.url);
    if (!domainMap.has(domain)) {
      domainMap.set(domain, []);
    }
    domainMap.get(domain)!.push(tab);
  });

  return Array.from(domainMap.entries())
    .map(([domain, domainTabs]) => ({
      key: domain,
      name: formatDomainName(domain),
      tabs: domainTabs,
    }))
    .sort((a, b) => b.tabs.length - a.tabs.length);
}

/**
 * 格式化域名为可读名称
 */
function formatDomainName(domain: string): string {
  // 常见网站的友好名称
  const friendlyNames: Record<string, string> = {
    'github.com': 'GitHub',
    'google.com': 'Google',
    'youtube.com': 'YouTube',
    'stackoverflow.com': 'Stack Overflow',
    'twitter.com': 'Twitter',
    'x.com': 'X (Twitter)',
    'facebook.com': 'Facebook',
    'linkedin.com': 'LinkedIn',
    'reddit.com': 'Reddit',
    'medium.com': 'Medium',
    'dev.to': 'DEV Community',
    'notion.so': 'Notion',
    'figma.com': 'Figma',
    'slack.com': 'Slack',
    'discord.com': 'Discord',
    'npmjs.com': 'NPM',
    'amazon.com': 'Amazon',
    'taobao.com': '淘宝',
    'jd.com': '京东',
    'zhihu.com': '知乎',
    'bilibili.com': 'Bilibili',
    'weibo.com': '微博',
    'baidu.com': '百度',
  };

  return friendlyNames[domain] || domain;
}

/**
 * 按时间分组
 */
export function groupByTime(tabs: Tab[]): GroupingResult[] {
  const timeMap = new Map<TimeRange, Tab[]>();

  tabs.forEach(tab => {
    const range = getTimeRange(tab.createdAt);
    if (!timeMap.has(range)) {
      timeMap.set(range, []);
    }
    timeMap.get(range)!.push(tab);
  });

  const order: TimeRange[] = ['today', 'yesterday', 'thisWeek', 'thisMonth', 'older'];

  return order
    .filter(range => timeMap.has(range))
    .map(range => ({
      key: range,
      name: getTimeRangeName(range),
      tabs: timeMap.get(range)!,
    }));
}

/**
 * 按关键词分组
 */
export function groupByKeyword(tabs: Tab[], keywords: string[]): GroupingResult[] {
  const keywordMap = new Map<string, Tab[]>();
  const unmatched: Tab[] = [];

  tabs.forEach(tab => {
    const title = tab.title.toLowerCase();
    const url = tab.url.toLowerCase();
    let matched = false;

    for (const keyword of keywords) {
      const lowerKeyword = keyword.toLowerCase();
      if (title.includes(lowerKeyword) || url.includes(lowerKeyword)) {
        if (!keywordMap.has(keyword)) {
          keywordMap.set(keyword, []);
        }
        keywordMap.get(keyword)!.push(tab);
        matched = true;
        break; // 每个标签只分到第一个匹配的关键词组
      }
    }

    if (!matched) {
      unmatched.push(tab);
    }
  });

  const results = Array.from(keywordMap.entries()).map(([keyword, keywordTabs]) => ({
    key: keyword,
    name: keyword,
    tabs: keywordTabs,
  }));

  if (unmatched.length > 0) {
    results.push({
      key: 'other',
      name: '其他',
      tabs: unmatched,
    });
  }

  return results;
}

/**
 * 自动检测标签页中的常见关键词
 */
export function detectKeywords(tabs: Tab[], minCount: number = 2): string[] {
  const wordCount = new Map<string, number>();

  // 常见停用词
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
    'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought',
    'used', 'http', 'https', 'www', 'com', 'org', 'net', 'io', 'html', 'htm',
    '的', '了', '是', '在', '有', '和', '与', '或', '但', '而', '个', '这', '那',
  ]);

  tabs.forEach(tab => {
    // 从标题中提取词
    const words = tab.title
      .toLowerCase()
      .split(/[\s\-_.,;:!?()[\]{}'"<>\/\\|@#$%^&*+=~`]+/)
      .filter(word => word.length > 2 && !stopWords.has(word));

    words.forEach(word => {
      wordCount.set(word, (wordCount.get(word) || 0) + 1);
    });
  });

  // 返回出现次数超过阈值的关键词
  return Array.from(wordCount.entries())
    .filter(([, count]) => count >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);
}

/**
 * 智能分组 - 综合多种策略
 */
export function smartGroup(
  tabs: Tab[],
  options: {
    strategy?: GroupingStrategy;
    keywords?: string[];
    minGroupSize?: number;
  } = {}
): GroupingResult[] {
  const { strategy = 'domain', keywords = [], minGroupSize = 1 } = options;

  let results: GroupingResult[];

  switch (strategy) {
    case 'domain':
      results = groupByDomain(tabs);
      break;
    case 'time':
      results = groupByTime(tabs);
      break;
    case 'keyword':
      const keywordsToUse = keywords.length > 0 ? keywords : detectKeywords(tabs);
      results = groupByKeyword(tabs, keywordsToUse);
      break;
    default:
      results = groupByDomain(tabs);
  }

  // 过滤小于最小组大小的组，并合并到"其他"组
  if (minGroupSize > 1) {
    const validGroups = results.filter(r => r.tabs.length >= minGroupSize);
    const smallGroupTabs = results
      .filter(r => r.tabs.length < minGroupSize)
      .flatMap(r => r.tabs);

    if (smallGroupTabs.length > 0) {
      validGroups.push({
        key: 'other',
        name: '其他',
        tabs: smallGroupTabs,
      });
    }

    results = validGroups;
  }

  return results;
}

/**
 * 将分组结果转换为 TabGroup 数组
 */
export function convertToTabGroups(results: GroupingResult[]): TabGroup[] {
  const now = new Date().toISOString();

  return results.map(result => ({
    id: nanoid(),
    name: result.name,
    tabs: result.tabs.map(tab => ({ ...tab, id: tab.id || nanoid() })),
    createdAt: now,
    updatedAt: now,
    isLocked: false,
    version: 1,
  }));
}

/**
 * 合并相似的标签组
 */
export function mergeSimilarGroups(
  groups: TabGroup[],
  similarityThreshold: number = 0.7
): TabGroup[] {
  // 计算两个组的相似度（基于域名重叠）
  const calculateSimilarity = (group1: TabGroup, group2: TabGroup): number => {
    const domains1 = new Set(group1.tabs.map(t => extractMainDomain(t.url)));
    const domains2 = new Set(group2.tabs.map(t => extractMainDomain(t.url)));

    const intersection = new Set([...domains1].filter(d => domains2.has(d)));
    const union = new Set([...domains1, ...domains2]);

    return intersection.size / union.size;
  };

  const merged: TabGroup[] = [];
  const processed = new Set<string>();

  groups.forEach((group, i) => {
    if (processed.has(group.id)) return;

    let currentGroup = { ...group };
    processed.add(group.id);

    // 查找可以合并的组
    for (let j = i + 1; j < groups.length; j++) {
      const otherGroup = groups[j];
      if (processed.has(otherGroup.id)) continue;

      const similarity = calculateSimilarity(currentGroup, otherGroup);
      if (similarity >= similarityThreshold) {
        // 合并标签页
        currentGroup = {
          ...currentGroup,
          tabs: [...currentGroup.tabs, ...otherGroup.tabs],
          updatedAt: new Date().toISOString(),
        };
        processed.add(otherGroup.id);
      }
    }

    merged.push(currentGroup);
  });

  return merged;
}
