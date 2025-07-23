/**
 * 时间戳比较工具
 * 替代复杂的版本号管理，提供基于时间戳的数据比较和合并功能
 */

import { TabGroup, Tab } from '@/shared/types/tab';
import { logger } from './logger';

/**
 * 时间戳比较结果
 */
export interface TimestampComparisonResult {
  isNewer: boolean;
  isOlder: boolean;
  isEqual: boolean;
  timeDifference: number; // 毫秒差值，正数表示第一个更新
}

/**
 * 合并策略枚举
 */
export enum MergeStrategy {
  LATEST_WINS = 'latest_wins',           // 最新优先
  SMART_MERGE = 'smart_merge',           // 智能合并
  LOCAL_PRIORITY = 'local_priority',     // 本地优先
  REMOTE_PRIORITY = 'remote_priority'    // 远程优先
}

/**
 * 合并结果
 */
export interface MergeResult<T> {
  merged: T;
  strategy: MergeStrategy;
  conflicts: string[];
  metadata: {
    mergeTime: string;
    sourceLocal: boolean;
    sourceRemote: boolean;
    hasConflicts: boolean;
  };
}

/**
 * 时间戳缓存，避免重复解析
 */
class TimestampCache {
  private cache = new Map<string, number>();
  private readonly MAX_CACHE_SIZE = 1000;

  getTimestamp(dateString: string): number {
    if (!this.cache.has(dateString)) {
      // 清理缓存，防止内存泄漏
      if (this.cache.size >= this.MAX_CACHE_SIZE) {
        this.cache.clear();
      }
      
      const timestamp = new Date(dateString).getTime();
      this.cache.set(dateString, timestamp);
    }
    return this.cache.get(dateString)!;
  }

  clear(): void {
    this.cache.clear();
  }
}

/**
 * 时间戳比较器类
 */
export class TimestampComparator {
  private cache = new TimestampCache();
  private readonly CLOCK_SKEW_TOLERANCE = 60000; // 1分钟时钟偏差容忍
  private readonly RECENT_CHANGE_THRESHOLD = 5 * 60 * 1000; // 5分钟内的变化认为是最近的

  /**
   * 比较两个时间戳
   */
  compareTimestamps(timestamp1: string, timestamp2: string): TimestampComparisonResult {
    const time1 = this.cache.getTimestamp(timestamp1);
    const time2 = this.cache.getTimestamp(timestamp2);
    const difference = time1 - time2;

    // 考虑时钟偏差，在容忍范围内认为相等
    const isEqual = Math.abs(difference) <= this.CLOCK_SKEW_TOLERANCE;

    return {
      isNewer: !isEqual && difference > 0,
      isOlder: !isEqual && difference < 0,
      isEqual,
      timeDifference: difference
    };
  }

  /**
   * 比较TabGroup的更新时间
   */
  compareTabGroups(local: TabGroup, remote: TabGroup): TimestampComparisonResult {
    return this.compareTimestamps(local.updatedAt, remote.updatedAt);
  }

  /**
   * 检查是否为最近的变化
   */
  isRecentChange(timestamp: string, referenceTime?: string): boolean {
    const changeTime = this.cache.getTimestamp(timestamp);
    const refTime = referenceTime ? 
      this.cache.getTimestamp(referenceTime) : 
      Date.now();

    return Math.abs(changeTime - refTime) <= this.RECENT_CHANGE_THRESHOLD;
  }

  /**
   * 验证时间戳的有效性
   */
  validateTimestamp(timestamp: string): boolean {
    try {
      const time = this.cache.getTimestamp(timestamp);
      const now = Date.now();

      // 检查时间戳是否合理
      return time > 0 && 
             time <= now + this.CLOCK_SKEW_TOLERANCE && // 不能太未来
             time >= now - (365 * 24 * 60 * 60 * 1000); // 不能超过一年前
    } catch {
      return false;
    }
  }

  /**
   * 清理缓存
   */
  clearCache(): void {
    this.cache.clear();
  }
}

/**
 * 数据合并器类
 */
export class DataMerger {
  private comparator = new TimestampComparator();

