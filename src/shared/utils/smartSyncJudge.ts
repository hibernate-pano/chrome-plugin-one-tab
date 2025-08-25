/**
 * 智能同步判断器
 * 根据数据变化情况和系统状态，智能判断是否需要执行同步
 */

import { TabGroup } from '@/shared/types/tab';
import { logger } from './logger';
import { timestampComparator } from './timestampComparison';

/**
 * 同步判断结果
 */
export interface SyncJudgment {
  shouldSync: boolean;
  reason: string;
  priority: 'low' | 'medium' | 'high';
  estimatedImpact: 'minimal' | 'moderate' | 'significant';
  recommendedDelay?: number;
}

/**
 * 数据变化类型
 */
export enum ChangeType {
  CREATE = 'create',
  UPDATE = 'update', 
  DELETE = 'delete',
  BULK_CHANGE = 'bulk_change'
}

/**
 * 变化信息
 */
export interface ChangeInfo {
  type: ChangeType;
  affectedGroups: number;
  affectedTabs: number;
  timestamp: string;
  source: 'local' | 'remote';
  metadata?: {
    groupIds?: string[];
    operationType?: string;
    batchSize?: number;
  };
}

/**
 * 系统状态信息
 */
export interface SystemState {
  isUserActive: boolean;
  networkQuality: 'poor' | 'fair' | 'good' | 'excellent';
  batteryLevel?: number;
  memoryUsage?: number;
  pendingOperations: number;
  lastSyncTime?: string;
}

/**
 * 智能同步判断器类
 */
export class SmartSyncJudge {
  private recentChanges: ChangeInfo[] = [];
  private readonly CHANGE_HISTORY_LIMIT = 50;
  private readonly CHANGE_WINDOW = 5 * 60 * 1000; // 5分钟窗口
  private readonly HIGH_FREQUENCY_THRESHOLD = 10; // 5分钟内超过10次变化认为是高频
  private readonly BULK_CHANGE_THRESHOLD = 5; // 一次影响超过5个组认为是批量变化

  /**
   * 主要判断方法：是否应该执行同步
   */
  shouldPerformSync(
    changeInfo: ChangeInfo,
    systemState: SystemState,
    localData?: TabGroup[],
    remoteData?: TabGroup[]
  ): SyncJudgment {
    // 记录变化
    this.recordChange(changeInfo);

    // 基础检查
    const basicCheck = this.performBasicChecks(changeInfo, systemState);
    if (!basicCheck.shouldSync) {
      return basicCheck;
    }

    // 频率检查
    const frequencyCheck = this.checkChangeFrequency(changeInfo);
    if (!frequencyCheck.shouldSync) {
      return frequencyCheck;
    }

    // 数据重要性检查
    const importanceCheck = this.assessDataImportance(changeInfo, localData, remoteData);
    
    // 系统资源检查
    const resourceCheck = this.checkSystemResources(systemState);

    // 综合判断
    return this.makeComprehensiveJudgment(
      changeInfo,
      systemState,
      importanceCheck,
      resourceCheck
    );
  }

  /**
   * 基础检查
   */
  private performBasicChecks(changeInfo: ChangeInfo, systemState: SystemState): SyncJudgment {
    // 检查是否有待处理的操作
    if (systemState.pendingOperations > 3) {
      return {
        shouldSync: false,
        reason: '待处理操作过多，延迟同步',
        priority: 'low',
        estimatedImpact: 'minimal',
        recommendedDelay: 2000
      };
    }

    // 检查网络质量
    if (systemState.networkQuality === 'poor') {
      return {
        shouldSync: false,
        reason: '网络质量差，跳过同步',
        priority: 'low',
        estimatedImpact: 'minimal',
        recommendedDelay: 5000
      };
    }

    // 检查最近同步时间
    if (systemState.lastSyncTime) {
      const timeSinceLastSync = Date.now() - new Date(systemState.lastSyncTime).getTime();
      if (timeSinceLastSync < 1000) { // 1秒内
        return {
          shouldSync: false,
          reason: '同步过于频繁，跳过',
          priority: 'low',
          estimatedImpact: 'minimal',
          recommendedDelay: 1000
        };
      }
    }

    return {
      shouldSync: true,
      reason: '通过基础检查',
      priority: 'medium',
      estimatedImpact: 'moderate'
    };
  }

