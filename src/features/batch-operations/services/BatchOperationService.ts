import { TabGroup, Tab } from '@/shared/types/tab';
import { storage } from '@/shared/utils/storage';
import { logger } from '@/shared/utils/logger';
import { errorHandler } from '@/shared/utils/errorHandler';

/**
 * 批量操作类型
 */
export type BatchOperationType = 'delete' | 'lock' | 'unlock' | 'move' | 'export' | 'merge';

/**
 * 批量操作选项
 */
export interface BatchOperationOptions {
  groupIds?: string[];
  tabIds?: string[];
  targetGroupId?: string; // 用于移动操作
  exportFormat?: 'json' | 'csv' | 'html'; // 用于导出操作
  confirmDangerous?: boolean; // 确认危险操作
}

/**
 * 批量操作结果
 */
export interface BatchOperationResult {
  success: boolean;
  processedCount: number;
  failedCount: number;
  totalCount: number;
  errors: string[];
  warnings: string[];
  data?: any; // 用于返回导出数据等
}

/**
 * 操作进度回调
 */
export type ProgressCallback = (progress: {
  current: number;
  total: number;
  percentage: number;
  currentItem?: string;
}) => void;

/**
 * 批量操作领域服务
 * 负责处理标签组和标签的批量操作业务逻辑
 */
export class BatchOperationService {
  
  /**
   * 批量删除标签组
   */
  async batchDeleteGroups(
    groupIds: string[],
    options: { confirmDangerous?: boolean } = {},
    onProgress?: ProgressCallback
  ): Promise<BatchOperationResult> {
    try {
      logger.debug('开始批量删除标签组', { count: groupIds.length });
      
      if (!options.confirmDangerous) {
        return {
          success: false,
          processedCount: 0,
          failedCount: 0,
          totalCount: groupIds.length,
          errors: ['需要确认危险操作'],
          warnings: []
        };
      }
      
      const groups = await storage.getGroups();
      const existingGroupIds = new Set(groups.map(g => g.id));
      const validGroupIds = groupIds.filter(id => existingGroupIds.has(id));
      const invalidGroupIds = groupIds.filter(id => !existingGroupIds.has(id));
      
      let processedCount = 0;
      const errors: string[] = [];
      const warnings: string[] = [];
      
      // 添加无效ID的警告
      if (invalidGroupIds.length > 0) {
        warnings.push(`${invalidGroupIds.length} 个标签组不存在，已跳过`);
      }
      
      // 过滤掉要删除的标签组
      const remainingGroups = groups.filter(group => {
        const shouldDelete = validGroupIds.includes(group.id);
        if (shouldDelete) {
          processedCount++;
          onProgress?.({
            current: processedCount,
            total: validGroupIds.length,
            percentage: Math.round((processedCount / validGroupIds.length) * 100),
            currentItem: group.name
          });
        }
        return !shouldDelete;
      });
      
      // 保存更新后的标签组
      await storage.setGroups(remainingGroups);
      
      logger.success('批量删除标签组完成', {
        processedCount,
        totalCount: groupIds.length
      });
      
      return {
        success: true,
        processedCount,
        failedCount: invalidGroupIds.length,
        totalCount: groupIds.length,
        errors,
        warnings
      };
    } catch (error) {
      const message = errorHandler.getErrorMessage(error);
      logger.error('批量删除标签组失败', error);
      
      return {
        success: false,
        processedCount: 0,
        failedCount: groupIds.length,
        totalCount: groupIds.length,
        errors: [message],
        warnings: []
      };
    }
  }
  
