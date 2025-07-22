/**
 * 简化乐观锁同步服务
 * 专注于OneTabPlus的实际需求，避免过度复杂化
 */

import { TabGroup, Tab } from '@/shared/types/tab';
import { logger } from '@/shared/utils/logger';

export interface SimpleVersionedTabGroup extends TabGroup {
  version: number;
}

export interface ConflictResolution {
  strategy: 'last_modified' | 'user_choice' | 'conservative_merge';
  result: SimpleVersionedTabGroup;
  needsUserInput?: boolean;
  conflictInfo?: {
    localChanges: string[];
    remoteChanges: string[];
    recommendation: string;
  };
}

export class SimpleOptimisticLockService {
  /**
   * 检测版本冲突
   */
  detectConflict(local: SimpleVersionedTabGroup, remote: SimpleVersionedTabGroup): boolean {
    return local.version !== remote.version;
  }

  /**
   * 处理冲突 - 核心方法
   */
  async resolveConflict(
    local: SimpleVersionedTabGroup, 
    remote: SimpleVersionedTabGroup,
    strategy: 'auto' | 'last_modified' | 'conservative_merge' | 'user_choice' = 'auto'
  ): Promise<ConflictResolution> {
    
    logger.info('处理版本冲突', {
      localVersion: local.version,
      remoteVersion: remote.version,
      strategy
    });

    // 自动选择策略
    if (strategy === 'auto') {
      strategy = this.selectBestStrategy(local, remote);
    }

    switch (strategy) {
      case 'last_modified':
        return this.lastModifiedStrategy(local, remote);
      
      case 'conservative_merge':
        return this.conservativeMergeStrategy(local, remote);
      
      case 'user_choice':
        return this.userChoiceStrategy(local, remote);
      
      default:
        return this.lastModifiedStrategy(local, remote);
    }
  }

  /**
   * 自动选择最佳策略
   */
  private selectBestStrategy(
    local: SimpleVersionedTabGroup, 
    remote: SimpleVersionedTabGroup
  ): 'last_modified' | 'conservative_merge' | 'user_choice' {
    
    const localTime = new Date(local.updatedAt).getTime();
    const remoteTime = new Date(remote.updatedAt).getTime();
    const timeDiff = Math.abs(localTime - remoteTime);
    
    // 如果修改时间很接近（5分钟内），可能是真正的并发冲突
    if (timeDiff < 5 * 60 * 1000) {
      const changeComplexity = this.analyzeChangeComplexity(local, remote);
      
      if (changeComplexity === 'simple') {
        return 'conservative_merge';
      } else {
        return 'user_choice';
      }
    }
    
    // 时间差较大，使用最后修改优先
    return 'last_modified';
  }

  /**
   * 分析变更复杂度
   */
  private analyzeChangeComplexity(
    local: SimpleVersionedTabGroup, 
    remote: SimpleVersionedTabGroup
  ): 'simple' | 'complex' {
    
    // 检查是否只是简单的添加操作
    const localTabIds = new Set(local.tabs.map(t => t.id));
    const remoteTabIds = new Set(remote.tabs.map(t => t.id));
    
    const localOnlyTabs = local.tabs.filter(t => !remoteTabIds.has(t.id));
    const remoteOnlyTabs = remote.tabs.filter(t => !localTabIds.has(t.id));
    
    // 如果只是单纯的添加新标签，认为是简单变更
    if (localOnlyTabs.length > 0 && remoteOnlyTabs.length > 0 && 
        local.name === remote.name) {
      return 'simple';
    }
    
    return 'complex';
  }

  /**
   * 最后修改优先策略
   */
  private lastModifiedStrategy(
    local: SimpleVersionedTabGroup, 
    remote: SimpleVersionedTabGroup
  ): ConflictResolution {
    
    const localTime = new Date(local.updatedAt).getTime();
    const remoteTime = new Date(remote.updatedAt).getTime();
    
    const winner = remoteTime > localTime ? remote : local;
    const result = {
      ...winner,
      version: Math.max(local.version, remote.version) + 1,
      updatedAt: new Date().toISOString()
    };

    return {
      strategy: 'last_modified',
      result,
      needsUserInput: false
    };
  }

