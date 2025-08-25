/**
 * 同步调试日志工具
 * 专门用于调试去重操作后的数据同步异常问题
 */

import { TabGroup } from '@/shared/types/tab';
import { logger } from '@/shared/utils/logger';

export interface SyncDebugSnapshot {
  timestamp: string;
  operation: string;
  localCount: number;
  cloudCount: number;
  localGroups: TabGroup[];
  cloudGroups?: TabGroup[];
  mergedGroups?: TabGroup[];
  conflicts?: any[];
  metadata: {
    deviceId?: string;
    userId?: string;
    syncMethod?: string;
    triggerSource?: string;
  };
}

/**
 * 同步调试日志器类
 */
export class SyncDebugLogger {
  private snapshots: SyncDebugSnapshot[] = [];
  private readonly MAX_SNAPSHOTS = 20;
  private isEnabled = process.env.NODE_ENV === 'development';

  /**
   * 记录同步快照
   */
  async recordSnapshot(
    operation: string,
    localGroups: TabGroup[],
    cloudGroups?: TabGroup[],
    mergedGroups?: TabGroup[],
    metadata: Partial<SyncDebugSnapshot['metadata']> = {}
  ): Promise<void> {
    if (!this.isEnabled) return;

    const snapshot: SyncDebugSnapshot = {
      timestamp: new Date().toISOString(),
      operation,
      localCount: localGroups.length,
      cloudCount: cloudGroups?.length || 0,
      localGroups: this.sanitizeGroups(localGroups),
      cloudGroups: cloudGroups ? this.sanitizeGroups(cloudGroups) : undefined,
      mergedGroups: mergedGroups ? this.sanitizeGroups(mergedGroups) : undefined,
      metadata: {
        deviceId: await this.getCurrentDeviceId(),
        userId: this.getCurrentUserId(),
        syncMethod: 'unknown',
        triggerSource: 'unknown',
        ...metadata
      }
    };

    this.snapshots.push(snapshot);

    // 限制快照数量
    if (this.snapshots.length > this.MAX_SNAPSHOTS) {
      this.snapshots.shift();
    }

    // 输出详细日志
    this.logSnapshot(snapshot);
  }

  /**
   * 记录去重操作的详细日志
   */
  async logDeduplicationProcess(
    stage: 'start' | 'before_download' | 'after_download' | 'after_dedup' | 'after_upload' | 'complete',
    data: {
      localGroups?: TabGroup[];
      cloudGroups?: TabGroup[];
      deduplicatedGroups?: TabGroup[];
      removedCount?: number;
      error?: any;
    }
  ): Promise<void> {
    const stageNames = {
      start: '🚀 开始去重操作',
      before_download: '📥 准备下载云端数据',
      after_download: '📥 云端数据下载完成',
      after_dedup: '🔄 去重处理完成',
      after_upload: '📤 数据上传完成',
      complete: '✅ 去重操作完成'
    };

    console.group(`${stageNames[stage]} - ${new Date().toLocaleTimeString()}`);

    if (data.localGroups) {
      console.log('📊 本地数据统计:', {
        groupCount: data.localGroups.length,
        totalTabs: data.localGroups.reduce((sum, g) => sum + g.tabs.length, 0),
        groupIds: data.localGroups.map(g => ({ id: g.id, name: g.name, tabCount: g.tabs.length }))
      });
    }

    if (data.cloudGroups) {
      console.log('☁️ 云端数据统计:', {
        groupCount: data.cloudGroups.length,
        totalTabs: data.cloudGroups.reduce((sum, g) => sum + g.tabs.length, 0),
        groupIds: data.cloudGroups.map(g => ({ id: g.id, name: g.name, tabCount: g.tabs.length }))
      });
    }

    if (data.deduplicatedGroups) {
      console.log('🎯 去重后数据统计:', {
        groupCount: data.deduplicatedGroups.length,
        totalTabs: data.deduplicatedGroups.reduce((sum, g) => sum + g.tabs.length, 0),
        removedCount: data.removedCount || 0,
        groupIds: data.deduplicatedGroups.map(g => ({ id: g.id, name: g.name, tabCount: g.tabs.length }))
      });
    }

    if (data.error) {
      console.error('❌ 错误信息:', data.error);
    }

    // 记录快照
    if (data.localGroups || data.cloudGroups || data.deduplicatedGroups) {
      await this.recordSnapshot(
        `deduplication_${stage}`,
        data.localGroups || [],
        data.cloudGroups,
        data.deduplicatedGroups,
        {
          syncMethod: 'deduplication',
          triggerSource: 'user_action'
        }
      );
    }

    console.groupEnd();
  }

