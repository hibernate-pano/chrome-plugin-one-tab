/**
 * 数据迁移服务
 * 处理旧版本数据到新版本（带版本号）的迁移
 */

import { TabGroup } from '@/shared/types/tab';
import { storage } from '@/shared/utils/storage';
import { logger } from '@/shared/utils/logger';

export class DataMigrationService {
  private readonly MIGRATION_VERSION_KEY = 'migration_version';
  private readonly CURRENT_MIGRATION_VERSION = 1;

  /**
   * 检查并执行必要的数据迁移
   */
  async checkAndMigrate(): Promise<void> {
    try {
      const currentVersion = await this.getCurrentMigrationVersion();
      
      if (currentVersion < this.CURRENT_MIGRATION_VERSION) {
        logger.info(`开始数据迁移: v${currentVersion} -> v${this.CURRENT_MIGRATION_VERSION}`);
        
        await this.performMigration(currentVersion);
        await this.setMigrationVersion(this.CURRENT_MIGRATION_VERSION);
        
        logger.info('数据迁移完成');
      } else {
        logger.debug('数据已是最新版本，无需迁移');
      }
    } catch (error) {
      logger.error('数据迁移失败:', error);
      throw error;
    }
  }

  /**
   * 获取当前迁移版本
   */
  private async getCurrentMigrationVersion(): Promise<number> {
    try {
      const result = await chrome.storage.local.get(this.MIGRATION_VERSION_KEY);
      return result[this.MIGRATION_VERSION_KEY] || 0;
    } catch (error) {
      logger.error('获取迁移版本失败:', error);
      return 0;
    }
  }

  /**
   * 设置迁移版本
   */
  private async setMigrationVersion(version: number): Promise<void> {
    try {
      await chrome.storage.local.set({ [this.MIGRATION_VERSION_KEY]: version });
    } catch (error) {
      logger.error('设置迁移版本失败:', error);
      throw error;
    }
  }

  /**
   * 执行迁移
   */
  private async performMigration(fromVersion: number): Promise<void> {
    if (fromVersion === 0) {
      // 从版本0迁移到版本1：添加版本号字段
      await this.migrateToVersion1();
    }
  }

  /**
   * 迁移到版本1：为所有标签组添加版本号
   */
  private async migrateToVersion1(): Promise<void> {
    logger.info('执行迁移到版本1：添加版本号字段');

    try {
      // 获取现有的标签组数据
      const groups = await storage.getGroups();
      
      if (groups.length === 0) {
        logger.info('没有需要迁移的标签组数据');
        return;
      }

      // 为每个标签组添加版本号
      const migratedGroups: TabGroup[] = groups.map(group => ({
        ...group,
        version: group.version || 1, // 如果已有版本号则保持，否则设为1
      }));

      // 保存迁移后的数据
      await storage.setGroups(migratedGroups);
      
      logger.info(`成功迁移 ${migratedGroups.length} 个标签组到版本1`);

      // 同时迁移本地存储中的其他相关数据
      await this.migrateLocalStorageData();

    } catch (error) {
      logger.error('迁移到版本1失败:', error);
      throw error;
    }
  }

  /**
   * 迁移本地存储中的其他数据
   */
  private async migrateLocalStorageData(): Promise<void> {
    try {
      // 检查是否有旧格式的数据需要迁移
      const result = await chrome.storage.local.get(['tabGroups', 'groups']);
      
      if (result.tabGroups && Array.isArray(result.tabGroups)) {
        // 迁移旧的tabGroups数据
        const oldGroups = result.tabGroups as any[];
        const migratedGroups: TabGroup[] = oldGroups.map(group => ({
          ...group,
          version: 1,
          // 确保必要字段存在
          id: group.id || this.generateId(),
          name: group.name || '未命名标签组',
          tabs: group.tabs || [],
          createdAt: group.createdAt || new Date().toISOString(),
          updatedAt: group.updatedAt || new Date().toISOString(),
          isLocked: group.isLocked || false,
        }));

        // 使用新的存储格式
        await storage.setGroups(migratedGroups);
        
        // 清理旧数据
        await chrome.storage.local.remove(['tabGroups']);
        
        logger.info(`迁移了 ${migratedGroups.length} 个旧格式的标签组`);
      }

      if (result.groups && Array.isArray(result.groups)) {
        // 如果groups数据存在但没有版本号，添加版本号
        const groups = result.groups as any[];
        const needsMigration = groups.some(group => typeof group.version === 'undefined');
        
        if (needsMigration) {
          const migratedGroups: TabGroup[] = groups.map(group => ({
            ...group,
            version: group.version || 1,
          }));
          
          await storage.setGroups(migratedGroups);
          logger.info(`为 ${migratedGroups.length} 个标签组添加了版本号`);
        }
      }

    } catch (error) {
      logger.error('迁移本地存储数据失败:', error);
      // 不抛出错误，因为这不是关键操作
    }
  }

  /**
   * 生成ID（用于修复缺失的ID）
   */
  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }

  /**
   * 验证迁移结果
   */
  async validateMigration(): Promise<boolean> {
    try {
      const groups = await storage.getGroups();
      
      // 检查所有标签组是否都有版本号
      const hasVersionNumbers = groups.every(group => 
        typeof group.version === 'number' && group.version >= 1
      );

      if (!hasVersionNumbers) {
        logger.error('迁移验证失败：存在没有版本号的标签组');
        return false;
      }

      // 检查必要字段
      const hasRequiredFields = groups.every(group => 
        group.id && 
        group.name && 
        Array.isArray(group.tabs) &&
        group.createdAt &&
        group.updatedAt &&
        typeof group.isLocked === 'boolean'
      );

      if (!hasRequiredFields) {
        logger.error('迁移验证失败：存在缺少必要字段的标签组');
        return false;
      }

      logger.info(`迁移验证成功：${groups.length} 个标签组数据完整`);
      return true;

    } catch (error) {
      logger.error('迁移验证失败:', error);
      return false;
    }
  }

  /**
   * 紧急回滚（如果迁移出现问题）
   */
  async emergencyRollback(): Promise<void> {
    try {
      logger.warn('执行紧急回滚');
      
      // 尝试从备份恢复数据
      const backupResult = await chrome.storage.local.get('groups_backup');
      
      if (backupResult.groups_backup) {
        await storage.setGroups(backupResult.groups_backup);
        logger.info('从备份恢复数据成功');
      } else {
        logger.warn('没有找到备份数据');
      }

      // 重置迁移版本
      await this.setMigrationVersion(0);
      
    } catch (error) {
      logger.error('紧急回滚失败:', error);
      throw error;
    }
  }

  /**
   * 创建数据备份
   */
  async createBackup(): Promise<void> {
    try {
      const groups = await storage.getGroups();
      await chrome.storage.local.set({ 
        groups_backup: groups,
        backup_timestamp: new Date().toISOString()
      });
      
      logger.info(`创建数据备份成功：${groups.length} 个标签组`);
    } catch (error) {
      logger.error('创建数据备份失败:', error);
      // 不抛出错误，因为备份失败不应该阻止正常流程
    }
  }
}

export const dataMigration = new DataMigrationService();
