/**
 * 数据冲突检测和解决工具
 */

import { TabGroup } from '@/shared/types/tab';
import { logger } from './logger';

export interface ConflictInfo {
  type: 'group_conflict' | 'tab_conflict' | 'settings_conflict';
  localData: any;
  remoteData: any;
  conflictFields: string[];
  timestamp: string;
}

export interface ConflictResolution {
  strategy: 'local' | 'remote' | 'merge' | 'manual';
  resolvedData?: any;
  needsUserInput?: boolean;
}

/**
 * 数据冲突解决器
 */
export class ConflictResolver {
  /**
   * 检测标签组数据冲突
   */
  detectGroupConflicts(localGroups: TabGroup[], remoteGroups: TabGroup[]): ConflictInfo[] {
    const conflicts: ConflictInfo[] = [];
    
    // 创建ID映射
    const localMap = new Map(localGroups.map(g => [g.id, g]));
    const remoteMap = new Map(remoteGroups.map(g => [g.id, g]));
    
    // 检查每个本地组
    for (const localGroup of localGroups) {
      const remoteGroup = remoteMap.get(localGroup.id);
      
      if (remoteGroup) {
        const conflictFields = this.compareGroups(localGroup, remoteGroup);
        
        if (conflictFields.length > 0) {
          conflicts.push({
            type: 'group_conflict',
            localData: localGroup,
            remoteData: remoteGroup,
            conflictFields,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }
    
    return conflicts;
  }
  
  /**
   * 比较两个标签组，返回冲突字段
   */
  private compareGroups(local: TabGroup, remote: TabGroup): string[] {
    const conflicts: string[] = [];
    
    // 比较基本字段
    if (local.name !== remote.name) conflicts.push('name');
    if (local.color !== remote.color) conflicts.push('color');
    if (local.isLocked !== remote.isLocked) conflicts.push('isLocked');
    
    // 比较更新时间
    const localTime = new Date(local.updatedAt).getTime();
    const remoteTime = new Date(remote.updatedAt).getTime();
    
    // 如果时间差超过1分钟，认为有冲突
    if (Math.abs(localTime - remoteTime) > 60000) {
      conflicts.push('updatedAt');
    }
    
    // 比较标签页数量
    if (local.tabs.length !== remote.tabs.length) {
      conflicts.push('tabs');
    } else {
      // 比较标签页内容
      for (let i = 0; i < local.tabs.length; i++) {
        const localTab = local.tabs[i];
        const remoteTab = remote.tabs[i];
        
        if (localTab.url !== remoteTab.url || localTab.title !== remoteTab.title) {
          conflicts.push('tabs');
          break;
        }
      }
    }
    
    return conflicts;
  }
  
  /**
   * 自动解决冲突
   */
  autoResolveConflict(conflict: ConflictInfo): ConflictResolution {
    const { localData, remoteData, conflictFields } = conflict;
    
    // 基于时间戳的自动解决策略
    const localTime = new Date(localData.updatedAt).getTime();
    const remoteTime = new Date(remoteData.updatedAt).getTime();
    
    // 如果远程数据更新，使用远程数据
    if (remoteTime > localTime + 30000) { // 30秒容差
      return {
        strategy: 'remote',
        resolvedData: remoteData,
      };
    }
    
    // 如果本地数据更新，使用本地数据
    if (localTime > remoteTime + 30000) {
      return {
        strategy: 'local',
        resolvedData: localData,
      };
    }
    
    // 时间相近，尝试智能合并
    if (this.canAutoMerge(conflictFields)) {
      const mergedData = this.mergeData(localData, remoteData, conflictFields);
      return {
        strategy: 'merge',
        resolvedData: mergedData,
      };
    }
    
    // 无法自动解决，需要用户干预
    return {
      strategy: 'manual',
      needsUserInput: true,
    };
  }
  
  /**
   * 检查是否可以自动合并
   */
  private canAutoMerge(conflictFields: string[]): boolean {
    // 只有非关键字段冲突时才能自动合并
    const criticalFields = ['name', 'tabs'];
    return !conflictFields.some(field => criticalFields.includes(field));
  }
  
  /**
   * 合并数据
   */
  private mergeData(localData: any, remoteData: any, conflictFields: string[]): any {
    const merged = { ...localData };
    
    // 合并策略：优先使用最新的非空值
    for (const field of conflictFields) {
      if (field === 'color' && remoteData.color && remoteData.color !== '#default') {
        merged.color = remoteData.color;
      }
      
      if (field === 'isLocked') {
        // 锁定状态：优先保持锁定
        merged.isLocked = localData.isLocked || remoteData.isLocked;
      }
      
      if (field === 'updatedAt') {
        // 使用最新的时间戳
        const localTime = new Date(localData.updatedAt).getTime();
        const remoteTime = new Date(remoteData.updatedAt).getTime();
        merged.updatedAt = localTime > remoteTime ? localData.updatedAt : remoteData.updatedAt;
      }
    }
    
    return merged;
  }
  
  /**
   * 批量解决冲突
   */
  async resolveConflicts(conflicts: ConflictInfo[]): Promise<ConflictResolution[]> {
    const resolutions: ConflictResolution[] = [];
    
    for (const conflict of conflicts) {
      try {
        const resolution = this.autoResolveConflict(conflict);
        resolutions.push(resolution);
        
        logger.debug('冲突解决', {
          type: conflict.type,
          strategy: resolution.strategy,
          needsUserInput: resolution.needsUserInput,
        });
      } catch (error) {
        logger.error('解决冲突失败', error, { conflict });
        resolutions.push({
          strategy: 'manual',
          needsUserInput: true,
        });
      }
    }
    
    return resolutions;
  }
  
  /**
   * 生成冲突报告
   */
  generateConflictReport(conflicts: ConflictInfo[]): string {
    if (conflicts.length === 0) {
      return '没有检测到数据冲突';
    }
    
    const report = conflicts.map(conflict => {
      const { type, conflictFields } = conflict;
      return `${type}: ${conflictFields.join(', ')}`;
    }).join('\n');
    
    return `检测到 ${conflicts.length} 个冲突:\n${report}`;
  }
}

// 导出单例实例
export const conflictResolver = new ConflictResolver();