  /**
   * 检查变化频率
   */
  private checkChangeFrequency(changeInfo: ChangeInfo): SyncJudgment {
    const recentChanges = this.getRecentChanges();
    
    if (recentChanges.length > this.HIGH_FREQUENCY_THRESHOLD) {
      // 高频变化，降低同步优先级
      return {
        shouldSync: true,
        reason: '检测到高频变化，降低同步优先级',
        priority: 'low',
        estimatedImpact: 'moderate',
        recommendedDelay: 2000
      };
    }

    // 检查是否是批量变化
    if (changeInfo.affectedGroups > this.BULK_CHANGE_THRESHOLD) {
      return {
        shouldSync: true,
        reason: '检测到批量变化，提高同步优先级',
        priority: 'high',
        estimatedImpact: 'significant'
      };
    }

    return {
      shouldSync: true,
      reason: '变化频率正常',
      priority: 'medium',
      estimatedImpact: 'moderate'
    };
  }

  /**
   * 评估数据重要性
   */
  private assessDataImportance(
    changeInfo: ChangeInfo,
    localData?: TabGroup[],
    remoteData?: TabGroup[]
  ): SyncJudgment {
    let priority: 'low' | 'medium' | 'high' = 'medium';
    let impact: 'minimal' | 'moderate' | 'significant' = 'moderate';

    // 删除操作优先级较高
    if (changeInfo.type === ChangeType.DELETE) {
      priority = 'high';
      impact = 'significant';
    }

    // 创建操作优先级中等
    if (changeInfo.type === ChangeType.CREATE) {
      priority = 'medium';
      impact = 'moderate';
    }

    // 更新操作需要进一步判断
    if (changeInfo.type === ChangeType.UPDATE && localData && remoteData) {
      const hasSignificantChanges = this.hasSignificantDataChanges(localData, remoteData);
      if (hasSignificantChanges) {
        priority = 'high';
        impact = 'significant';
      } else {
        priority = 'low';
        impact = 'minimal';
      }
    }

    // 影响标签页数量较多时提高优先级
    if (changeInfo.affectedTabs > 10) {
      priority = 'high';
      impact = 'significant';
    }

    return {
      shouldSync: true,
      reason: `数据重要性评估: ${priority}优先级`,
      priority,
      estimatedImpact: impact
    };
  }

  /**
   * 检查系统资源
   */
  private checkSystemResources(systemState: SystemState): SyncJudgment {
    let priority: 'low' | 'medium' | 'high' = 'medium';
    let shouldSync = true;
    let reason = '系统资源充足';

    // 检查电池电量
    if (systemState.batteryLevel && systemState.batteryLevel < 20) {
      priority = 'low';
      reason = '电池电量低，降低同步优先级';
    }

    // 检查内存使用
    if (systemState.memoryUsage && systemState.memoryUsage > 80) {
      priority = 'low';
      reason = '内存使用率高，降低同步优先级';
    }

    // 检查用户活跃状态
    if (!systemState.isUserActive) {
      priority = 'low';
      reason = '用户不活跃，降低同步优先级';
    }

    return {
      shouldSync,
      reason,
      priority,
      estimatedImpact: 'moderate'
    };
  }

