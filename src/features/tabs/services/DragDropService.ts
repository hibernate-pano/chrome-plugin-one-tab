import { TabGroup, Tab } from '@/shared/types/tab';
import { storage } from '@/shared/utils/storage';
import { logger } from '@/shared/utils/logger';
import { errorHandler } from '@/shared/utils/errorHandler';

/**
 * 拖拽操作类型
 */
export type DragOperation = {
  type: 'tab' | 'group';
  sourceId: string;
  sourceIndex: number;
  targetId?: string;
  targetIndex: number;
};

/**
 * 拖拽结果
 */
export interface DragResult {
  success: boolean;
  operation: DragOperation;
  updatedGroups?: TabGroup[];
  error?: string;
}

/**
 * 拖拽验证结果
 */
export interface DragValidation {
  isValid: boolean;
  canDrop: boolean;
  reason?: string;
}

/**
 * 拖拽领域服务
 * 负责处理标签和标签组的拖拽操作业务逻辑
 */
export class DragDropService {
  
  /**
   * 验证拖拽操作是否有效
   */
  validateDragOperation(operation: DragOperation, groups: TabGroup[]): DragValidation {
    try {
      const { type, sourceId, sourceIndex, targetId, targetIndex } = operation;
      
      if (type === 'tab') {
        return this.validateTabDrag(sourceId, sourceIndex, targetId!, targetIndex, groups);
      } else if (type === 'group') {
        return this.validateGroupDrag(sourceIndex, targetIndex, groups);
      }
      
      return {
        isValid: false,
        canDrop: false,
        reason: '未知的拖拽类型'
      };
    } catch (error) {
      logger.error('拖拽验证失败', error);
      return {
        isValid: false,
        canDrop: false,
        reason: '拖拽验证出错'
      };
    }
  }
  
  /**
   * 验证标签拖拽
   */
  private validateTabDrag(
    sourceGroupId: string,
    sourceIndex: number,
    targetGroupId: string,
    targetIndex: number,
    groups: TabGroup[]
  ): DragValidation {
    const sourceGroup = groups.find(g => g.id === sourceGroupId);
    const targetGroup = groups.find(g => g.id === targetGroupId);
    
    if (!sourceGroup) {
      return {
        isValid: false,
        canDrop: false,
        reason: '源标签组不存在'
      };
    }
    
    if (!targetGroup) {
      return {
        isValid: false,
        canDrop: false,
        reason: '目标标签组不存在'
      };
    }
    
    if (sourceIndex < 0 || sourceIndex >= sourceGroup.tabs.length) {
      return {
        isValid: false,
        canDrop: false,
        reason: '源标签索引无效'
      };
    }
    
    if (targetIndex < 0 || targetIndex > targetGroup.tabs.length) {
      return {
        isValid: false,
        canDrop: false,
        reason: '目标标签索引无效'
      };
    }
    
    // 检查目标组是否被锁定
    if (targetGroup.isLocked && sourceGroupId !== targetGroupId) {
      return {
        isValid: false,
        canDrop: false,
        reason: '目标标签组已锁定'
      };
    }
    
    // 同一位置不需要移动
    if (sourceGroupId === targetGroupId && sourceIndex === targetIndex) {
      return {
        isValid: false,
        canDrop: false,
        reason: '相同位置无需移动'
      };
    }
    
    return {
      isValid: true,
      canDrop: true
    };
  }
  
  /**
   * 验证标签组拖拽
   */
  private validateGroupDrag(
    sourceIndex: number,
    targetIndex: number,
    groups: TabGroup[]
  ): DragValidation {
    if (sourceIndex < 0 || sourceIndex >= groups.length) {
      return {
        isValid: false,
        canDrop: false,
        reason: '源标签组索引无效'
      };
    }
    
    if (targetIndex < 0 || targetIndex >= groups.length) {
      return {
        isValid: false,
        canDrop: false,
        reason: '目标标签组索引无效'
      };
    }
    
    if (sourceIndex === targetIndex) {
      return {
        isValid: false,
        canDrop: false,
        reason: '相同位置无需移动'
      };
    }
    
    return {
      isValid: true,
      canDrop: true
    };
  }
  
