import { storage } from './storage';
import { initializeVersionFields } from './versionHelper';

/**
 * 数据迁移到 v2.0
 * 为所有标签组添加 version 和 displayOrder 字段
 */
export async function migrateToV2(): Promise<void> {
  try {
    const groups = await storage.getGroups();

    // 检查是否需要迁移
    const needsMigration = groups.some(g => g.version === undefined || g.displayOrder === undefined);

    if (!needsMigration) {
      console.log('[Migration] 数据已是 v2.0 格式，无需迁移');
      return;
    }

    console.log(`[Migration] 开始迁移 ${groups.length} 个标签组到 v2.0 格式...`);

    // 初始化 version 和 displayOrder
    const migratedGroups = groups.map((group, index) =>
      initializeVersionFields(group, index)
    );

    // 保存迁移后的数据
    await storage.setGroups(migratedGroups);

    console.log('[Migration] 迁移完成！');
    console.log(`[Migration] 已初始化 ${migratedGroups.length} 个标签组的 version 和 displayOrder`);

  } catch (error) {
    console.error('[Migration] 迁移失败:', error);
    throw error;
  }
}

/**
 * 获取迁移状态
 */
export async function getMigrationStatus(): Promise<{
  isV2: boolean;
  totalGroups: number;
  migratedGroups: number;
}> {
  const groups = await storage.getGroups();

  const migratedGroups = groups.filter(
    g => g.version !== undefined && g.displayOrder !== undefined
  );

  return {
    isV2: migratedGroups.length === groups.length,
    totalGroups: groups.length,
    migratedGroups: migratedGroups.length,
  };
}
