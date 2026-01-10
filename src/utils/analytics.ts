/**
 * 标签页统计和分析工具
 * 提供数据洞察和可视化支持
 */

import { Tab, TabGroup } from '@/types/tab';

export interface TabStatistics {
  totalGroups: number;
  totalTabs: number;
  lockedGroups: number;
  avgTabsPerGroup: number;
  oldestGroup: {
    name: string;
    createdAt: string;
  } | null;
  newestGroup: {
    name: string;
    createdAt: string;
  } | null;
  mostUsedDomains: Array<{
    domain: string;
    count: number;
  }>;
  tabsByDomain: Record<string, number>;
  storageSize: number; // 估算的存储大小（字节）
}

export interface GroupAnalytics {
  id: string;
  name: string;
  tabCount: number;
  createdDaysAgo: number;
  lastUpdatedDaysAgo: number;
  avgTabAge: number; // 平均标签页年龄（天）
  uniqueDomains: number;
  duplicateTabs: number; // 重复的标签页数量
}

/**
 * 从URL提取域名
 */
function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return 'unknown';
  }
}

/**
 * 计算天数差
 */
function daysSince(dateString: string): number {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * 估算对象的JSON大小（字节）
 */
function estimateSize(obj: unknown): number {
  try {
    return new Blob([JSON.stringify(obj)]).size;
  } catch {
    return 0;
  }
}

/**
 * 计算标签页统计信息
 */
export function calculateStatistics(groups: TabGroup[]): TabStatistics {
  const totalGroups = groups.length;
  const totalTabs = groups.reduce((sum, g) => sum + g.tabs.length, 0);
  const lockedGroups = groups.filter(g => g.isLocked).length;
  const avgTabsPerGroup = totalGroups > 0 ? totalTabs / totalGroups : 0;

  // 找出最老和最新的标签组
  let oldestGroup: { name: string; createdAt: string } | null = null;
  let newestGroup: { name: string; createdAt: string } | null = null;

  if (groups.length > 0) {
    const sorted = [...groups].sort((a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    oldestGroup = {
      name: sorted[0].name,
      createdAt: sorted[0].createdAt,
    };
    newestGroup = {
      name: sorted[sorted.length - 1].name,
      createdAt: sorted[sorted.length - 1].createdAt,
    };
  }

  // 统计域名使用情况
  const domainCounts: Record<string, number> = {};
  for (const group of groups) {
    for (const tab of group.tabs) {
      const domain = extractDomain(tab.url);
      domainCounts[domain] = (domainCounts[domain] || 0) + 1;
    }
  }

  // 获取最常用的10个域名
  const mostUsedDomains = Object.entries(domainCounts)
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // 估算存储大小
  const storageSize = estimateSize(groups);

  return {
    totalGroups,
    totalTabs,
    lockedGroups,
    avgTabsPerGroup: Math.round(avgTabsPerGroup * 10) / 10,
    oldestGroup,
    newestGroup,
    mostUsedDomains,
    tabsByDomain: domainCounts,
    storageSize,
  };
}

/**
 * 分析单个标签组
 */
export function analyzeGroup(group: TabGroup): GroupAnalytics {
  const createdDaysAgo = daysSince(group.createdAt);
  const lastUpdatedDaysAgo = daysSince(group.updatedAt);

  // 计算平均标签页年龄
  const tabAges = group.tabs.map(tab => daysSince(tab.createdAt));
  const avgTabAge = tabAges.length > 0
    ? tabAges.reduce((sum, age) => sum + age, 0) / tabAges.length
    : 0;

  // 统计唯一域名
  const domains = new Set(group.tabs.map(tab => extractDomain(tab.url)));
  const uniqueDomains = domains.size;

  // 检测重复标签页
  const urlCounts: Record<string, number> = {};
  for (const tab of group.tabs) {
    urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  }
  const duplicateTabs = Object.values(urlCounts).filter(count => count > 1).length;

  return {
    id: group.id,
    name: group.name,
    tabCount: group.tabs.length,
    createdDaysAgo,
    lastUpdatedDaysAgo,
    avgTabAge: Math.round(avgTabAge * 10) / 10,
    uniqueDomains,
    duplicateTabs,
  };
}

/**
 * 查找重复的标签页
 */
export function findDuplicateTabs(groups: TabGroup[]): Array<{
  url: string;
  count: number;
  tabs: Array<{ groupId: string; groupName: string; tab: Tab }>;
}> {
  const urlMap = new Map<string, Array<{ groupId: string; groupName: string; tab: Tab }>>();

  for (const group of groups) {
    for (const tab of group.tabs) {
      if (!urlMap.has(tab.url)) {
        urlMap.set(tab.url, []);
      }
      urlMap.get(tab.url)!.push({
        groupId: group.id,
        groupName: group.name,
        tab,
      });
    }
  }

  // 只返回有重复的URL
  const duplicates: Array<{
    url: string;
    count: number;
    tabs: Array<{ groupId: string; groupName: string; tab: Tab }>;
  }> = [];

  for (const [url, tabs] of urlMap.entries()) {
    if (tabs.length > 1) {
      duplicates.push({
        url,
        count: tabs.length,
        tabs,
      });
    }
  }

  return duplicates.sort((a, b) => b.count - a.count);
}

/**
 * 按域名分组标签页
 */
export function groupTabsByDomain(groups: TabGroup[]): Record<string, Array<{
  groupId: string;
  groupName: string;
  tab: Tab;
}>> {
  const domainGroups: Record<string, Array<{
    groupId: string;
    groupName: string;
    tab: Tab;
  }>> = {};

  for (const group of groups) {
    for (const tab of group.tabs) {
      const domain = extractDomain(tab.url);
      if (!domainGroups[domain]) {
        domainGroups[domain] = [];
      }
      domainGroups[domain].push({
        groupId: group.id,
        groupName: group.name,
        tab,
      });
    }
  }

  return domainGroups;
}

/**
 * 查找孤立的标签页（很久没访问）
 */
export function findStaleTabs(
  groups: TabGroup[],
  daysThreshold: number = 30
): Array<{
  groupId: string;
  groupName: string;
  tab: Tab;
  daysSinceAccessed: number;
}> {
  const staleTabs: Array<{
    groupId: string;
    groupName: string;
    tab: Tab;
    daysSinceAccessed: number;
  }> = [];

  for (const group of groups) {
    for (const tab of group.tabs) {
      const daysSinceAccessed = daysSince(tab.lastAccessed);
      if (daysSinceAccessed >= daysThreshold) {
        staleTabs.push({
          groupId: group.id,
          groupName: group.name,
          tab,
          daysSinceAccessed,
        });
      }
    }
  }

  return staleTabs.sort((a, b) => b.daysSinceAccessed - a.daysSinceAccessed);
}

/**
 * 生成统计报告
 */
export function generateReport(groups: TabGroup[]): string {
  const stats = calculateStatistics(groups);

  let report = '# TabVault Pro 统计报告\n\n';
  report += `生成时间: ${new Date().toLocaleString()}\n\n`;

  report += '## 总体统计\n\n';
  report += `- 标签组总数: ${stats.totalGroups}\n`;
  report += `- 标签页总数: ${stats.totalTabs}\n`;
  report += `- 锁定的标签组: ${stats.lockedGroups}\n`;
  report += `- 平均每组标签数: ${stats.avgTabsPerGroup}\n`;
  report += `- 估算存储大小: ${(stats.storageSize / 1024).toFixed(2)} KB\n\n`;

  if (stats.oldestGroup) {
    report += `- 最早的标签组: "${stats.oldestGroup.name}" (${new Date(stats.oldestGroup.createdAt).toLocaleDateString()})\n`;
  }
  if (stats.newestGroup) {
    report += `- 最新的标签组: "${stats.newestGroup.name}" (${new Date(stats.newestGroup.createdAt).toLocaleDateString()})\n`;
  }

  report += '\n## 最常访问的域名\n\n';
  for (const { domain, count } of stats.mostUsedDomains) {
    report += `${count}x - ${domain}\n`;
  }

  const duplicates = findDuplicateTabs(groups);
  if (duplicates.length > 0) {
    report += `\n## 重复的标签页\n\n`;
    report += `发现 ${duplicates.length} 个重复的URL\n`;
    for (const dup of duplicates.slice(0, 5)) {
      report += `- ${dup.count}x: ${dup.url}\n`;
    }
  }

  const staleTabs = findStaleTabs(groups, 30);
  if (staleTabs.length > 0) {
    report += `\n## 长期未访问的标签页\n\n`;
    report += `发现 ${staleTabs.length} 个超过30天未访问的标签页\n`;
  }

  return report;
}

/**
 * 导出统计数据为CSV格式
 */
export function exportToCSV(groups: TabGroup[]): string {
  let csv = 'Group Name,Tab Title,URL,Created At,Last Accessed,Domain\n';

  for (const group of groups) {
    for (const tab of group.tabs) {
      const domain = extractDomain(tab.url);
      csv += `"${group.name}","${tab.title}","${tab.url}","${tab.createdAt}","${tab.lastAccessed}","${domain}"\n`;
    }
  }

  return csv;
}