  /**
   * 记录页面刷新时的数据加载过程
   */
  async logPageRefreshProcess(
    stage: 'start' | 'load_local' | 'load_cloud' | 'merge' | 'complete',
    data: {
      localGroups?: TabGroup[];
      cloudGroups?: TabGroup[];
      finalGroups?: TabGroup[];
      mergeStrategy?: string;
      conflicts?: any[];
    }
  ): Promise<void> {
    const stageNames = {
      start: '🔄 页面刷新开始',
      load_local: '💾 加载本地数据',
      load_cloud: '☁️ 加载云端数据',
      merge: '🔀 数据合并处理',
      complete: '✅ 页面刷新完成'
    };

    console.group(`${stageNames[stage]} - ${new Date().toLocaleTimeString()}`);

    if (data.localGroups) {
      console.log('📊 本地数据:', {
        count: data.localGroups.length,
        totalTabs: data.localGroups.reduce((sum, g) => sum + g.tabs.length, 0)
      });
    }

    if (data.cloudGroups) {
      console.log('☁️ 云端数据:', {
        count: data.cloudGroups.length,
        totalTabs: data.cloudGroups.reduce((sum, g) => sum + g.tabs.length, 0)
      });
    }

    if (data.finalGroups) {
      console.log('🎯 最终数据:', {
        count: data.finalGroups.length,
        totalTabs: data.finalGroups.reduce((sum, g) => sum + g.tabs.length, 0),
        strategy: data.mergeStrategy || 'unknown'
      });
    }

    if (data.conflicts && data.conflicts.length > 0) {
      console.warn('⚠️ 检测到冲突:', data.conflicts);
    }

    // 记录快照
    await this.recordSnapshot(
      `page_refresh_${stage}`,
      data.localGroups || [],
      data.cloudGroups,
      data.finalGroups,
      {
        syncMethod: 'page_refresh',
        triggerSource: 'page_load'
      }
    );

    console.groupEnd();
  }

  /**
   * 分析数据差异
   */
  analyzeDataDifference(
    before: TabGroup[],
    after: TabGroup[],
    operation: string
  ): void {
    console.group(`🔍 数据差异分析 - ${operation}`);

    const beforeCount = before.length;
    const afterCount = after.length;
    const beforeTabs = before.reduce((sum, g) => sum + g.tabs.length, 0);
    const afterTabs = after.reduce((sum, g) => sum + g.tabs.length, 0);

    console.log('📊 数量变化:', {
      groups: { before: beforeCount, after: afterCount, diff: afterCount - beforeCount },
      tabs: { before: beforeTabs, after: afterTabs, diff: afterTabs - beforeTabs }
    });

    // 分析新增的组
    const beforeIds = new Set(before.map(g => g.id));
    const afterIds = new Set(after.map(g => g.id));
    
    const addedGroups = after.filter(g => !beforeIds.has(g.id));
    const removedGroups = before.filter(g => !afterIds.has(g.id));
    const modifiedGroups = after.filter(g => {
      const beforeGroup = before.find(bg => bg.id === g.id);
      return beforeGroup && (
        beforeGroup.tabs.length !== g.tabs.length ||
        beforeGroup.updatedAt !== g.updatedAt
      );
    });

    if (addedGroups.length > 0) {
      console.log('➕ 新增组:', addedGroups.map(g => ({ id: g.id, name: g.name, tabs: g.tabs.length })));
    }

    if (removedGroups.length > 0) {
      console.log('➖ 删除组:', removedGroups.map(g => ({ id: g.id, name: g.name, tabs: g.tabs.length })));
    }

    if (modifiedGroups.length > 0) {
      console.log('🔄 修改组:', modifiedGroups.map(g => {
        const beforeGroup = before.find(bg => bg.id === g.id);
        return {
          id: g.id,
          name: g.name,
          tabsBefore: beforeGroup?.tabs.length || 0,
          tabsAfter: g.tabs.length,
          updatedAt: g.updatedAt
        };
      }));
    }

    console.groupEnd();
  }

