/**
 * 乐观锁同步服务
 * 实现基于版本号的冲突检测和智能合并
 */

import { TabGroup, Tab } from '@/shared/types/tab';
import { logger } from '@/shared/utils/logger';

export interface VersionedTabGroup extends TabGroup {
  version: number;
  baseVersion?: number;
  contentHash?: string;
}

export interface MergeResult {
  success: boolean;
  merged?: VersionedTabGroup;
  conflicts?: ConflictInfo[];
  needsUserInput?: boolean;
}

export interface ConflictInfo {
  type: 'name_conflict' | 'tab_conflict' | 'order_conflict';
  description: string;
  localValue: any;
  remoteValue: any;
  baseValue?: any;
}

export class OptimisticLockSyncService {
  /**
   * 检测版本冲突
   */
  detectVersionConflict(local: VersionedTabGroup, remote: VersionedTabGroup): boolean {
    // 如果本地版本不是基于远程的当前版本，说明有冲突
    return local.baseVersion !== remote.version;
  }

  /**
   * 三路合并算法（简化版Git合并）
   */
  async threeWayMerge(
    base: VersionedTabGroup | null,
    local: VersionedTabGroup,
    remote: VersionedTabGroup
  ): Promise<MergeResult> {
    logger.info('开始三路合并', {
      baseVersion: base?.version,
      localVersion: local.version,
      remoteVersion: remote.version
    });

    const conflicts: ConflictInfo[] = [];
    let merged = { ...local };

    // 1. 合并标签组名称
    const nameResult = this.mergeName(base, local, remote);
    if (nameResult.conflict) {
      conflicts.push(nameResult.conflict);
    } else {
      merged.name = nameResult.value;
    }

    // 2. 合并标签列表
    const tabsResult = this.mergeTabs(base, local, remote);
    if (tabsResult.conflicts.length > 0) {
      conflicts.push(...tabsResult.conflicts);
    } else {
      merged.tabs = tabsResult.value;
    }

    // 3. 更新版本信息
    merged.version = Math.max(local.version, remote.version) + 1;
    merged.baseVersion = remote.version;
    merged.contentHash = this.calculateHash(merged);
    merged.updatedAt = new Date().toISOString();

    return {
      success: conflicts.length === 0,
      merged: conflicts.length === 0 ? merged : undefined,
      conflicts,
      needsUserInput: conflicts.some(c => c.type === 'name_conflict')
    };
  }

  /**
   * 合并标签组名称
   */
  private mergeName(
    base: VersionedTabGroup | null,
    local: VersionedTabGroup,
    remote: VersionedTabGroup
  ): { value: string; conflict?: ConflictInfo } {
    // 如果名称相同，无冲突
    if (local.name === remote.name) {
      return { value: local.name };
    }

    // 如果没有基础版本，使用远程版本（保守策略）
    if (!base) {
      return { value: remote.name };
    }

    // 检查谁修改了名称
    const localChanged = local.name !== base.name;
    const remoteChanged = remote.name !== base.name;

    if (localChanged && !remoteChanged) {
      // 只有本地修改了名称
      return { value: local.name };
    } else if (!localChanged && remoteChanged) {
      // 只有远程修改了名称
      return { value: remote.name };
    } else if (localChanged && remoteChanged) {
      // 双方都修改了名称，产生冲突
      return {
        value: local.name, // 临时使用本地值
        conflict: {
          type: 'name_conflict',
          description: '标签组名称在多个设备上被同时修改',
          localValue: local.name,
          remoteValue: remote.name,
          baseValue: base.name
        }
      };
    }

    return { value: base.name };
  }