  /**
   * 批量锁定/解锁标签组
   */
  async batchToggleGroupLock(
    groupIds: string[],
    locked: boolean,
    onProgress?: ProgressCallback
  ): Promise<BatchOperationResult> {
    try {
      logger.debug('开始批量切换标签组锁定状态', { count: groupIds.length, locked });
      
      const groups = await storage.getGroups();
      const groupMap = new Map(groups.map(g => [g.id, g]));
      
      let processedCount = 0;
      let failedCount = 0;
      const errors: string[] = [];
      const warnings: string[] = [];
      
      // 更新标签组锁定状态
      const updatedGroups = groups.map(group => {
        if (groupIds.includes(group.id)) {
          const currentProgress = processedCount + failedCount + 1;
          onProgress?.({
            current: currentProgress,
            total: groupIds.length,
            percentage: Math.round((currentProgress / groupIds.length) * 100),
            currentItem: group.name
          });
          
          if (group.isLocked === locked) {
            warnings.push(`标签组 "${group.name}" 已经是${locked ? '锁定' : '解锁'}状态`);
            failedCount++;
            return group;
          }
          
          processedCount++;
          return {
            ...group,
            isLocked: locked,
            updatedAt: new Date().toISOString()
          };
        }
        return group;
      });
      
      // 检查未找到的标签组
      const foundGroupIds = new Set(groups.map(g => g.id));
      const notFoundIds = groupIds.filter(id => !foundGroupIds.has(id));
      if (notFoundIds.length > 0) {
        failedCount += notFoundIds.length;
        errors.push(`${notFoundIds.length} 个标签组不存在`);
      }
      
      // 保存更新后的标签组
      await storage.setGroups(updatedGroups);
      
      logger.success('批量切换锁定状态完成', {
        processedCount,
        failedCount,
        totalCount: groupIds.length
      });
      
      return {
        success: processedCount > 0,
        processedCount,
        failedCount,
        totalCount: groupIds.length,
        errors,
        warnings
      };
    } catch (error) {
      const message = errorHandler.getErrorMessage(error);
      logger.error('批量切换锁定状态失败', error);
      
      return {
        success: false,
        processedCount: 0,
        failedCount: groupIds.length,
        totalCount: groupIds.length,
        errors: [message],
        warnings: []
      };
    }
  }
  
  /**
   * 批量移动标签组到指定位置
   */
  async batchMoveGroups(
    groupIds: string[],
    targetIndex: number,
    onProgress?: ProgressCallback
  ): Promise<BatchOperationResult> {
    try {
      logger.debug('开始批量移动标签组', { count: groupIds.length, targetIndex });
      
      const groups = await storage.getGroups();
      const groupsToMove = groups.filter(g => groupIds.includes(g.id));
      const remainingGroups = groups.filter(g => !groupIds.includes(g.id));
      
      if (groupsToMove.length === 0) {
        return {
          success: false,
          processedCount: 0,
          failedCount: groupIds.length,
          totalCount: groupIds.length,
          errors: ['没有找到要移动的标签组'],
          warnings: []
        };
      }
      
      // 验证目标位置
      const maxIndex = groups.length - groupsToMove.length;
      const finalTargetIndex = Math.max(0, Math.min(targetIndex, maxIndex));
      
      // 重新排列标签组
      const newGroups = [...remainingGroups];
      newGroups.splice(finalTargetIndex, 0, ...groupsToMove);
      
      // 更新order字段和时间戳
      const now = new Date().toISOString();
      newGroups.forEach((group, index) => {
        group.order = index;
        if (groupIds.includes(group.id)) {
          group.updatedAt = now;
        }
        
        onProgress?.({
          current: index + 1,
          total: newGroups.length,
          percentage: Math.round(((index + 1) / newGroups.length) * 100),
          currentItem: group.name
        });
      });
      
      // 保存更新后的标签组
      await storage.setGroups(newGroups);
      
      logger.success('批量移动标签组完成', {
        processedCount: groupsToMove.length,
        targetIndex: finalTargetIndex
      });
      
      return {
        success: true,
        processedCount: groupsToMove.length,
        failedCount: groupIds.length - groupsToMove.length,
        totalCount: groupIds.length,
        errors: [],
        warnings: finalTargetIndex !== targetIndex ? [`目标位置已调整为 ${finalTargetIndex}`] : []
      };
    } catch (error) {
      const message = errorHandler.getErrorMessage(error);
      logger.error('批量移动标签组失败', error);
      
      return {
        success: false,
        processedCount: 0,
        failedCount: groupIds.length,
        totalCount: groupIds.length,
        errors: [message],
        warnings: []
      };
    }
  }
  
