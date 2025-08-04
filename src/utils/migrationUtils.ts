/**
 * 数据迁移工具
 * 用于处理应用版本升级时的数据迁移
 */

import { storage } from './storage';
import { sanitizeFaviconUrl } from './faviconUtils';
import { TabGroup } from '@/types/tab';

/**
 * 迁移现有数据中的 favicon URLs，确保符合 CSP 策略
 */
export async function migrateFaviconUrls(): Promise<void> {
  try {
    console.log('开始迁移 favicon URLs...');
    
    // 获取所有标签组
    const groups = await storage.getGroups();
    let migrationCount = 0;
    let totalTabs = 0;
    
    // 处理每个标签组
    const migratedGroups: TabGroup[] = groups.map(group => {
      const migratedTabs = group.tabs.map(tab => {
        totalTabs++;
        
        // 检查 favicon 是否需要迁移
        if (tab.favicon) {
          const sanitizedFavicon = sanitizeFaviconUrl(tab.favicon);
          
          // 如果清理后的 URL 与原 URL 不同，说明进行了迁移
          if (sanitizedFavicon !== tab.favicon) {
            migrationCount++;
            console.log(`迁移 favicon: ${tab.favicon} -> ${sanitizedFavicon || '(已移除)'}`);
          }
          
          return {
            ...tab,
            favicon: sanitizedFavicon
          };
        }
        
        return tab;
      });
      
      return {
        ...group,
        tabs: migratedTabs
      };
    });
    
    // 如果有数据被迁移，保存更新后的数据
    if (migrationCount > 0) {
      await storage.setGroups(migratedGroups);
      console.log(`favicon 迁移完成: 共处理 ${totalTabs} 个标签，迁移了 ${migrationCount} 个 favicon`);
    } else {
      console.log(`favicon 迁移检查完成: 共检查 ${totalTabs} 个标签，无需迁移`);
    }
    
    // 标记迁移已完成
    await storage.setMigrationFlag('favicon_urls_v1', true);
    
  } catch (error) {
    console.error('迁移 favicon URLs 失败:', error);
    throw error;
  }
}

/**
 * 检查是否需要运行特定的迁移
 * @param migrationKey 迁移标识
 * @returns 是否需要运行迁移
 */
export async function shouldRunMigration(migrationKey: string): Promise<boolean> {
  try {
    const migrationFlags = await storage.getMigrationFlags();
    return !migrationFlags[migrationKey];
  } catch (error) {
    console.error(`检查迁移状态失败 (${migrationKey}):`, error);
    // 如果检查失败，为了安全起见，假设需要运行迁移
    return true;
  }
}

/**
 * 运行所有必要的数据迁移
 */
export async function runMigrations(): Promise<void> {
  try {
    console.log('开始检查数据迁移...');
    
    // 检查并运行 favicon URLs 迁移
    if (await shouldRunMigration('favicon_urls_v1')) {
      await migrateFaviconUrls();
    }
    
    console.log('数据迁移检查完成');
    
  } catch (error) {
    console.error('数据迁移失败:', error);
    // 不抛出错误，避免影响应用启动
  }
}