  /**
   * 合并标签列表
   */
  private mergeTabs(
    base: VersionedTabGroup | null,
    local: VersionedTabGroup,
    remote: VersionedTabGroup
  ): { value: Tab[]; conflicts: ConflictInfo[] } {
    const conflicts: ConflictInfo[] = [];
    
    // 创建标签映射
    const localTabsMap = new Map(local.tabs.map(tab => [tab.id, tab]));
    const remoteTabsMap = new Map(remote.tabs.map(tab => [tab.id, tab]));
    const baseTabsMap = base ? new Map(base.tabs.map(tab => [tab.id, tab])) : new Map();

    // 收集所有标签ID
    const allTabIds = new Set([
      ...localTabsMap.keys(),
      ...remoteTabsMap.keys(),
      ...baseTabsMap.keys()
    ]);

    const mergedTabs: Tab[] = [];

    for (const tabId of allTabIds) {
      const localTab = localTabsMap.get(tabId);
      const remoteTab = remoteTabsMap.get(tabId);
      const baseTab = baseTabsMap.get(tabId);

      if (localTab && remoteTab) {
        // 标签在两边都存在，检查是否有冲突
        if (this.tabsEqual(localTab, remoteTab)) {
          mergedTabs.push(localTab);
        } else {
          // 有差异，尝试合并
          const mergedTab = this.mergeTab(baseTab, localTab, remoteTab);
          mergedTabs.push(mergedTab);
        }
      } else if (localTab && !remoteTab) {
        // 标签只在本地存在
        if (!baseTab) {
          // 本地新增的标签
          mergedTabs.push(localTab);
        } else {
          // 远程删除了标签，本地保留了，这是一个潜在冲突
          // 但对于标签管理，倾向于保留数据
          mergedTabs.push(localTab);
        }
      } else if (!localTab && remoteTab) {
        // 标签只在远程存在
        if (!baseTab) {
          // 远程新增的标签
          mergedTabs.push(remoteTab);
        } else {
          // 本地删除了标签，远程保留了
          // 倾向于保留数据
          mergedTabs.push(remoteTab);
        }
      }
    }

    // 尝试保持合理的顺序
    const orderedTabs = this.mergeTabOrder(base, local, remote, mergedTabs);

    return { value: orderedTabs, conflicts };
  }

  /**
   * 合并单个标签
   */
  private mergeTab(base: Tab | undefined, local: Tab, remote: Tab): Tab {
    return {
      ...local,
      title: remote.updatedAt > local.updatedAt ? remote.title : local.title,
      url: remote.updatedAt > local.updatedAt ? remote.url : local.url,
      updatedAt: new Date().toISOString()
    };
  }

  /**
   * 检查两个标签是否相等
   */
  private tabsEqual(tab1: Tab, tab2: Tab): boolean {
    return tab1.url === tab2.url && 
           tab1.title === tab2.title && 
           tab1.favIconUrl === tab2.favIconUrl;
  }

  /**
   * 合并标签顺序
   */
  private mergeTabOrder(
    base: VersionedTabGroup | null,
    local: VersionedTabGroup,
    remote: VersionedTabGroup,
    mergedTabs: Tab[]
  ): Tab[] {
    // 简化策略：如果远程修改时间更新，使用远程顺序，否则使用本地顺序
    const useRemoteOrder = remote.updatedAt > local.updatedAt;
    const referenceOrder = useRemoteOrder ? remote.tabs : local.tabs;
    
    // 按照参考顺序重新排列合并后的标签
    const orderedTabs: Tab[] = [];
    const remainingTabs = new Map(mergedTabs.map(tab => [tab.id, tab]));

    // 首先按参考顺序添加标签
    for (const refTab of referenceOrder) {
      const tab = remainingTabs.get(refTab.id);
      if (tab) {
        orderedTabs.push(tab);
        remainingTabs.delete(refTab.id);
      }
    }

    // 添加剩余的标签（新增的标签）
    orderedTabs.push(...remainingTabs.values());

    return orderedTabs;
  }

  /**
   * 计算内容哈希
   */
  private calculateHash(group: VersionedTabGroup): string {
    const content = {
      name: group.name,
      tabs: group.tabs.map(tab => ({ id: tab.id, url: tab.url, title: tab.title }))
    };
    
    // 简化的哈希计算
    const str = JSON.stringify(content);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // 转换为32位整数
    }
    return hash.toString(36);
  }

  /**
   * 自动解决简单冲突
   */
  async autoResolveConflicts(conflicts: ConflictInfo[]): Promise<ConflictInfo[]> {
    const unresolved: ConflictInfo[] = [];

    for (const conflict of conflicts) {
      switch (conflict.type) {
        case 'order_conflict':
          // 顺序冲突通常可以自动解决
          break;
        case 'tab_conflict':
          // 标签冲突可以尝试自动合并
          break;
        case 'name_conflict':
          // 名称冲突需要用户介入
          unresolved.push(conflict);
          break;
        default:
          unresolved.push(conflict);
      }
    }

    return unresolved;
  }
}

export const optimisticLockSync = new OptimisticLockSyncService();
