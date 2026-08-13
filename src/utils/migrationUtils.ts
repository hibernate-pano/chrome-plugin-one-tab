/**
 * 数据迁移工具
 * 用于处理应用版本升级时的数据迁移
 */

import { storage } from './storage';
import { sanitizeFaviconUrl } from './faviconUtils';
import { kvRemove } from '@/storage/storageAdapter';
import { TabGroup } from '@/types/tab';
import { migrationError } from './errors';

/**
 * 迁移现有数据中的 favicon URLs，确保符合 CSP 策略
 */
export async function migrateFaviconUrls(): Promise<void> {
  try {
    console.log('开始迁移 favicon URLs...');
    
    // 获取所有标签组
    const groups = await storage.getGroupsOrThrow();
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
    
    // 标记迁移已完成（v2 key——v1.15.3 起白名单收紧，需要区分新旧用户）
    await storage.setMigrationFlag('favicon_urls_v2', true);
    
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

export async function removeRecentRestoreHistory(): Promise<void> {
  try {
    await kvRemove('recent_restores');
    await storage.setMigrationFlag('recent_restore_history_removed_v1', true);
  } catch (error) {
    console.error('移除最近恢复历史失败:', error);
    throw error;
  }
}

/**
 * 运行所有必要的数据迁移
 */
export async function runMigrations(): Promise<void> {
  try {
    console.log('开始检查数据迁移...');

    // favicon_urls_v2：v1.15.3 起收紧白名单（http:/chrome-extension: → 不可用）。
    // 用新 key v2 而不是 v1，让从 v1.15.x 升上来的用户**重新跑一次**迁移：
    // 旧版本已写入 IndexedDB 的 favicon 字段可能含 http:// 或 chrome-extension://
    // 等当前不再合规的协议，必须清掉否则刷新后会触发 CSP img-src 拦截。
    if (await shouldRunMigration('favicon_urls_v2')) {
      await migrateFaviconUrls();
    }

    if (await shouldRunMigration('recent_restore_history_removed_v1')) {
      await removeRecentRestoreHistory();
    }

    console.log('数据迁移检查完成');

  } catch (error) {
    console.error('数据迁移失败:', error);
    // S1: 包一层 MigrationError（retryable=false）再抛出，让调用方能识别
    // 「升级失败」——数据本身仍在 IndexedDB，只是迁移没跑完（旧数据保留）。
    // 调用方（TabList.initializeData）已有 try/catch，不会因此中断启动。
    throw migrationError(error instanceof Error ? error.message : '数据迁移失败', {
      cause: error,
      userMessage: '升级失败，旧数据已保留',
    });
  }
}
