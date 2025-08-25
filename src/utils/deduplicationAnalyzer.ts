/**
 * 去重操作分析器
 * 专门用于分析去重操作后出现190个标签的异常情况
 */

import { TabGroup } from '@/shared/types/tab';
import { logger } from '@/shared/utils/logger';

export interface DeduplicationAnalysis {
  originalCount: number;
  expectedAfterDedup: number;
  actualResult: number;
  possibleCauses: string[];
  dataInconsistencies: Array<{
    type: string;
    description: string;
    affectedGroups: string[];
  }>;
  recommendations: string[];
}

/**
 * 去重分析器类
 */
export class DeduplicationAnalyzer {
  /**
   * 分析去重操作的异常结果
   */
  analyzeDeduplicationAnomaly(
    originalGroups: TabGroup[],
    expectedDeduplicatedGroups: TabGroup[],
    actualResultGroups: TabGroup[]
  ): DeduplicationAnalysis {
    const analysis: DeduplicationAnalysis = {
      originalCount: this.getTotalTabCount(originalGroups),
      expectedAfterDedup: this.getTotalTabCount(expectedDeduplicatedGroups),
      actualResult: this.getTotalTabCount(actualResultGroups),
      possibleCauses: [],
      dataInconsistencies: [],
      recommendations: []
    };

    console.group('🔍 去重异常分析');
    console.log('📊 数据概览:', {
      原始标签数: analysis.originalCount,
      期望去重后: analysis.expectedAfterDedup,
      实际结果: analysis.actualResult
    });

    // 分析可能的原因
    this.analyzePossibleCauses(analysis, originalGroups, expectedDeduplicatedGroups, actualResultGroups);

    // 检测数据不一致
    this.detectDataInconsistencies(analysis, originalGroups, expectedDeduplicatedGroups, actualResultGroups);

    // 生成建议
    this.generateRecommendations(analysis);

    console.log('🎯 分析结果:', analysis);
    console.groupEnd();

    return analysis;
  }

  /**
   * 分析可能的原因
   */
  private analyzePossibleCauses(
    analysis: DeduplicationAnalysis,
    original: TabGroup[],
    expected: TabGroup[],
    actual: TabGroup[]
  ): void {
    const originalCount = analysis.originalCount;
    const expectedCount = analysis.expectedAfterDedup;
    const actualCount = analysis.actualResult;

    // 情况1: 实际结果介于原始和期望之间
    if (actualCount > expectedCount && actualCount < originalCount) {
      analysis.possibleCauses.push('部分去重操作被其他数据覆盖或合并');
      analysis.possibleCauses.push('存在多个同步机制同时运行，导致数据冲突');
      analysis.possibleCauses.push('页面刷新时触发了数据合并，恢复了部分重复数据');
    }

    // 情况2: 检查是否存在数据合并
    const mergeEvidence = this.detectMergeEvidence(original, expected, actual);
    if (mergeEvidence.hasMerge) {
      analysis.possibleCauses.push(`检测到数据合并行为: ${mergeEvidence.description}`);
    }

    // 情况3: 检查时间戳异常
    const timestampIssues = this.detectTimestampIssues(actual);
    if (timestampIssues.length > 0) {
      analysis.possibleCauses.push('检测到时间戳异常，可能影响数据合并逻辑');
    }

    // 情况4: 检查重复数据恢复
    const duplicateRestoration = this.detectDuplicateRestoration(expected, actual);
    if (duplicateRestoration.hasRestoration) {
      analysis.possibleCauses.push(`检测到重复数据恢复: ${duplicateRestoration.restoredCount} 个重复项被恢复`);
    }
  }

  /**
   * 检测数据不一致
   */
  private detectDataInconsistencies(
    analysis: DeduplicationAnalysis,
    original: TabGroup[],
    expected: TabGroup[],
    actual: TabGroup[]
  ): void {
    // 检查组级别的不一致
    const groupInconsistencies = this.detectGroupInconsistencies(original, expected, actual);
    analysis.dataInconsistencies.push(...groupInconsistencies);

    // 检查标签级别的不一致
    const tabInconsistencies = this.detectTabInconsistencies(original, expected, actual);
    analysis.dataInconsistencies.push(...tabInconsistencies);

    // 检查ID不一致
    const idInconsistencies = this.detectIdInconsistencies(original, expected, actual);
    analysis.dataInconsistencies.push(...idInconsistencies);
  }

