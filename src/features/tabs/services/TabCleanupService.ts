import { TabGroup, Tab } from '@/shared/types/tab';
import { storage } from '@/shared/utils/storage';
import { logger } from '@/shared/utils/logger';
import { errorHandler } from '@/shared/utils/errorHandler';

/**
 * 清理规则配置
 */
export interface CleanupRules {
  removeDuplicateUrls: boolean;
  removeInvalidUrls: boolean;
  removeEmptyGroups: boolean;
  mergeIdenticalGroups: boolean;
  removeOldTabs: boolean;
  oldTabsThresholdDays: number;
}

/**
 * 清理结果
 */
export interface CleanupResult {
  success: boolean;
  summary: {
    duplicateTabsRemoved: number;
    invalidTabsRemoved: number;
    emptyGroupsRemoved: number;
    groupsMerged: number;
    oldTabsRemoved: number;
    totalTabsBefore: number;
    totalTabsAfter: number;
    totalGroupsBefore: number;
    totalGroupsAfter: number;
  };
  details: {
    duplicateUrls: string[];
    invalidUrls: string[];
    removedGroups: string[];
    mergedGroups: Array<{ from: string; to: string }>;
    oldTabs: Array<{ title: string; url: string; age: number }>;
  };
  warnings: string[];
  errors: string[];
}

/**
 * 进度回调
 */
export type CleanupProgressCallback = (progress: {
  stage: string;
  current: number;
  total: number;
  percentage: number;
  message: string;
}) => void;

/**
 * 标签清理领域服务
 * 负责标签和标签组的清理、去重、优化等业务逻辑
 */
export class TabCleanupService {
  
