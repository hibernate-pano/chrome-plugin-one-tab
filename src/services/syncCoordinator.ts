/**
 * 同步协调器
 * 确保多浏览器环境下的数据一致性，防止操作被覆盖
 */

import { TabGroup } from '@/shared/types/tab';
import { storage } from '@/shared/utils/storage';
import { logger } from '@/shared/utils/logger';
import { optimisticSyncService } from './optimisticSyncService';

interface PendingOperation {
  id: string;
  type: 'deduplication' | 'delete' | 'update' | 'create';
  timestamp: number;
  groupIds: string[];
  expectedVersions: Map<string, number>;
}

export class SyncCoordinator {
  private pendingOperations = new Map<string, PendingOperation>();
  private operationTimeout = 10000; // 10秒超时

  /**
   * 注册用户操作，防止被其他设备覆盖
   */
  async registerOperation(
    type: PendingOperation['type'],
    groupIds: string[],
    operationId?: string
  ): Promise<string> {
    const id = operationId || this.generateOperationId();
    
    // 获取当前版本号
    const groups = await storage.getGroups();
    const expectedVersions = new Map<string, number>();
    
    groupIds.forEach(groupId => {
      const group = groups.find(g => g.id === groupId);
      if (group) {
        expectedVersions.set(groupId, group.version || 1);
      }
    });

    const operation: PendingOperation = {
      id,
      type,
      timestamp: Date.now(),
      groupIds,
      expectedVersions
    };

    this.pendingOperations.set(id, operation);
    
    // 设置超时清理
    setTimeout(() => {
      this.pendingOperations.delete(id);
    }, this.operationTimeout);

    logger.info(`📝 注册用户操作: ${type}`, { operationId: id, groupIds });
    return id;
  }

  /**
   * 完成操作，移除保护
   */
  completeOperation(operationId: string): void {
    this.pendingOperations.delete(operationId);
    logger.info(`✅ 完成用户操作: ${operationId}`);
  }

  /**
   * 检查是否有冲突的待处理操作
   */
  hasConflictingOperation(groupIds: string[]): boolean {
    for (const operation of this.pendingOperations.values()) {
      // 检查是否有重叠的标签组
      const hasOverlap = operation.groupIds.some(id => groupIds.includes(id));
      if (hasOverlap) {
        logger.warn(`⚠️ 检测到冲突操作: ${operation.type}`, { 
          operationId: operation.id,
          conflictingGroups: groupIds.filter(id => operation.groupIds.includes(id))
        });
        return true;
      }
    }
    return false;
  }

  /**
   * 执行受保护的去重操作
   */
  async executeProtectedDeduplication(): Promise<{ success: boolean; removedCount: number; operationId: string }> {
    try {
      // Step 1: 拉取最新数据
      logger.info('🔄 开始受保护的去重操作 - 拉取最新数据');
      const pullResult = await optimisticSyncService.pullLatestData();
      
      if (!pullResult.success) {
        logger.error('❌ 拉取最新数据失败:', pullResult.message);
        return { success: false, removedCount: 0, operationId: '' };
      }

      const groups = pullResult.syncedGroups || await storage.getGroups();
      const groupIds = groups.map(g => g.id);

      // Step 2: 注册操作保护
      const operationId = await this.registerOperation('deduplication', groupIds);

      // Step 3: 执行去重逻辑
      const deduplicationResult = await this.performDeduplication(groups);

      if (!deduplicationResult.success) {
        this.completeOperation(operationId);
        return { success: false, removedCount: 0, operationId };
      }

      // Step 4: 保存结果并推送
      await storage.setGroups(deduplicationResult.updatedGroups);
      
      // Step 5: 立即推送到云端
      const pushResult = await optimisticSyncService.pushOnlySync();
      
      if (pushResult.success) {
        logger.info('✅ 去重结果已推送到云端');
      } else {
        logger.warn('⚠️ 去重结果推送失败:', pushResult.message);
      }

      // Step 6: 完成操作
      this.completeOperation(operationId);

      return { 
        success: true, 
        removedCount: deduplicationResult.removedCount,
        operationId 
      };

    } catch (error) {
      logger.error('❌ 受保护的去重操作失败:', error);
      return { success: false, removedCount: 0, operationId: '' };
    }
  }