  /**
   * 执行标签拖拽操作
   */
  async moveTab(
    sourceGroupId: string,
    sourceIndex: number,
    targetGroupId: string,
    targetIndex: number
  ): Promise<DragResult> {
    try {
      const groups = await storage.getGroups();
      const operation: DragOperation = {
        type: 'tab',
        sourceId: sourceGroupId,
        sourceIndex,
        targetId: targetGroupId,
        targetIndex
      };
      
      // 验证操作
      const validation = this.validateDragOperation(operation, groups);
      if (!validation.isValid) {
        return {
          success: false,
          operation,
          error: validation.reason
        };
      }
      
      // 执行移动
      const updatedGroups = this.performTabMove(groups, sourceGroupId, sourceIndex, targetGroupId, targetIndex);
      
      // 保存到存储
      await storage.setGroups(updatedGroups);
      
      logger.debug('标签移动成功', {
        sourceGroupId,
        sourceIndex,
        targetGroupId,
        targetIndex
      });
      
      return {
        success: true,
        operation,
        updatedGroups
      };
    } catch (error) {
      const message = errorHandler.getErrorMessage(error);
      logger.error('标签移动失败', error);
      
      return {
        success: false,
        operation: {
          type: 'tab',
          sourceId: sourceGroupId,
          sourceIndex,
          targetId: targetGroupId,
          targetIndex
        },
        error: message
      };
    }
  }
  
  /**
   * 执行标签组拖拽操作
   */
  async moveGroup(sourceIndex: number, targetIndex: number): Promise<DragResult> {
    try {
      const groups = await storage.getGroups();
      const operation: DragOperation = {
        type: 'group',
        sourceId: groups[sourceIndex]?.id || '',
        sourceIndex,
        targetIndex
      };
      
      // 验证操作
      const validation = this.validateDragOperation(operation, groups);
      if (!validation.isValid) {
        return {
          success: false,
          operation,
          error: validation.reason
        };
      }
      
      // 执行移动
      const updatedGroups = this.performGroupMove(groups, sourceIndex, targetIndex);
      
      // 保存到存储
      await storage.setGroups(updatedGroups);
      
      logger.debug('标签组移动成功', {
        sourceIndex,
        targetIndex
      });
      
      return {
        success: true,
        operation,
        updatedGroups
      };
    } catch (error) {
      const message = errorHandler.getErrorMessage(error);
      logger.error('标签组移动失败', error);
      
      return {
        success: false,
        operation: {
          type: 'group',
          sourceId: '',
          sourceIndex,
          targetIndex
        },
        error: message
      };
    }
  }
  
  /**
   * 执行标签移动的具体逻辑
   */
  private performTabMove(
    groups: TabGroup[],
    sourceGroupId: string,
    sourceIndex: number,
    targetGroupId: string,
    targetIndex: number
  ): TabGroup[] {
    const newGroups = groups.map(group => ({ ...group, tabs: [...group.tabs] }));
    
    const sourceGroup = newGroups.find(g => g.id === sourceGroupId);
    const targetGroup = newGroups.find(g => g.id === targetGroupId);
    
    if (!sourceGroup || !targetGroup) {
      throw new Error('标签组未找到');
    }
    
    // 获取要移动的标签
    const tab = sourceGroup.tabs[sourceIndex];
    if (!tab) {
      throw new Error('标签未找到');
    }
    
    // 从源组中移除标签
    sourceGroup.tabs.splice(sourceIndex, 1);
    
    // 计算目标位置
    let finalTargetIndex = targetIndex;
    if (sourceGroupId === targetGroupId && sourceIndex < targetIndex) {
      // 同一组内向后移动时，需要调整索引
      finalTargetIndex = targetIndex - 1;
    }
    
    // 插入到目标组
    targetGroup.tabs.splice(finalTargetIndex, 0, tab);
    
    // 更新时间戳
    const now = new Date().toISOString();
    sourceGroup.updatedAt = now;
    if (sourceGroupId !== targetGroupId) {
      targetGroup.updatedAt = now;
    }
    
    return newGroups;
  }
  
