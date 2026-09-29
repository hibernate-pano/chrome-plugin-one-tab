import { storage } from './storage';
import { initializeVersionFields } from '@/core/versionHelper';
import { logError, logInfo } from './log';

/**
 * 数据迁移到 v2.0
 * 为所有标签组添加 version 和 displayOrder 字段
 *
 * 读路径必须用 getGroupsForWrite()：本迁移在 SW 启动时跑（service-worker
 * runMigrations），而 getGroups() 有 30s 进程内缓存、且不感知 popup 上下文的
 * 写入——拿陈旧快照整表写回会抹掉同期由 popup 写入的会话（详见
 * storage.getGroupsForWrite 注释）。
 */
export async function migrateToV2(): Promise<void> {
  try {
    const groups = await storage.getGroupsForWrite();

    // 检查是否需要迁移
    const needsMigration = groups.some(g => g.version === undefined || g.displayOrder === undefined);

    if (!needsMigration) {
      logInfo('[Migration] 数据已是 v2.0 格式，无需迁移');
      return;
    }

    logInfo(`[Migration] 开始迁移 ${groups.length} 个标签组到 v2.0 格式...`);

    // 初始化 version 和 displayOrder
    const migratedGroups = groups.map((group, index) =>
      initializeVersionFields(group, index)
    );

    // 保存迁移后的数据
    // 直写落盘：迁移是整表重写，不挤在 500ms 防抖窗口里——SW 可能随时被回收，
    // 窗口期内的迁移结果会直接丢（与 purgeTombstones 同一写路径）。
    await storage.setGroupsImmediate(migratedGroups);

    logInfo('[Migration] 迁移完成！');
    logInfo(`[Migration] 已初始化 ${migratedGroups.length} 个标签组的 version 和 displayOrder`);

  } catch (error) {
    logError('[Migration] 迁移失败:', error);
    throw error;
  }
}