  /**
   * 合并两个TabGroup
   */
  mergeTabGroups(
    local: TabGroup, 
    remote: TabGroup, 
    strategy: MergeStrategy = MergeStrategy.LATEST_WINS
  ): MergeResult<TabGroup> {
    const comparison = this.comparator.compareTabGroups(local, remote);
    const conflicts: string[] = [];
    const mergeTime = new Date().toISOString();

    let merged: TabGroup;

    switch (strategy) {
      case MergeStrategy.LATEST_WINS:
        merged = this.mergeByLatest(local, remote, comparison, conflicts);
        break;
      
      case MergeStrategy.SMART_MERGE:
        merged = this.mergeBySmartStrategy(local, remote, comparison, conflicts);
        break;
      
      case MergeStrategy.LOCAL_PRIORITY:
        merged = this.mergeWithLocalPriority(local, remote, conflicts);
        break;
      
      case MergeStrategy.REMOTE_PRIORITY:
        merged = this.mergeWithRemotePriority(local, remote, conflicts);
        break;
      
      default:
        merged = this.mergeByLatest(local, remote, comparison, conflicts);
    }

    // 更新合并后的时间戳
    merged.updatedAt = mergeTime;
    merged.lastSyncedAt = mergeTime;

    return {
      merged,
      strategy,
      conflicts,
      metadata: {
        mergeTime,
        sourceLocal: true,
        sourceRemote: true,
        hasConflicts: conflicts.length > 0
      }
    };
  }

  /**
   * 最新优先合并策略
   */
  private mergeByLatest(
    local: TabGroup, 
    remote: TabGroup, 
    comparison: TimestampComparisonResult,
    conflicts: string[]
  ): TabGroup {
    // 选择更新的数据作为基础
    const base = comparison.isNewer ? local : remote;
    const other = comparison.isNewer ? remote : local;

    // 如果时间戳相等，检查内容差异
    if (comparison.isEqual) {
      return this.mergeEqualTimestamps(local, remote, conflicts);
    }

    // 记录被覆盖的冲突
    if (this.hasContentDifference(base, other)) {
      conflicts.push(`使用${comparison.isNewer ? '本地' : '远程'}数据覆盖${comparison.isNewer ? '远程' : '本地'}数据`);
    }

    return { ...base };
  }

  /**
   * 智能合并策略
   */
  private mergeBySmartStrategy(
    local: TabGroup, 
    remote: TabGroup, 
    comparison: TimestampComparisonResult,
    conflicts: string[]
  ): TabGroup {
    // 如果时间差很小，尝试合并内容
    if (Math.abs(comparison.timeDifference) <= 5 * 60 * 1000) { // 5分钟内
      return this.mergeContentIntelligently(local, remote, conflicts);
    }

    // 否则使用最新优先
    return this.mergeByLatest(local, remote, comparison, conflicts);
  }

  /**
   * 本地优先合并策略
   */
  private mergeWithLocalPriority(local: TabGroup, remote: TabGroup, conflicts: string[]): TabGroup {
    if (this.hasContentDifference(local, remote)) {
      conflicts.push('使用本地数据，忽略远程变化');
    }
    return { ...local };
  }

  /**
   * 远程优先合并策略
   */
  private mergeWithRemotePriority(local: TabGroup, remote: TabGroup, conflicts: string[]): TabGroup {
    if (this.hasContentDifference(local, remote)) {
      conflicts.push('使用远程数据，忽略本地变化');
    }
    return { ...remote };
  }

  /**
   * 时间戳相等时的合并处理
   */
  private mergeEqualTimestamps(local: TabGroup, remote: TabGroup, conflicts: string[]): TabGroup {
    // 检查是否有实际的内容差异
    if (!this.hasContentDifference(local, remote)) {
      return { ...local }; // 内容相同，返回任意一个
    }

    // 有内容差异，尝试智能合并
    return this.mergeContentIntelligently(local, remote, conflicts);
  }

  /**
   * 智能内容合并
   */
  private mergeContentIntelligently(local: TabGroup, remote: TabGroup, conflicts: string[]): TabGroup {
    // 合并标签页（去重）
    const mergedTabs = this.mergeTabs(local.tabs, remote.tabs, conflicts);

    // 选择较新的元数据
    const localTime = new Date(local.updatedAt).getTime();
    const remoteTime = new Date(remote.updatedAt).getTime();
    const useRemoteMeta = remoteTime >= localTime;

    return {
      ...local,
      name: useRemoteMeta ? remote.name : local.name,
      isLocked: useRemoteMeta ? remote.isLocked : local.isLocked,
      tabs: mergedTabs,
      // 保留较早的创建时间
      createdAt: new Date(local.createdAt).getTime() <= new Date(remote.createdAt).getTime() 
        ? local.createdAt 
        : remote.createdAt
    };
  }