  /**
   * 获取调试报告
   */
  getDebugReport(): {
    snapshots: SyncDebugSnapshot[];
    summary: {
      totalOperations: number;
      operationTypes: Record<string, number>;
      dataInconsistencies: Array<{
        operation: string;
        timestamp: string;
        issue: string;
      }>;
    };
  } {
    const operationTypes: Record<string, number> = {};
    const dataInconsistencies: Array<{
      operation: string;
      timestamp: string;
      issue: string;
    }> = [];

    this.snapshots.forEach(snapshot => {
      operationTypes[snapshot.operation] = (operationTypes[snapshot.operation] || 0) + 1;

      // 检测数据不一致
      if (snapshot.cloudGroups && snapshot.localCount !== snapshot.cloudCount) {
        dataInconsistencies.push({
          operation: snapshot.operation,
          timestamp: snapshot.timestamp,
          issue: `本地(${snapshot.localCount})与云端(${snapshot.cloudCount})数据数量不一致`
        });
      }

      if (snapshot.mergedGroups && snapshot.mergedGroups.length !== Math.max(snapshot.localCount, snapshot.cloudCount)) {
        dataInconsistencies.push({
          operation: snapshot.operation,
          timestamp: snapshot.timestamp,
          issue: `合并后数据数量(${snapshot.mergedGroups.length})异常`
        });
      }
    });

    return {
      snapshots: this.snapshots,
      summary: {
        totalOperations: this.snapshots.length,
        operationTypes,
        dataInconsistencies
      }
    };
  }

  /**
   * 清除调试数据
   */
  clearDebugData(): void {
    this.snapshots = [];
    console.log('🧹 同步调试数据已清除');
  }

  /**
   * 启用/禁用调试
   */
  setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
    console.log(`🔧 同步调试日志${enabled ? '已启用' : '已禁用'}`);
  }

  /**
   * 私有方法：清理敏感数据
   */
  private sanitizeGroups(groups: TabGroup[]): TabGroup[] {
    return groups.map(group => ({
      ...group,
      tabs: group.tabs.map(tab => ({
        ...tab,
        // 保留URL用于调试，但可以选择性隐藏敏感信息
        url: tab.url.length > 100 ? tab.url.substring(0, 100) + '...' : tab.url
      }))
    }));
  }

  /**
   * 私有方法：输出快照日志
   */
  private logSnapshot(snapshot: SyncDebugSnapshot): void {
    console.log(`📸 同步快照 [${snapshot.operation}]`, {
      timestamp: snapshot.timestamp,
      localCount: snapshot.localCount,
      cloudCount: snapshot.cloudCount,
      mergedCount: snapshot.mergedGroups?.length,
      metadata: snapshot.metadata
    });
  }

  /**
   * 私有方法：获取当前设备ID
   */
  private async getCurrentDeviceId(): Promise<string> {
    try {
      const { deviceId } = await chrome.storage.local.get('deviceId');
      return deviceId || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * 私有方法：获取当前用户ID
   */
  private getCurrentUserId(): string {
    try {
      const state = (window as any).__REDUX_STORE__?.getState?.();
      return state?.auth?.user?.id || 'unknown';
    } catch {
      return 'unknown';
    }
  }
}

/**
 * 全局调试日志器实例
 */
export const syncDebugLogger = new SyncDebugLogger();

/**
 * 便捷函数：记录去重过程
 */
export async function logDeduplicationStep(
  stage: 'start' | 'before_download' | 'after_download' | 'after_dedup' | 'after_upload' | 'complete',
  data: any
): Promise<void> {
  await syncDebugLogger.logDeduplicationProcess(stage, data);
}

/**
 * 便捷函数：记录页面刷新过程
 */
export async function logPageRefreshStep(
  stage: 'start' | 'load_local' | 'load_cloud' | 'merge' | 'complete',
  data: any
): Promise<void> {
  await syncDebugLogger.logPageRefreshProcess(stage, data);
}

/**
 * 便捷函数：分析数据差异
 */
export function analyzeDataChange(before: TabGroup[], after: TabGroup[], operation: string): void {
  syncDebugLogger.analyzeDataDifference(before, after, operation);
}

// 在开发环境下暴露到全局对象
if (process.env.NODE_ENV === 'development') {
  (window as any).syncDebugLogger = syncDebugLogger;
}