  /**
   * 执行去重逻辑
   */
  private async performDeduplication(groups: TabGroup[]): Promise<{ success: boolean; updatedGroups: TabGroup[]; removedCount: number }> {
    try {
      // 创建URL到标签的映射
      const urlMap = new Map<string, Array<{ groupId: string; tab: any }>>();

      // 收集所有标签页
      groups.forEach(group => {
        group.tabs.forEach(tab => {
          if (!urlMap.has(tab.url)) {
            urlMap.set(tab.url, []);
          }
          urlMap.get(tab.url)!.push({ groupId: group.id, tab });
        });
      });

      // 处理重复标签页 - 创建深拷贝避免只读属性错误
      let removedCount = 0;
      const updatedGroups = groups.map(group => ({
        ...group,
        tabs: [...group.tabs] // 创建tabs数组的拷贝，避免只读属性错误
      }));

      urlMap.forEach(tabsWithSameUrl => {
        if (tabsWithSameUrl.length > 1) {
          // 按创建时间排序，保留最新的
          tabsWithSameUrl.sort((a, b) =>
            new Date(b.tab.createdAt || 0).getTime() - new Date(a.tab.createdAt || 0).getTime()
          );

          // 保留第一个（最新的），删除其余的
          for (let i = 1; i < tabsWithSameUrl.length; i++) {
            const { groupId, tab } = tabsWithSameUrl[i];
            const groupIndex = updatedGroups.findIndex(g => g.id === groupId);

            if (groupIndex !== -1) {
              // 从标签组中删除该标签页（现在可以安全修改，因为是深拷贝）
              updatedGroups[groupIndex].tabs = updatedGroups[groupIndex].tabs.filter(
                t => t.id !== tab.id
              );
              removedCount++;

              // 更新标签组的updatedAt时间和版本号
              updatedGroups[groupIndex].updatedAt = new Date().toISOString();
              updatedGroups[groupIndex].version = (updatedGroups[groupIndex].version || 1) + 1;
            }
          }
        }
      });

      // 过滤掉空的标签组
      const filteredGroups = updatedGroups.filter(group => group.tabs.length > 0);

      logger.info(`✅ 去重完成: 移除 ${removedCount} 个重复标签`);

      return {
        success: true,
        updatedGroups: filteredGroups,
        removedCount
      };

    } catch (error) {
      logger.error('❌ 去重逻辑执行失败:', error);
      return {
        success: false,
        updatedGroups: [],
        removedCount: 0
      };
    }
  }

  /**
   * 检查实时同步是否应该被阻止
   */
  shouldBlockRealtimeSync(incomingGroupIds: string[]): boolean {
    return this.hasConflictingOperation(incomingGroupIds);
  }

  /**
   * 生成操作ID
   */
  private generateOperationId(): string {
    return `op_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 获取待处理操作的统计信息
   */
  getPendingOperationsStats(): { count: number; types: string[] } {
    const operations = Array.from(this.pendingOperations.values());
    return {
      count: operations.length,
      types: [...new Set(operations.map(op => op.type))]
    };
  }

  /**
   * 清理过期的操作
   */
  cleanupExpiredOperations(): void {
    const now = Date.now();
    for (const [id, operation] of this.pendingOperations.entries()) {
      if (now - operation.timestamp > this.operationTimeout) {
        this.pendingOperations.delete(id);
        logger.info(`🧹 清理过期操作: ${operation.type}`, { operationId: id });
      }
    }
  }
}

export const syncCoordinator = new SyncCoordinator();