  /**
   * 批量导出标签组
   */
  async batchExportGroups(
    groupIds: string[],
    format: 'json' | 'csv' | 'html' = 'json',
    onProgress?: ProgressCallback
  ): Promise<BatchOperationResult> {
    try {
      logger.debug('开始批量导出标签组', { count: groupIds.length, format });
      
      const groups = await storage.getGroups();
      const selectedGroups = groups.filter(g => groupIds.includes(g.id));
      
      if (selectedGroups.length === 0) {
        return {
          success: false,
          processedCount: 0,
          failedCount: groupIds.length,
          totalCount: groupIds.length,
          errors: ['没有找到要导出的标签组'],
          warnings: []
        };
      }
      
      // 生成导出数据
      let exportData: string;
      let mimeType: string;
      let filename: string;
      
      const date = new Date().toISOString().split('T')[0];
      
      switch (format) {
        case 'json':
          exportData = JSON.stringify({
            version: '2.0.0',
            exportTime: new Date().toISOString(),
            groups: selectedGroups,
            metadata: {
              totalGroups: selectedGroups.length,
              totalTabs: selectedGroups.reduce((sum, group) => sum + group.tabs.length, 0)
            }
          }, null, 2);
          mimeType = 'application/json';
          filename = `onetab-plus-batch-export-${date}.json`;
          break;
          
        case 'csv':
          const csvHeaders = ['Group Name', 'Tab Title', 'URL', 'Created At', 'Is Locked'];
          const csvRows = [csvHeaders.join(',')];
          
          selectedGroups.forEach((group, groupIndex) => {
            onProgress?.({
              current: groupIndex + 1,
              total: selectedGroups.length,
              percentage: Math.round(((groupIndex + 1) / selectedGroups.length) * 100),
              currentItem: group.name
            });
            
            group.tabs.forEach(tab => {
              const row = [
                `"${group.name.replace(/"/g, '""')}"`,
                `"${tab.title.replace(/"/g, '""')}"`,
                `"${tab.url}"`,
                `"${group.createdAt}"`,
                `"${group.isLocked}"`
              ];
              csvRows.push(row.join(','));
            });
          });
          
          exportData = csvRows.join('\n');
          mimeType = 'text/csv';
          filename = `onetab-plus-batch-export-${date}.csv`;
          break;
          
        case 'html':
          exportData = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>OneTab Plus Batch Export</TITLE>
<H1>OneTab Plus Batch Export</H1>
<DL><p>
${selectedGroups.map((group, groupIndex) => {
  onProgress?.({
    current: groupIndex + 1,
    total: selectedGroups.length,
    percentage: Math.round(((groupIndex + 1) / selectedGroups.length) * 100),
    currentItem: group.name
  });
  
  return `    <DT><H3>${this.escapeHtml(group.name)}</H3>
    <DL><p>
${group.tabs.map(tab => `        <DT><A HREF="${tab.url}">${this.escapeHtml(tab.title)}</A>`).join('\n')}
    </DL><p>`;
}).join('\n')}
</DL><p>`;
          mimeType = 'text/html';
          filename = `onetab-plus-batch-export-${date}.html`;
          break;
          
        default:
          throw new Error(`不支持的导出格式: ${format}`);
      }
      
      // 创建下载
      const blob = new Blob([exportData], { type: mimeType });
      const url = URL.createObjectURL(blob);
      
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      URL.revokeObjectURL(url);
      
      logger.success('批量导出标签组完成', {
        processedCount: selectedGroups.length,
        format,
        filename
      });
      
      return {
        success: true,
        processedCount: selectedGroups.length,
        failedCount: groupIds.length - selectedGroups.length,
        totalCount: groupIds.length,
        errors: [],
        warnings: [],
        data: {
          filename,
          fileSize: blob.size,
          format
        }
      };
    } catch (error) {
      const message = errorHandler.getErrorMessage(error);
      logger.error('批量导出标签组失败', error);
      
      return {
        success: false,
        processedCount: 0,
        failedCount: groupIds.length,
        totalCount: groupIds.length,
        errors: [message],
        warnings: []
      };
    }
  }
  
  /**
   * 批量合并标签组
   */
  async batchMergeGroups(
    sourceGroupIds: string[],
    targetGroupId: string,
    options: { removeDuplicates?: boolean; deleteSourceGroups?: boolean } = {},
    onProgress?: ProgressCallback
  ): Promise<BatchOperationResult> {
    try {
      logger.debug('开始批量合并标签组', {
        sourceCount: sourceGroupIds.length,
        targetGroupId,
        options
      });
      
      const groups = await storage.getGroups();
      const targetGroup = groups.find(g => g.id === targetGroupId);
      
      if (!targetGroup) {
        return {
          success: false,
          processedCount: 0,
          failedCount: sourceGroupIds.length,
          totalCount: sourceGroupIds.length,
          errors: ['目标标签组不存在'],
          warnings: []
        };
      }
      
      const sourceGroups = groups.filter(g => sourceGroupIds.includes(g.id));
      let processedCount = 0;
      const errors: string[] = [];
      const warnings: string[] = [];
      
      // 收集所有要合并的标签
      const allTabs: Tab[] = [...targetGroup.tabs];
      const existingUrls = new Set(targetGroup.tabs.map(tab => tab.url));
      
      sourceGroups.forEach((sourceGroup, index) => {
        onProgress?.({
          current: index + 1,
          total: sourceGroups.length,
          percentage: Math.round(((index + 1) / sourceGroups.length) * 100),
          currentItem: sourceGroup.name
        });
        
        sourceGroup.tabs.forEach(tab => {
          if (options.removeDuplicates && existingUrls.has(tab.url)) {
            warnings.push(`重复标签已跳过: ${tab.title}`);
          } else {
            allTabs.push(tab);
            existingUrls.add(tab.url);
          }
        });
        
        processedCount++;
      });
      
      // 更新目标组
      const updatedGroups = groups.map(group => {
        if (group.id === targetGroupId) {
          return {
            ...group,
            tabs: allTabs,
            updatedAt: new Date().toISOString()
          };
        }
        
        // 如果需要删除源组
        if (options.deleteSourceGroups && sourceGroupIds.includes(group.id)) {
          return null;
        }
        
        return group;
      }).filter(Boolean) as TabGroup[];
      
      // 保存更新后的标签组
      await storage.setGroups(updatedGroups);
      
      logger.success('批量合并标签组完成', {
        processedCount,
        totalTabs: allTabs.length,
        deletedGroups: options.deleteSourceGroups ? sourceGroups.length : 0
      });
      
      return {
        success: true,
        processedCount,
        failedCount: sourceGroupIds.length - sourceGroups.length,
        totalCount: sourceGroupIds.length,
        errors,
        warnings
      };
    } catch (error) {
      const message = errorHandler.getErrorMessage(error);
      logger.error('批量合并标签组失败', error);
      
      return {
        success: false,
        processedCount: 0,
        failedCount: sourceGroupIds.length,
        totalCount: sourceGroupIds.length,
        errors: [message],
        warnings: []
      };
    }
  }
  
  /**
   * 转义HTML字符
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
  
  /**
   * 获取操作预览信息
   */
  getOperationPreview(
    operation: BatchOperationType,
    groupIds: string[],
    groups: TabGroup[]
  ): {
    title: string;
    description: string;
    affectedGroups: TabGroup[];
    totalTabs: number;
    warnings: string[];
  } {
    const affectedGroups = groups.filter(g => groupIds.includes(g.id));
    const totalTabs = affectedGroups.reduce((sum, group) => sum + group.tabs.length, 0);
    const warnings: string[] = [];
    
    let title: string;
    let description: string;
    
    switch (operation) {
      case 'delete':
        title = '批量删除标签组';
        description = `将删除 ${affectedGroups.length} 个标签组，包含 ${totalTabs} 个标签`;
        warnings.push('此操作不可撤销，请确认后继续');
        break;
        
      case 'lock':
        title = '批量锁定标签组';
        description = `将锁定 ${affectedGroups.length} 个标签组`;
        break;
        
      case 'unlock':
        title = '批量解锁标签组';
        description = `将解锁 ${affectedGroups.length} 个标签组`;
        break;
        
      case 'export':
        title = '批量导出标签组';
        description = `将导出 ${affectedGroups.length} 个标签组，包含 ${totalTabs} 个标签`;
        break;
        
      default:
        title = '批量操作';
        description = `将对 ${affectedGroups.length} 个标签组执行操作`;
    }
    
    return {
      title,
      description,
      affectedGroups,
      totalTabs,
      warnings
    };
  }
}

// 导出单例实例
export const batchOperationService = new BatchOperationService();
