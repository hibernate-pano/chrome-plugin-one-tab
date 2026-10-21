import { storage } from './storage';
import { initializeVersionFields } from '@/core/versionHelper';
import { logError, logInfo } from './log';

/**
 * 数据迁移到 v2.0
 * 为所有标签组添加 version 字段
 *
 * 读路径必须用 getGroupsForWrite()：本迁移在 SW 启动时跑（service-worker
 * runMigrations），而 getGroups() 有 30s 进程内缓存、且不感知 popup 上下文的
 * 写入——拿陈旧快照整表写回会抹掉同期由 popup 写入的会话（详见
 * storage.getGroupsForWrite 注释）。
 *
 * ── 2026-10-20 审计 A-10：这里曾经还填 `displayOrder` ─────────────────────
 * 原判断是 `g.version === undefined || g.displayOrder === undefined`，而
 * `displayOrder` 是一个**存着但从不被读来排序**的死字段（列表排序一律按
 * `createdAt` 倒序，会话组级拖拽排序早已下线）。它让每次同步都在往返一个
 * 永远无效的字段，还让 WebDAV 与 Supabase 两条后端的会话形状不一致
 * （前者带、后者不带）⇒ 同一份数据在两条路径上解出来不一样。
 * 现在只迁移 `version`（它是真的在用：变更判定、印记序号、云端 version 守卫列）。
 *
 * ⚠️ 刻意**不**加「把老数据里的 displayOrder 清掉」的迁移：那是在给一个
 * 没人读的字段做无用功。老用户本地存储里多留的那个键会被**忽略**（无害）。
 */
export async function migrateToV2(): Promise<void> {
  try {
    const groups = await storage.getGroupsForWrite();

    // 检查是否需要迁移
    const needsMigration = groups.some(g => g.version === undefined);

    if (!needsMigration) {
      logInfo('[Migration] 数据已是 v2.0 格式，无需迁移');
      return;
    }

    logInfo(`[Migration] 开始迁移 ${groups.length} 个标签组到 v2.0 格式...`);

    // 初始化 version
    const migratedGroups = groups.map(group => initializeVersionFields(group));

    // 保存迁移后的数据
    // 直写落盘：迁移是整表重写，不挤在 500ms 防抖窗口里——SW 可能随时被回收，
    // 窗口期内的迁移结果会直接丢（与 purgeTombstones 同一写路径）。
    await storage.setGroupsImmediate(migratedGroups);

    logInfo('[Migration] 迁移完成！');
    logInfo(`[Migration] 已初始化 ${migratedGroups.length} 个标签组的 version`);

  } catch (error) {
    logError('[Migration] 迁移失败:', error);
    throw error;
  }
}