  /**
   * 综合判断
   */
  private makeComprehensiveJudgment(
    changeInfo: ChangeInfo,
    systemState: SystemState,
    importanceCheck: SyncJudgment,
    resourceCheck: SyncJudgment
  ): SyncJudgment {
    // 计算综合优先级
    const priorities = [importanceCheck.priority, resourceCheck.priority];
    const highCount = priorities.filter(p => p === 'high').length;
    const lowCount = priorities.filter(p => p === 'low').length;

    let finalPriority: 'low' | 'medium' | 'high';
    if (highCount > 0 && lowCount === 0) {
      finalPriority = 'high';
    } else if (lowCount > highCount) {
      finalPriority = 'low';
    } else {
      finalPriority = 'medium';
    }

    // 计算推荐延迟
    let recommendedDelay = 0;
    if (finalPriority === 'low') {
      recommendedDelay = 2000;
    } else if (finalPriority === 'medium') {
      recommendedDelay = 500;
    } else {
      recommendedDelay = 100;
    }

    // 根据网络质量调整延迟
    if (systemState.networkQuality === 'fair') {
      recommendedDelay *= 1.5;
    } else if (systemState.networkQuality === 'poor') {
      recommendedDelay *= 2;
    }

    return {
      shouldSync: true,
      reason: `综合判断: ${finalPriority}优先级同步`,
      priority: finalPriority,
      estimatedImpact: importanceCheck.estimatedImpact,
      recommendedDelay: Math.round(recommendedDelay)
    };
  }

  /**
   * 检查是否有显著的数据变化
   */
  private hasSignificantDataChanges(localData: TabGroup[], remoteData: TabGroup[]): boolean {
    if (localData.length !== remoteData.length) {
      return true;
    }

    const localMap = new Map(localData.map(g => [g.id, g]));
    
    for (const remoteGroup of remoteData) {
      const localGroup = localMap.get(remoteGroup.id);
      if (!localGroup) {
        return true;
      }

      // 检查重要属性变化
      if (localGroup.name !== remoteGroup.name ||
          localGroup.isLocked !== remoteGroup.isLocked ||
          localGroup.tabs.length !== remoteGroup.tabs.length) {
        return true;
      }

      // 检查时间戳差异
      const comparison = timestampComparator.compareTabGroups(localGroup, remoteGroup);
      if (!comparison.isEqual && Math.abs(comparison.timeDifference) > 60000) { // 1分钟以上差异
        return true;
      }
    }

    return false;
  }

  /**
   * 记录变化
   */
  private recordChange(changeInfo: ChangeInfo): void {
    this.recentChanges.push(changeInfo);
    
    // 限制历史记录数量
    if (this.recentChanges.length > this.CHANGE_HISTORY_LIMIT) {
      this.recentChanges.shift();
    }

    // 清理过期记录
    this.cleanupOldChanges();
  }

  /**
   * 获取最近的变化
   */
  private getRecentChanges(): ChangeInfo[] {
    this.cleanupOldChanges();
    return [...this.recentChanges];
  }

  /**
   * 清理过期的变化记录
   */
  private cleanupOldChanges(): void {
    const now = Date.now();
    this.recentChanges = this.recentChanges.filter(
      change => now - new Date(change.timestamp).getTime() <= this.CHANGE_WINDOW
    );
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    recentChangesCount: number;
    changeTypes: Record<string, number>;
    averageAffectedGroups: number;
    averageAffectedTabs: number;
  } {
    const recentChanges = this.getRecentChanges();
    const changeTypes: Record<string, number> = {};
    let totalGroups = 0;
    let totalTabs = 0;

    recentChanges.forEach(change => {
      changeTypes[change.type] = (changeTypes[change.type] || 0) + 1;
      totalGroups += change.affectedGroups;
      totalTabs += change.affectedTabs;
    });

    return {
      recentChangesCount: recentChanges.length,
      changeTypes,
      averageAffectedGroups: recentChanges.length > 0 ? totalGroups / recentChanges.length : 0,
      averageAffectedTabs: recentChanges.length > 0 ? totalTabs / recentChanges.length : 0
    };
  }

  /**
   * 清除历史记录
   */
  clearHistory(): void {
    this.recentChanges = [];
    logger.debug('智能同步判断器历史记录已清除');
  }
}

/**
 * 全局智能同步判断器实例
 */
export const smartSyncJudge = new SmartSyncJudge();

/**
 * 便捷函数：判断是否应该同步
 */
export function shouldPerformRealtimeSync(
  changeInfo: ChangeInfo,
  systemState: SystemState,
  localData?: TabGroup[],
  remoteData?: TabGroup[]
): SyncJudgment {
  return smartSyncJudge.shouldPerformSync(changeInfo, systemState, localData, remoteData);
}
