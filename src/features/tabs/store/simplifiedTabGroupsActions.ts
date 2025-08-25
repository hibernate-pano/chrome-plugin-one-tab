/**
 * 简化的标签组操作
 * 使用SimplifiedSyncService替代复杂的同步协调器
 */

import { createAsyncThunk } from '@reduxjs/toolkit';
import { TabGroup } from '@/shared/types/tab';
import { logger } from '@/shared/utils/logger';
import { simplifiedSyncService, UserOperation } from '@/services/SimplifiedSyncService';
import { generateId } from '@/shared/utils/idGenerator';

/**
 * 创建新标签组（简化版本）
 */
export const saveGroupSimplified = createAsyncThunk(
  'tabGroups/saveGroupSimplified',
  async (group: Omit<TabGroup, 'id' | 'createdAt' | 'updatedAt'>) => {
    logger.debug('开始简化保存新标签组', { name: group.name, tabCount: group.tabs.length });

    try {
      const now = new Date().toISOString();
      const newGroup: TabGroup = {
        ...group,
        id: generateId(),
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: null
      };

      const operation: UserOperation = {
        type: 'create',
        data: newGroup
      };

      const result = await simplifiedSyncService.syncUserOperation(operation);

      if (!result.success) {
        throw new Error(result.error || result.message || '保存标签组失败');
      }

      logger.debug('✅ 简化保存标签组成功', { 
        groupId: newGroup.id, 
        name: newGroup.name 
      });

      return newGroup;

    } catch (error) {
      logger.error('❌ 简化保存标签组失败:', error);
      throw error;
    }
  }
);

/**
 * 更新标签组（简化版本）
 */
export const updateGroupSimplified = createAsyncThunk(
  'tabGroups/updateGroupSimplified',
  async (updates: { groupId: string; data: Partial<TabGroup> }) => {
    logger.debug('开始简化更新标签组', { 
      groupId: updates.groupId, 
      updates: Object.keys(updates.data) 
    });

    try {
      const operation: UserOperation = {
        type: 'update',
        groupId: updates.groupId,
        data: {
          ...updates.data,
          updatedAt: new Date().toISOString(),
          lastSyncedAt: null
        }
      };

      const result = await simplifiedSyncService.syncUserOperation(operation);

      if (!result.success) {
        throw new Error(result.error || result.message || '更新标签组失败');
      }

      // 从同步结果中找到更新后的标签组
      const updatedGroup = result.syncedGroups?.find(g => g.id === updates.groupId);
      if (!updatedGroup) {
        throw new Error('更新后的标签组未找到');
      }

      logger.debug('✅ 简化更新标签组成功', { 
        groupId: updates.groupId,
        name: updatedGroup.name
      });

      return updatedGroup;

    } catch (error) {
      logger.error('❌ 简化更新标签组失败:', error);
      throw error;
    }
  }
);

/**
 * 删除标签组（简化版本）
 */
export const deleteGroupSimplified = createAsyncThunk(
  'tabGroups/deleteGroupSimplified',
  async (groupId: string) => {
    logger.debug('开始简化删除标签组', { groupId });

    try {
      const operation: UserOperation = {
        type: 'delete',
        groupId
      };

      const result = await simplifiedSyncService.syncUserOperation(operation);

      if (!result.success) {
        throw new Error(result.error || result.message || '删除标签组失败');
      }

      logger.debug('✅ 简化删除标签组成功', { groupId });

      return groupId;

    } catch (error) {
      logger.error('❌ 简化删除标签组失败:', error);
      throw error;
    }
  }
);

/**
 * 更新标签组名称（简化版本）
 */
export const updateGroupNameSimplified = createAsyncThunk(
  'tabGroups/updateGroupNameSimplified',
  async ({ groupId, name }: { groupId: string; name: string }) => {
    logger.debug('开始简化更新标签组名称', { groupId, name });

    try {
      const operation: UserOperation = {
        type: 'update',
        groupId,
        data: {
          name,
          updatedAt: new Date().toISOString(),
          lastSyncedAt: null
        }
      };

      const result = await simplifiedSyncService.syncUserOperation(operation);

      if (!result.success) {
        throw new Error(result.error || result.message || '更新标签组名称失败');
      }

      logger.debug('✅ 简化更新标签组名称成功', { groupId, name });

      return { groupId, name };

    } catch (error) {
      logger.error('❌ 简化更新标签组名称失败:', error);
      throw error;
    }
  }
);

/**
 * 切换标签组锁定状态（简化版本）
 */
export const toggleGroupLockSimplified = createAsyncThunk(
  'tabGroups/toggleGroupLockSimplified',
  async ({ groupId, isLocked }: { groupId: string; isLocked: boolean }) => {
    logger.debug('开始简化切换标签组锁定状态', { groupId, isLocked });

    try {
      const operation: UserOperation = {
        type: 'update',
        groupId,
        data: {
          isLocked,
          updatedAt: new Date().toISOString(),
          lastSyncedAt: null
        }
      };

      const result = await simplifiedSyncService.syncUserOperation(operation);

      if (!result.success) {
        throw new Error(result.error || result.message || '切换锁定状态失败');
      }

      logger.debug('✅ 简化切换标签组锁定状态成功', { groupId, isLocked });

      return { groupId, isLocked };

    } catch (error) {
      logger.error('❌ 简化切换标签组锁定状态失败:', error);
      throw error;
    }
  }
);

/**
 * 批量操作：去重标签页（简化版本）
 */
export const deduplicateTabsSimplified = createAsyncThunk(
  'tabGroups/deduplicateTabsSimplified',
  async () => {
    logger.debug('开始简化去重标签页');

    try {
      // 这里可以实现去重逻辑，暂时返回成功
      // 实际实现需要获取所有标签组，执行去重，然后同步
      
      logger.debug('✅ 简化去重标签页成功');

      return { removedCount: 0 }; // 临时返回

    } catch (error) {
      logger.error('❌ 简化去重标签页失败:', error);
      throw error;
    }
  }
);

/**
 * 检查同步状态
 */
export const checkSyncStatus = createAsyncThunk(
  'tabGroups/checkSyncStatus',
  async () => {
    return {
      isSyncing: simplifiedSyncService.isSyncInProgress(),
      lastSyncTime: new Date().toISOString()
    };
  }
);

/**
 * 工具函数：生成操作ID
 */
function generateOperationId(): string {
  return `op_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * 工具函数：验证标签组数据
 */
function validateTabGroup(group: Partial<TabGroup>): boolean {
  if (!group.name || group.name.trim().length === 0) {
    return false;
  }
  
  if (!group.tabs || !Array.isArray(group.tabs)) {
    return false;
  }

  return true;
}

/**
 * 工具函数：清理标签组数据
 */
function sanitizeTabGroup(group: TabGroup): TabGroup {
  return {
    ...group,
    name: group.name.trim(),
    tabs: group.tabs.filter(tab => tab.url && tab.title),
    updatedAt: new Date().toISOString()
  };
}
