/**
 * 迁移管理器
 * 确保数据迁移只执行一次
 */

let migrationCompleted = false;
let migrationPromise: Promise<void> | null = null;

/**
 * 执行所有必要的数据迁移
 * 使用单例模式确保只执行一次
 */
export async function ensureMigrations(): Promise<void> {
  // 如果已经完成,直接返回
  if (migrationCompleted) {
    return Promise.resolve();
  }

  // 如果正在执行,返回现有的 Promise
  if (migrationPromise) {
    return migrationPromise;
  }

  // 开始执行迁移
  migrationPromise = (async () => {
    try {
      console.log('[Migration] 开始执行数据迁移...');

      // 动态导入迁移模块,避免循环依赖
      const { runMigrations } = await import('./migrationUtils');
      const { migrateToV2 } = await import('./migrationHelper');

      // 执行迁移
      await runMigrations();
      await migrateToV2();

      migrationCompleted = true;
      console.log('[Migration] 数据迁移完成');
    } catch (error) {
      console.error('[Migration] 数据迁移失败:', error);
      // 即使失败也标记为完成,避免无限重试
      migrationCompleted = true;
      throw error;
    }
  })();

  return migrationPromise;
}

/**
 * 重置迁移状态(仅用于测试)
 */
export function resetMigrationState(): void {
  migrationCompleted = false;
  migrationPromise = null;
}