  /**
   * 执行全面清理
   */
  async performCleanup(
    rules: CleanupRules,
    onProgress?: CleanupProgressCallback
  ): Promise<CleanupResult> {
    try {
      logger.debug('开始执行标签清理', rules);
      
      const groups = await storage.getGroups();
      const originalStats = this.getStatistics(groups);
      
      let currentGroups = [...groups];
      const result: CleanupResult = {
        success: true,
        summary: {
          duplicateTabsRemoved: 0,
          invalidTabsRemoved: 0,
          emptyGroupsRemoved: 0,
          groupsMerged: 0,
          oldTabsRemoved: 0,
          totalTabsBefore: originalStats.totalTabs,
          totalTabsAfter: 0,
          totalGroupsBefore: originalStats.totalGroups,
          totalGroupsAfter: 0
        },
        details: {
          duplicateUrls: [],
          invalidUrls: [],
          removedGroups: [],
          mergedGroups: [],
          oldTabs: []
        },
        warnings: [],
        errors: []
      };
      
      const stages = [
        { name: 'removeDuplicates', enabled: rules.removeDuplicateUrls, weight: 30 },
        { name: 'removeInvalid', enabled: rules.removeInvalidUrls, weight: 20 },
        { name: 'removeOld', enabled: rules.removeOldTabs, weight: 20 },
        { name: 'mergeGroups', enabled: rules.mergeIdenticalGroups, weight: 20 },
        { name: 'removeEmpty', enabled: rules.removeEmptyGroups, weight: 10 }
      ];
      
      const enabledStages = stages.filter(s => s.enabled);
      let completedWeight = 0;
      
      // 1. 清理重复标签
      if (rules.removeDuplicateUrls) {
        onProgress?.({
          stage: '清理重复标签',
          current: 1,
          total: enabledStages.length,
          percentage: Math.round((completedWeight / 100) * 100),
          message: '正在查找并移除重复的标签...'
        });
        
        const duplicateResult = await this.removeDuplicateTabs(currentGroups);
        currentGroups = duplicateResult.groups;
        result.summary.duplicateTabsRemoved = duplicateResult.removedCount;
        result.details.duplicateUrls = duplicateResult.duplicateUrls;
        
        completedWeight += 30;
      }
      
      // 2. 清理无效标签
      if (rules.removeInvalidUrls) {
        onProgress?.({
          stage: '清理无效标签',
          current: 2,
          total: enabledStages.length,
          percentage: Math.round((completedWeight / 100) * 100),
          message: '正在移除无效的URL...'
        });
        
        const invalidResult = await this.removeInvalidTabs(currentGroups);
        currentGroups = invalidResult.groups;
        result.summary.invalidTabsRemoved = invalidResult.removedCount;
        result.details.invalidUrls = invalidResult.invalidUrls;
        
        completedWeight += 20;
      }
      
      // 3. 清理过期标签
      if (rules.removeOldTabs) {
        onProgress?.({
          stage: '清理过期标签',
          current: 3,
          total: enabledStages.length,
          percentage: Math.round((completedWeight / 100) * 100),
          message: `正在移除超过${rules.oldTabsThresholdDays}天的标签...`
        });
        
        const oldResult = await this.removeOldTabs(currentGroups, rules.oldTabsThresholdDays);
        currentGroups = oldResult.groups;
        result.summary.oldTabsRemoved = oldResult.removedCount;
        result.details.oldTabs = oldResult.oldTabs;
        
        completedWeight += 20;
      }
      
      // 4. 合并相同标签组
      if (rules.mergeIdenticalGroups) {
        onProgress?.({
          stage: '合并相同标签组',
          current: 4,
          total: enabledStages.length,
          percentage: Math.round((completedWeight / 100) * 100),
          message: '正在合并名称相同的标签组...'
        });
        
        const mergeResult = await this.mergeIdenticalGroups(currentGroups);
        currentGroups = mergeResult.groups;
        result.summary.groupsMerged = mergeResult.mergedCount;
        result.details.mergedGroups = mergeResult.mergedGroups;
        
        completedWeight += 20;
      }
      
      // 5. 移除空标签组
      if (rules.removeEmptyGroups) {
        onProgress?.({
          stage: '移除空标签组',
          current: 5,
          total: enabledStages.length,
          percentage: Math.round((completedWeight / 100) * 100),
          message: '正在移除空的标签组...'
        });
        
        const emptyResult = await this.removeEmptyGroups(currentGroups);
        currentGroups = emptyResult.groups;
        result.summary.emptyGroupsRemoved = emptyResult.removedCount;
        result.details.removedGroups = emptyResult.removedGroups;
        
        completedWeight += 10;
      }
      
      // 保存清理后的数据
      await storage.setGroups(currentGroups);
      
      // 更新最终统计
      const finalStats = this.getStatistics(currentGroups);
      result.summary.totalTabsAfter = finalStats.totalTabs;
      result.summary.totalGroupsAfter = finalStats.totalGroups;
      
      onProgress?.({
        stage: '完成',
        current: enabledStages.length,
        total: enabledStages.length,
        percentage: 100,
        message: '清理完成'
      });
      
      logger.success('标签清理完成', result.summary);
      return result;
      
    } catch (error) {
      const message = errorHandler.getErrorMessage(error);
      logger.error('标签清理失败', error);
      
      return {
        success: false,
        summary: {
          duplicateTabsRemoved: 0,
          invalidTabsRemoved: 0,
          emptyGroupsRemoved: 0,
          groupsMerged: 0,
          oldTabsRemoved: 0,
          totalTabsBefore: 0,
          totalTabsAfter: 0,
          totalGroupsBefore: 0,
          totalGroupsAfter: 0
        },
        details: {
          duplicateUrls: [],
          invalidUrls: [],
          removedGroups: [],
          mergedGroups: [],
          oldTabs: []
        },
        warnings: [],
        errors: [message]
      };
    }
  }
  
  /**
   * 移除重复标签
   */
  private async removeDuplicateTabs(groups: TabGroup[]): Promise<{
    groups: TabGroup[];
    removedCount: number;
    duplicateUrls: string[];
  }> {
    const urlMap = new Map<string, { tab: Tab; groupId: string; index: number }>();
    const duplicateUrls: string[] = [];
    let removedCount = 0;
    
    // 扫描所有标签，记录URL
    groups.forEach(group => {
      group.tabs.forEach((tab, index) => {
        if (tab.url) {
          // 对于loading://开头的URL，需要特殊处理
          const urlKey = tab.url.startsWith('loading://') ? `${tab.url}|${tab.title}` : tab.url;
          
          if (urlMap.has(urlKey)) {
            duplicateUrls.push(tab.url);
          } else {
            urlMap.set(urlKey, { tab, groupId: group.id, index });
          }
        }
      });
    });
    
    // 移除重复标签
    const updatedGroups = groups.map(group => {
      const seenUrls = new Set<string>();
      const uniqueTabs = group.tabs.filter(tab => {
        if (!tab.url) return true;
        
        const urlKey = tab.url.startsWith('loading://') ? `${tab.url}|${tab.title}` : tab.url;
        
        if (seenUrls.has(urlKey)) {
          removedCount++;
          return false;
        }
        
        seenUrls.add(urlKey);
        return true;
      });
      
      return {
        ...group,
        tabs: uniqueTabs,
        updatedAt: uniqueTabs.length !== group.tabs.length ? new Date().toISOString() : group.updatedAt
      };
    });
    
    return {
      groups: updatedGroups,
      removedCount,
      duplicateUrls: [...new Set(duplicateUrls)]
    };
  }
  
