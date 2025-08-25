/**
 * 数据库Schema管理服务
 * 检测和管理Supabase数据库schema的变更
 */

import { supabase } from '@/shared/utils/supabase';
import { logger } from '@/shared/utils/logger';

export interface SchemaInfo {
  hasVersionColumn: boolean;
  tableExists: boolean;
  columns: string[];
}

export class DatabaseSchemaManager {
  private schemaCache: Map<string, SchemaInfo> = new Map();
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5分钟缓存
  private lastCacheTime = 0;

  /**
   * 检查tab_groups表的schema信息
   */
  async checkTabGroupsSchema(): Promise<SchemaInfo> {
    const cacheKey = 'tab_groups';
    const now = Date.now();

    // 检查缓存
    if (this.schemaCache.has(cacheKey) && (now - this.lastCacheTime) < this.CACHE_DURATION) {
      return this.schemaCache.get(cacheKey)!;
    }

    try {
      logger.info('检查tab_groups表schema');

      // 检查表是否存在以及列信息
      const { data, error } = await supabase
        .from('tab_groups')
        .select('*')
        .limit(1);

      if (error) {
        logger.error('检查schema失败:', error);
        return {
          hasVersionColumn: false,
          tableExists: false,
          columns: []
        };
      }

      // 通过尝试查询version列来检查是否存在
      let hasVersionColumn = false;
      try {
        const { error: versionError } = await supabase
          .from('tab_groups')
          .select('version')
          .limit(1);
        
        hasVersionColumn = !versionError;
      } catch (e) {
        hasVersionColumn = false;
      }

      const schemaInfo: SchemaInfo = {
        hasVersionColumn,
        tableExists: true,
        columns: data && data.length > 0 ? Object.keys(data[0]) : []
      };

      // 更新缓存
      this.schemaCache.set(cacheKey, schemaInfo);
      this.lastCacheTime = now;

      logger.info('Schema检查完成:', schemaInfo);
      return schemaInfo;

    } catch (error) {
      logger.error('Schema检查异常:', error);
      return {
        hasVersionColumn: false,
        tableExists: false,
        columns: []
      };
    }
  }

  /**
   * 尝试自动添加version列（需要管理员权限）
   */
  async tryAddVersionColumn(): Promise<boolean> {
    try {
      logger.info('尝试自动添加version列');

      // 注意：这需要数据库管理员权限，在生产环境中通常不可用
      const { error } = await supabase.rpc('add_version_column_if_not_exists');

      if (error) {
        logger.warn('自动添加version列失败:', error.message);
        return false;
      }

      // 清除缓存，强制重新检查
      this.clearCache();
      
      logger.info('✅ version列添加成功');
      return true;

    } catch (error) {
      logger.warn('自动添加version列异常:', error);
      return false;
    }
  }

  /**
   * 创建兼容性的上传数据
   */
  prepareUploadData(groups: any[], schemaInfo: SchemaInfo): any[] {
    return groups.map(group => {
      const uploadData: any = {
        id: group.id,
        name: group.name,
        created_at: group.created_at,
        updated_at: group.updated_at,
        is_locked: group.is_locked,
        user_id: group.user_id,
        device_id: group.device_id,
        last_sync: group.last_sync,
        tabs_data: group.tabs_data
      };

      // 只有在数据库支持version列时才添加
      if (schemaInfo.hasVersionColumn && group.version !== undefined) {
        uploadData.version = group.version;
      }

      return uploadData;
    });
  }

  /**
   * 处理下载数据的兼容性
   */
  processDownloadData(groups: any[]): any[] {
    return groups.map(group => ({
      ...group,
      version: group.version || 1 // 如果没有version字段，默认为1
    }));
  }

  /**
   * 清除schema缓存
   */
  clearCache(): void {
    this.schemaCache.clear();
    this.lastCacheTime = 0;
  }

  /**
   * 获取数据库迁移建议
   */
  async getMigrationAdvice(): Promise<string[]> {
    const schemaInfo = await this.checkTabGroupsSchema();
    const advice: string[] = [];

    if (!schemaInfo.tableExists) {
      advice.push('❌ tab_groups表不存在，需要创建基础表结构');
      return advice;
    }

    if (!schemaInfo.hasVersionColumn) {
      advice.push('⚠️ 缺少version列，需要执行数据库迁移');
      advice.push('请在Supabase SQL编辑器中执行以下命令：');
      advice.push('ALTER TABLE tab_groups ADD COLUMN version INTEGER DEFAULT 1 NOT NULL;');
      advice.push('UPDATE tab_groups SET version = 1 WHERE version IS NULL;');
    } else {
      advice.push('✅ 数据库schema已是最新版本');
    }

    return advice;
  }

  /**
   * 生成迁移SQL脚本
   */
  generateMigrationSQL(): string {
    return `
-- OneTabPlus 数据库迁移脚本
-- 添加version列以支持乐观锁机制

-- 1. 添加version列
ALTER TABLE tab_groups 
ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1 NOT NULL;

-- 2. 更新现有数据
UPDATE tab_groups 
SET version = 1 
WHERE version IS NULL;

-- 3. 添加索引
CREATE INDEX IF NOT EXISTS idx_tab_groups_version 
ON tab_groups(version);

-- 4. 验证迁移
SELECT 
    column_name,
    data_type,
    is_nullable,
    column_default
FROM information_schema.columns 
WHERE table_name = 'tab_groups' 
AND column_name = 'version';
    `.trim();
  }

  /**
   * 检查是否需要显示迁移提示
   */
  async shouldShowMigrationPrompt(): Promise<boolean> {
    const schemaInfo = await this.checkTabGroupsSchema();
    return schemaInfo.tableExists && !schemaInfo.hasVersionColumn;
  }
}

export const databaseSchemaManager = new DatabaseSchemaManager();