  /**
   * 合并标签页数组
   */
  private mergeTabs(localTabs: Tab[], remoteTabs: Tab[], conflicts: string[]): Tab[] {
    const tabMap = new Map<string, Tab>();
    let duplicateCount = 0;

    // 添加本地标签页
    localTabs.forEach(tab => {
      tabMap.set(tab.url, tab);
    });

    // 添加远程标签页，处理重复
    remoteTabs.forEach(tab => {
      const existing = tabMap.get(tab.url);
      if (existing) {
        // URL重复，选择较新的标签页
        const existingTime = new Date(existing.updatedAt || existing.createdAt).getTime();
        const newTime = new Date(tab.updatedAt || tab.createdAt).getTime();
        
        if (newTime > existingTime) {
          tabMap.set(tab.url, tab);
        }
        duplicateCount++;
      } else {
        tabMap.set(tab.url, tab);
      }
    });

    if (duplicateCount > 0) {
      conflicts.push(`合并了 ${duplicateCount} 个重复的标签页`);
    }

    return Array.from(tabMap.values());
  }

  /**
   * 检查内容差异
   */
  private hasContentDifference(local: TabGroup, remote: TabGroup): boolean {
    // 检查基本属性
    if (local.name !== remote.name || local.isLocked !== remote.isLocked) {
      return true;
    }

    // 检查标签页数量
    if (local.tabs.length !== remote.tabs.length) {
      return true;
    }

    // 检查标签页URL集合
    const localUrls = new Set(local.tabs.map(tab => tab.url));
    const remoteUrls = new Set(remote.tabs.map(tab => tab.url));

    if (localUrls.size !== remoteUrls.size) {
      return true;
    }

    // 检查URL是否完全匹配
    for (const url of localUrls) {
      if (!remoteUrls.has(url)) {
        return true;
      }
    }

    return false;
  }

  /**
   * 批量合并TabGroup数组
   */
  mergeTabGroupArrays(
    localGroups: TabGroup[], 
    remoteGroups: TabGroup[], 
    strategy: MergeStrategy = MergeStrategy.LATEST_WINS
  ): { merged: TabGroup[]; conflicts: string[]; stats: { total: number; conflicts: number; merged: number } } {
    const mergedMap = new Map<string, TabGroup>();
    const allConflicts: string[] = [];
    let conflictCount = 0;
    let mergeCount = 0;

    // 添加本地组
    localGroups.forEach(group => {
      mergedMap.set(group.id, group);
    });

    // 处理远程组
    remoteGroups.forEach(remoteGroup => {
      const localGroup = mergedMap.get(remoteGroup.id);
      
      if (localGroup) {
        // 存在冲突，需要合并
        const mergeResult = this.mergeTabGroups(localGroup, remoteGroup, strategy);
        mergedMap.set(remoteGroup.id, mergeResult.merged);
        
        if (mergeResult.conflicts.length > 0) {
          allConflicts.push(`标签组 "${remoteGroup.name}": ${mergeResult.conflicts.join(', ')}`);
          conflictCount++;
        }
        mergeCount++;
      } else {
        // 远程独有的组，直接添加
        mergedMap.set(remoteGroup.id, {
          ...remoteGroup,
          lastSyncedAt: new Date().toISOString()
        });
      }
    });

    return {
      merged: Array.from(mergedMap.values()),
      conflicts: allConflicts,
      stats: {
        total: mergedMap.size,
        conflicts: conflictCount,
        merged: mergeCount
      }
    };
  }
}

// 导出单例实例
export const timestampComparator = new TimestampComparator();
export const dataMerger = new DataMerger();

// 便捷函数
export function compareByTimestamp(timestamp1: string, timestamp2: string): TimestampComparisonResult {
  return timestampComparator.compareTimestamps(timestamp1, timestamp2);
}

export function mergeByTimestamp<T extends TabGroup>(
  local: T, 
  remote: T, 
  strategy: MergeStrategy = MergeStrategy.LATEST_WINS
): MergeResult<T> {
  return dataMerger.mergeTabGroups(local, remote, strategy) as MergeResult<T>;
}