  /**
   * 移除无效标签
   */
  private async removeInvalidTabs(groups: TabGroup[]): Promise<{
    groups: TabGroup[];
    removedCount: number;
    invalidUrls: string[];
  }> {
    const invalidUrls: string[] = [];
    let removedCount = 0;
    
    const updatedGroups = groups.map(group => {
      const validTabs = group.tabs.filter(tab => {
        if (!tab.url || !tab.title) {
          invalidUrls.push(tab.url || '(空URL)');
          removedCount++;
          return false;
        }
        
        // 检查URL格式
        try {
          new URL(tab.url);
          return true;
        } catch {
          // 允许特殊协议
          if (tab.url.startsWith('chrome://') || 
              tab.url.startsWith('moz-extension://') || 
              tab.url.startsWith('loading://')) {
            return true;
          }
          
          invalidUrls.push(tab.url);
          removedCount++;
          return false;
        }
      });
      
      return {
        ...group,
        tabs: validTabs,
        updatedAt: validTabs.length !== group.tabs.length ? new Date().toISOString() : group.updatedAt
      };
    });
    
    return {
      groups: updatedGroups,
      removedCount,
      invalidUrls: [...new Set(invalidUrls)]
    };
  }
  
  /**
   * 移除过期标签
   */
  private async removeOldTabs(groups: TabGroup[], thresholdDays: number): Promise<{
    groups: TabGroup[];
    removedCount: number;
    oldTabs: Array<{ title: string; url: string; age: number }>;
  }> {
    const now = new Date();
    const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000;
    const oldTabs: Array<{ title: string; url: string; age: number }> = [];
    let removedCount = 0;
    
    const updatedGroups = groups.map(group => {
      const groupCreatedAt = new Date(group.createdAt);
      const recentTabs = group.tabs.filter(tab => {
        const age = now.getTime() - groupCreatedAt.getTime();
        const ageDays = Math.floor(age / (24 * 60 * 60 * 1000));
        
        if (age > thresholdMs) {
          oldTabs.push({
            title: tab.title,
            url: tab.url,
            age: ageDays
          });
          removedCount++;
          return false;
        }
        
        return true;
      });
      
      return {
        ...group,
        tabs: recentTabs,
        updatedAt: recentTabs.length !== group.tabs.length ? new Date().toISOString() : group.updatedAt
      };
    });
    
    return {
      groups: updatedGroups,
      removedCount,
      oldTabs
    };
  }
  
  /**
   * 合并相同名称的标签组
   */
  private async mergeIdenticalGroups(groups: TabGroup[]): Promise<{
    groups: TabGroup[];
    mergedCount: number;
    mergedGroups: Array<{ from: string; to: string }>;
  }> {
    const groupsByName = new Map<string, TabGroup[]>();
    const mergedGroups: Array<{ from: string; to: string }> = [];
    let mergedCount = 0;
    
    // 按名称分组
    groups.forEach(group => {
      const name = group.name.trim().toLowerCase();
      if (!groupsByName.has(name)) {
        groupsByName.set(name, []);
      }
      groupsByName.get(name)!.push(group);
    });
    
    const resultGroups: TabGroup[] = [];
    
    // 合并同名组
    groupsByName.forEach((groupList, name) => {
      if (groupList.length === 1) {
        resultGroups.push(groupList[0]);
      } else {
        // 选择最早创建的组作为主组
        const mainGroup = groupList.reduce((earliest, current) => 
          new Date(current.createdAt) < new Date(earliest.createdAt) ? current : earliest
        );
        
        // 合并所有标签
        const allTabs: Tab[] = [];
        const seenUrls = new Set<string>();
        
        groupList.forEach(group => {
          group.tabs.forEach(tab => {
            const urlKey = tab.url.startsWith('loading://') ? `${tab.url}|${tab.title}` : tab.url;
            if (!seenUrls.has(urlKey)) {
              allTabs.push(tab);
              seenUrls.add(urlKey);
            }
          });
          
          if (group.id !== mainGroup.id) {
            mergedGroups.push({
              from: group.name,
              to: mainGroup.name
            });
            mergedCount++;
          }
        });
        
        resultGroups.push({
          ...mainGroup,
          tabs: allTabs,
          updatedAt: new Date().toISOString()
        });
      }
    });
    
    return {
      groups: resultGroups,
      mergedCount,
      mergedGroups
    };
  }
  