  /**
   * 生成建议
   */
  private generateRecommendations(analysis: DeduplicationAnalysis): void {
    if (analysis.possibleCauses.includes('存在多个同步机制同时运行，导致数据冲突')) {
      analysis.recommendations.push('禁用除统一同步服务外的其他同步机制');
      analysis.recommendations.push('使用同步初始化器确保只有一个同步服务运行');
    }

    if (analysis.possibleCauses.some(cause => cause.includes('数据合并'))) {
      analysis.recommendations.push('修改页面刷新逻辑，避免自动触发数据合并');
      analysis.recommendations.push('在去重操作后立即禁用实时同步，防止数据被覆盖');
    }

    if (analysis.dataInconsistencies.length > 0) {
      analysis.recommendations.push('执行完整的数据一致性检查和修复');
      analysis.recommendations.push('清除本地缓存，重新从云端下载数据');
    }

    // 通用建议
    analysis.recommendations.push('使用调试日志工具监控下次去重操作的完整流程');
    analysis.recommendations.push('在去重操作前后创建数据快照，便于问题追踪');
  }

  /**
   * 检测合并证据
   */
  private detectMergeEvidence(
    original: TabGroup[],
    expected: TabGroup[],
    actual: TabGroup[]
  ): { hasMerge: boolean; description: string } {
    const originalIds = new Set(original.map(g => g.id));
    const expectedIds = new Set(expected.map(g => g.id));
    const actualIds = new Set(actual.map(g => g.id));

    // 检查是否有期望中不存在但实际结果中存在的组
    const unexpectedGroups = actual.filter(g => !expectedIds.has(g.id));
    const restoredGroups = unexpectedGroups.filter(g => originalIds.has(g.id));

    if (restoredGroups.length > 0) {
      return {
        hasMerge: true,
        description: `${restoredGroups.length} 个原本应该被删除的组被恢复`
      };
    }

    return { hasMerge: false, description: '' };
  }

  /**
   * 检测时间戳异常
   */
  private detectTimestampIssues(groups: TabGroup[]): Array<{ groupId: string; issue: string }> {
    const issues: Array<{ groupId: string; issue: string }> = [];
    const now = Date.now();

    groups.forEach(group => {
      const updatedTime = new Date(group.updatedAt).getTime();
      const createdTime = new Date(group.createdAt).getTime();

      // 检查更新时间是否在创建时间之前
      if (updatedTime < createdTime) {
        issues.push({
          groupId: group.id,
          issue: '更新时间早于创建时间'
        });
      }

      // 检查时间是否过于未来
      if (updatedTime > now + 60000) { // 1分钟容差
        issues.push({
          groupId: group.id,
          issue: '更新时间过于未来'
        });
      }

      // 检查时间是否过于久远
      if (updatedTime < now - 365 * 24 * 60 * 60 * 1000) { // 1年前
        issues.push({
          groupId: group.id,
          issue: '更新时间过于久远'
        });
      }
    });

    return issues;
  }

  /**
   * 检测重复数据恢复
   */
  private detectDuplicateRestoration(
    expected: TabGroup[],
    actual: TabGroup[]
  ): { hasRestoration: boolean; restoredCount: number } {
    const expectedUrls = new Set<string>();
    expected.forEach(group => {
      group.tabs.forEach(tab => {
        if (tab.url) expectedUrls.add(tab.url);
      });
    });

    const actualUrls = new Set<string>();
    const duplicateUrls = new Set<string>();
    
    actual.forEach(group => {
      group.tabs.forEach(tab => {
        if (tab.url) {
          if (actualUrls.has(tab.url)) {
            duplicateUrls.add(tab.url);
          }
          actualUrls.add(tab.url);
        }
      });
    });

    const restoredDuplicates = Array.from(duplicateUrls).filter(url => !expectedUrls.has(url));

    return {
      hasRestoration: restoredDuplicates.length > 0,
      restoredCount: restoredDuplicates.length
    };
  }

  /**
   * 检测组级别不一致
   */
  private detectGroupInconsistencies(
    original: TabGroup[],
    expected: TabGroup[],
    actual: TabGroup[]
  ): Array<{ type: string; description: string; affectedGroups: string[] }> {
    const inconsistencies: Array<{ type: string; description: string; affectedGroups: string[] }> = [];

    // 检查组数量异常
    if (actual.length !== expected.length) {
      const diff = actual.length - expected.length;
      inconsistencies.push({
        type: 'group_count_mismatch',
        description: `组数量不匹配，差异: ${diff}`,
        affectedGroups: []
      });
    }

    return inconsistencies;
  }

