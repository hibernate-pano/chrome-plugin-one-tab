/**
 * 冲突检测服务
 * 检测和处理同步冲突，提供用户友好的冲突解决方案
 */

import { TabGroup } from '@/shared/types/tab';
import { logger } from '@/shared/utils/logger';

export interface ConflictInfo {
  type: 'timestamp_conflict' | 'data_conflict' | 'device_conflict';
  localData: TabGroup;
  remoteData: TabGroup;
  conflictTime: string;
  severity: 'low' | 'medium' | 'high';
}

export class ConflictDetectionService {
  /**
   * 检测时间戳冲突
   */
  detectTimestampConflict(local: TabGroup, remote: TabGroup): ConflictInfo | null {
    const localTime = new Date(local.updatedAt).getTime();
    const remoteTime = new Date(remote.updatedAt).getTime();
    const timeDiff = Math.abs(localTime - remoteTime);
    
    // 如果时间差异小于5分钟且数据不同，可能是时钟不同步导致的冲突
    if (timeDiff < 5 * 60 * 1000 && this.hasDataDifference(local, remote)) {
      return {
        type: 'timestamp_conflict',
        localData: local,
        remoteData: remote,
        conflictTime: new Date().toISOString(),
        severity: 'medium'
      };
    }
    
    return null;
  }

  /**
   * 检测数据差异
   */
  private hasDataDifference(local: TabGroup, remote: TabGroup): boolean {
    // 比较标签组名称
    if (local.name !== remote.name) return true;
    
    // 比较标签数量
    if (local.tabs.length !== remote.tabs.length) return true;
    
    // 比较标签内容（简化版）
    for (let i = 0; i < Math.min(local.tabs.length, remote.tabs.length); i++) {
      if (local.tabs[i].url !== remote.tabs[i].url) return true;
      if (local.tabs[i].title !== remote.tabs[i].title) return true;
    }
    
    return false;
  }

  /**
   * 智能冲突解决
   */
  resolveConflict(conflict: ConflictInfo): TabGroup {
    logger.warn('检测到同步冲突', conflict);
    
    switch (conflict.type) {
      case 'timestamp_conflict':
        return this.resolveTimestampConflict(conflict);
      case 'data_conflict':
        return this.resolveDataConflict(conflict);
      default:
        // 默认使用"最后修改优先"策略
        return this.useLastModifiedStrategy(conflict.localData, conflict.remoteData);
    }
  }

  /**
   * 解决时间戳冲突
   */
  private resolveTimestampConflict(conflict: ConflictInfo): TabGroup {
    const { localData, remoteData } = conflict;
    
    // 如果本地数据更完整（标签更多），优先使用本地数据
    if (localData.tabs.length > remoteData.tabs.length) {
      logger.info('使用本地数据（数据更完整）');
      return { ...localData, updatedAt: new Date().toISOString() };
    }
    
    // 否则使用远程数据
    logger.info('使用远程数据');
    return remoteData;
  }

  /**
   * 解决数据冲突
   */
  private resolveDataConflict(conflict: ConflictInfo): TabGroup {
    const { localData, remoteData } = conflict;
    
    // 尝试合并标签（去重）
    const mergedTabs = [...localData.tabs];
    const localUrls = new Set(localData.tabs.map(tab => tab.url));
    
    // 添加远程数据中本地没有的标签
    remoteData.tabs.forEach(remoteTab => {
      if (!localUrls.has(remoteTab.url)) {
        mergedTabs.push(remoteTab);
      }
    });
    
    return {
      ...localData,
      tabs: mergedTabs,
      updatedAt: new Date().toISOString(),
      name: remoteData.updatedAt > localData.updatedAt ? remoteData.name : localData.name
    };
  }

  /**
   * 使用"最后修改优先"策略
   */
  private useLastModifiedStrategy(local: TabGroup, remote: TabGroup): TabGroup {
    const localTime = new Date(local.updatedAt).getTime();
    const remoteTime = new Date(remote.updatedAt).getTime();
    
    return localTime > remoteTime ? local : remote;
  }
}

export const conflictDetection = new ConflictDetectionService();