  /**
   * 保守合并策略 - 倾向于保留更多数据
   */
  private conservativeMergeStrategy(
    local: SimpleVersionedTabGroup, 
    remote: SimpleVersionedTabGroup
  ): ConflictResolution {
    
    // 合并标签列表 - 保留所有标签，去重
    const allTabs = new Map<string, Tab>();
    
    // 先添加本地标签
    local.tabs.forEach(tab => {
      allTabs.set(tab.id, tab);
    });
    
    // 再添加远程标签，如果URL相同但ID不同，保留较新的
    remote.tabs.forEach(remoteTab => {
      const existingTab = allTabs.get(remoteTab.id);
      
      if (!existingTab) {
        // 检查是否有相同URL的标签
        const duplicateTab = Array.from(allTabs.values())
          .find(tab => tab.url === remoteTab.url);
        
        if (!duplicateTab) {
          allTabs.set(remoteTab.id, remoteTab);
        } else {
          // 保留较新的标签
          const remoteTime = new Date(remoteTab.updatedAt || remoteTab.createdAt).getTime();
          const existingTime = new Date(duplicateTab.updatedAt || duplicateTab.createdAt).getTime();
          
          if (remoteTime > existingTime) {
            allTabs.delete(duplicateTab.id);
            allTabs.set(remoteTab.id, remoteTab);
          }
        }
      } else {
        // 同ID标签，保留较新的
        const remoteTime = new Date(remoteTab.updatedAt || remoteTab.createdAt).getTime();
        const localTime = new Date(existingTab.updatedAt || existingTab.createdAt).getTime();
        
        if (remoteTime > localTime) {
          allTabs.set(remoteTab.id, remoteTab);
        }
      }
    });

    // 选择标签组名称 - 使用较新的
    const localTime = new Date(local.updatedAt).getTime();
    const remoteTime = new Date(remote.updatedAt).getTime();
    const name = remoteTime > localTime ? remote.name : local.name;

    const result: SimpleVersionedTabGroup = {
      ...local,
      name,
      tabs: Array.from(allTabs.values()),
      version: Math.max(local.version, remote.version) + 1,
      updatedAt: new Date().toISOString()
    };

    return {
      strategy: 'conservative_merge',
      result,
      needsUserInput: false
    };
  }

  /**
   * 用户选择策略
   */
  private userChoiceStrategy(
    local: SimpleVersionedTabGroup, 
    remote: SimpleVersionedTabGroup
  ): ConflictResolution {
    
    const localChanges = this.describeChanges(local);
    const remoteChanges = this.describeChanges(remote);
    
    return {
      strategy: 'user_choice',
      result: local, // 临时返回本地版本
      needsUserInput: true,
      conflictInfo: {
        localChanges,
        remoteChanges,
        recommendation: this.generateRecommendation(local, remote)
      }
    };
  }

  /**
   * 描述变更内容
   */
  private describeChanges(group: SimpleVersionedTabGroup): string[] {
    const changes: string[] = [];
    
    if (group.tabs.length > 0) {
      changes.push(`包含 ${group.tabs.length} 个标签`);
    }
    
    changes.push(`最后修改时间: ${new Date(group.updatedAt).toLocaleString()}`);
    
    return changes;
  }

  /**
   * 生成推荐建议
   */
  private generateRecommendation(
    local: SimpleVersionedTabGroup, 
    remote: SimpleVersionedTabGroup
  ): string {
    
    if (local.tabs.length > remote.tabs.length) {
      return '建议选择本地版本，因为包含更多标签';
    } else if (remote.tabs.length > local.tabs.length) {
      return '建议选择远程版本，因为包含更多标签';
    } else {
      const localTime = new Date(local.updatedAt).getTime();
      const remoteTime = new Date(remote.updatedAt).getTime();
      
      return remoteTime > localTime ? 
        '建议选择远程版本，因为修改时间更新' : 
        '建议选择本地版本，因为修改时间更新';
    }
  }

  /**
   * 用户手动解决冲突
   */
  async userResolveConflict(
    local: SimpleVersionedTabGroup,
    remote: SimpleVersionedTabGroup,
    userChoice: 'local' | 'remote' | 'merge'
  ): Promise<SimpleVersionedTabGroup> {
    
    let result: SimpleVersionedTabGroup;
    
    switch (userChoice) {
      case 'local':
        result = { ...local };
        break;
      case 'remote':
        result = { ...remote };
        break;
      case 'merge':
        const mergeResult = this.conservativeMergeStrategy(local, remote);
        result = mergeResult.result;
        break;
      default:
        result = { ...local };
    }
    
    result.version = Math.max(local.version, remote.version) + 1;
    result.updatedAt = new Date().toISOString();
    
    return result;
  }
}

export const simpleOptimisticLock = new SimpleOptimisticLockService();