  /**
   * 执行标签组移动的具体逻辑
   */
  private performGroupMove(groups: TabGroup[], sourceIndex: number, targetIndex: number): TabGroup[] {
    const newGroups = [...groups];
    
    // 获取要移动的标签组
    const dragGroup = newGroups[sourceIndex];
    
    // 移除源位置的标签组
    newGroups.splice(sourceIndex, 1);
    
    // 计算最终目标位置
    let finalTargetIndex = targetIndex;
    if (sourceIndex < targetIndex) {
      finalTargetIndex = targetIndex - 1;
    }
    
    // 插入到目标位置
    newGroups.splice(finalTargetIndex, 0, dragGroup);
    
    // 更新order字段
    newGroups.forEach((group, index) => {
      group.order = index;
      group.updatedAt = new Date().toISOString();
    });
    
    return newGroups;
  }
  
  /**
   * 计算拖拽预览信息
   */
  getDragPreview(operation: DragOperation, groups: TabGroup[]): {
    sourceInfo: string;
    targetInfo: string;
    previewText: string;
  } {
    if (operation.type === 'tab') {
      const sourceGroup = groups.find(g => g.id === operation.sourceId);
      const targetGroup = groups.find(g => g.id === operation.targetId);
      const tab = sourceGroup?.tabs[operation.sourceIndex];
      
      return {
        sourceInfo: `${sourceGroup?.name || '未知组'} - ${tab?.title || '未知标签'}`,
        targetInfo: `${targetGroup?.name || '未知组'} (位置 ${operation.targetIndex + 1})`,
        previewText: `移动标签 "${tab?.title || '未知标签'}" 到 "${targetGroup?.name || '未知组'}"`
      };
    } else {
      const sourceGroup = groups[operation.sourceIndex];
      
      return {
        sourceInfo: `${sourceGroup?.name || '未知组'} (${sourceGroup?.tabs.length || 0} 个标签)`,
        targetInfo: `位置 ${operation.targetIndex + 1}`,
        previewText: `移动标签组 "${sourceGroup?.name || '未知组'}" 到位置 ${operation.targetIndex + 1}`
      };
    }
  }
  
  /**
   * 批量移动标签
   */
  async batchMoveTabs(operations: Array<{
    sourceGroupId: string;
    sourceIndex: number;
    targetGroupId: string;
    targetIndex: number;
  }>): Promise<{
    success: boolean;
    successCount: number;
    failureCount: number;
    errors: string[];
  }> {
    let successCount = 0;
    let failureCount = 0;
    const errors: string[] = [];
    
    try {
      let currentGroups = await storage.getGroups();
      
      // 按操作顺序执行，每次都基于最新的组状态
      for (const op of operations) {
        try {
          const result = await this.moveTab(op.sourceGroupId, op.sourceIndex, op.targetGroupId, op.targetIndex);
          if (result.success) {
            successCount++;
            if (result.updatedGroups) {
              currentGroups = result.updatedGroups;
            }
          } else {
            failureCount++;
            errors.push(result.error || '未知错误');
          }
        } catch (error) {
          failureCount++;
          errors.push(errorHandler.getErrorMessage(error));
        }
      }
      
      return {
        success: successCount > 0,
        successCount,
        failureCount,
        errors
      };
    } catch (error) {
      logger.error('批量移动标签失败', error);
      return {
        success: false,
        successCount: 0,
        failureCount: operations.length,
        errors: [errorHandler.getErrorMessage(error)]
      };
    }
  }
}

// 导出单例实例
export const dragDropService = new DragDropService();