  /**
   * 检测标签级别不一致
   */
  private detectTabInconsistencies(
    original: TabGroup[],
    expected: TabGroup[],
    actual: TabGroup[]
  ): Array<{ type: string; description: string; affectedGroups: string[] }> {
    const inconsistencies: Array<{ type: string; description: string; affectedGroups: string[] }> = [];

    const expectedTotalTabs = this.getTotalTabCount(expected);
    const actualTotalTabs = this.getTotalTabCount(actual);

    if (actualTotalTabs !== expectedTotalTabs) {
      const diff = actualTotalTabs - expectedTotalTabs;
      inconsistencies.push({
        type: 'tab_count_mismatch',
        description: `标签总数不匹配，差异: ${diff}`,
        affectedGroups: []
      });
    }

    return inconsistencies;
  }

  /**
   * 检测ID不一致
   */
  private detectIdInconsistencies(
    original: TabGroup[],
    expected: TabGroup[],
    actual: TabGroup[]
  ): Array<{ type: string; description: string; affectedGroups: string[] }> {
    const inconsistencies: Array<{ type: string; description: string; affectedGroups: string[] }> = [];

    const expectedIds = new Set(expected.map(g => g.id));
    const actualIds = new Set(actual.map(g => g.id));

    const missingIds = Array.from(expectedIds).filter(id => !actualIds.has(id));
    const extraIds = Array.from(actualIds).filter(id => !expectedIds.has(id));

    if (missingIds.length > 0) {
      inconsistencies.push({
        type: 'missing_groups',
        description: `缺失 ${missingIds.length} 个期望的组`,
        affectedGroups: missingIds
      });
    }

    if (extraIds.length > 0) {
      inconsistencies.push({
        type: 'extra_groups',
        description: `多出 ${extraIds.length} 个意外的组`,
        affectedGroups: extraIds
      });
    }

    return inconsistencies;
  }

  /**
   * 获取总标签数
   */
  private getTotalTabCount(groups: TabGroup[]): number {
    return groups.reduce((sum, group) => sum + group.tabs.length, 0);
  }

  /**
   * 创建数据快照用于对比
   */
  createDataSnapshot(groups: TabGroup[], label: string): void {
    console.group(`📸 数据快照: ${label}`);
    console.log('组统计:', {
      总组数: groups.length,
      总标签数: this.getTotalTabCount(groups),
      组详情: groups.map(g => ({
        id: g.id,
        name: g.name,
        标签数: g.tabs.length,
        更新时间: g.updatedAt
      }))
    });

    // 创建URL统计
    const allUrls = new Set<string>();
    const duplicateUrls = new Set<string>();
    
    groups.forEach(group => {
      group.tabs.forEach(tab => {
        if (tab.url) {
          if (allUrls.has(tab.url)) {
            duplicateUrls.add(tab.url);
          }
          allUrls.add(tab.url);
        }
      });
    });

    console.log('URL统计:', {
      唯一URL数: allUrls.size,
      重复URL数: duplicateUrls.size,
      重复率: `${((duplicateUrls.size / allUrls.size) * 100).toFixed(2)}%`
    });

    if (duplicateUrls.size > 0) {
      console.log('重复URL列表:', Array.from(duplicateUrls).slice(0, 10)); // 只显示前10个
    }

    console.groupEnd();
  }
}

/**
 * 全局分析器实例
 */
export const deduplicationAnalyzer = new DeduplicationAnalyzer();

/**
 * 便捷函数：分析去重异常
 */
export function analyzeDeduplicationAnomaly(
  original: TabGroup[],
  expected: TabGroup[],
  actual: TabGroup[]
): DeduplicationAnalysis {
  return deduplicationAnalyzer.analyzeDeduplicationAnomaly(original, expected, actual);
}

/**
 * 便捷函数：创建数据快照
 */
export function createDataSnapshot(groups: TabGroup[], label: string): void {
  deduplicationAnalyzer.createDataSnapshot(groups, label);
}

// 在开发环境下暴露到全局对象
if (process.env.NODE_ENV === 'development') {
  (window as any).deduplicationAnalyzer = deduplicationAnalyzer;
}