  /**
   * 移除空标签组
   */
  private async removeEmptyGroups(groups: TabGroup[]): Promise<{
    groups: TabGroup[];
    removedCount: number;
    removedGroups: string[];
  }> {
    const removedGroups: string[] = [];
    
    const nonEmptyGroups = groups.filter(group => {
      if (group.tabs.length === 0) {
        removedGroups.push(group.name);
        return false;
      }
      return true;
    });
    
    return {
      groups: nonEmptyGroups,
      removedCount: removedGroups.length,
      removedGroups
    };
  }
  
  /**
   * 获取统计信息
   */
  private getStatistics(groups: TabGroup[]): {
    totalGroups: number;
    totalTabs: number;
    averageTabsPerGroup: number;
    emptyGroups: number;
  } {
    const totalGroups = groups.length;
    const totalTabs = groups.reduce((sum, group) => sum + group.tabs.length, 0);
    const emptyGroups = groups.filter(group => group.tabs.length === 0).length;
    
    return {
      totalGroups,
      totalTabs,
      averageTabsPerGroup: totalGroups > 0 ? Math.round(totalTabs / totalGroups * 10) / 10 : 0,
      emptyGroups
    };
  }
  
  /**
   * 分析清理潜力
   */
  async analyzeCleanupPotential(groups: TabGroup[]): Promise<{
    duplicateTabs: number;
    invalidTabs: number;
    emptyGroups: number;
    identicalGroups: number;
    oldTabs: number;
    recommendations: string[];
  }> {
    const urlMap = new Map<string, number>();
    let duplicateTabs = 0;
    let invalidTabs = 0;
    let oldTabs = 0;
    const emptyGroups = groups.filter(g => g.tabs.length === 0).length;
    
    // 分析重复和无效标签
    groups.forEach(group => {
      group.tabs.forEach(tab => {
        if (!tab.url || !tab.title) {
          invalidTabs++;
          return;
        }
        
        try {
          new URL(tab.url);
        } catch {
          if (!tab.url.startsWith('chrome://') && 
              !tab.url.startsWith('moz-extension://') && 
              !tab.url.startsWith('loading://')) {
            invalidTabs++;
            return;
          }
        }
        
        const urlKey = tab.url.startsWith('loading://') ? `${tab.url}|${tab.title}` : tab.url;
        const count = urlMap.get(urlKey) || 0;
        urlMap.set(urlKey, count + 1);
        
        if (count > 0) {
          duplicateTabs++;
        }
        
        // 检查是否为过期标签（超过30天）
        const age = new Date().getTime() - new Date(group.createdAt).getTime();
        if (age > 30 * 24 * 60 * 60 * 1000) {
          oldTabs++;
        }
      });
    });
    
    // 分析相同名称的组
    const groupNames = new Map<string, number>();
    groups.forEach(group => {
      const name = group.name.trim().toLowerCase();
      const count = groupNames.get(name) || 0;
      groupNames.set(name, count + 1);
    });
    
    const identicalGroups = Array.from(groupNames.values())
      .filter(count => count > 1)
      .reduce((sum, count) => sum + count - 1, 0);
    
    // 生成建议
    const recommendations: string[] = [];
    if (duplicateTabs > 0) {
      recommendations.push(`发现 ${duplicateTabs} 个重复标签，建议清理`);
    }
    if (invalidTabs > 0) {
      recommendations.push(`发现 ${invalidTabs} 个无效标签，建议移除`);
    }
    if (emptyGroups > 0) {
      recommendations.push(`发现 ${emptyGroups} 个空标签组，建议删除`);
    }
    if (identicalGroups > 0) {
      recommendations.push(`发现 ${identicalGroups} 个重复标签组，建议合并`);
    }
    if (oldTabs > 0) {
      recommendations.push(`发现 ${oldTabs} 个超过30天的标签，可考虑清理`);
    }
    
    if (recommendations.length === 0) {
      recommendations.push('您的标签数据很整洁，无需清理');
    }
    
    return {
      duplicateTabs,
      invalidTabs,
      emptyGroups,
      identicalGroups,
      oldTabs,
      recommendations
    };
  }
}

// 导出单例实例
export const tabCleanupService = new TabCleanupService();
