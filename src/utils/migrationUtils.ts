/**
 * 数据迁移工具
 * 用于处理应用版本升级时的数据迁移
 */

import { storage, STORAGE_KEYS } from './storage';
import { sanitizeFaviconUrl } from './faviconUtils';
import { kvRemove } from '@/storage/storageAdapter';
import { TabGroup } from '@/types/tab';
import { logError, logInfo } from './log';

/**
 * 迁移现有数据中的 favicon URLs，确保符合 CSP 策略
 *
 * 读路径必须用 getGroupsForWrite()，理由分两层（2026-10-09 修订）：
 *
 * 【跨 realm 互斥 —— 由调用方保证】本文件的三个迁移原先由 TabList 在 popup
 * realm 直接跑，与 SW 的 mutation / sync:download 零互斥，用陈旧快照整表写回
 * 会抹掉同期刚保存的会话（P0）。现在全部搬进 SW 单写者队列执行：
 * TabList 发 RUN_MIGRATIONS → service-worker 的 RUN_MIGRATIONS 分支
 * `enqueue('storageMigrations', () => runStorageMigrations())`。
 *
 * 【本进程陈旧 —— 由 getGroupsForWrite() 保证】进了队列只保证「没有并发写」，
 * **不保证自己读到的是最新快照**：getGroups() 有 30s 进程内缓存，且防抖窗口
 * 里 pending 的写可能还没落盘。所以读-改-写仍然必须走 getGroupsForWrite()
 * （先 flush 再失效缓存）。
 *
 * 两层缺一不可：只有入队没有 fresh read ⇒ 拿自己的旧快照覆盖掉自己的 pending；
 * 只有 fresh read 没有入队 ⇒ 与其它 realm 并发，拿快照覆盖别人刚写的。
 * 详见 storage.getGroupsForWrite 的注释。
 */
export async function migrateFaviconUrls(): Promise<void> {
  try {
    logInfo('开始迁移 favicon URLs...');

    // 获取所有标签组（写路径新鲜读：先 flush pending 防抖写、失效缓存，再读真值）
    const groups = await storage.getGroupsForWrite();
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
            logInfo(`迁移 favicon: ${tab.favicon} -> ${sanitizedFavicon || '(已移除)'}`);
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
      // 直写落盘（与 purgeTombstones / mutation 同一写路径）：迁移是整表重写，
      // 不该挤在 500ms 防抖窗口里等定时器——popup 随时可能被销毁。
      await storage.setGroupsImmediate(migratedGroups);
      logInfo(`favicon 迁移完成: 共处理 ${totalTabs} 个标签，迁移了 ${migrationCount} 个 favicon`);
    } else {
      logInfo(`favicon 迁移检查完成: 共检查 ${totalTabs} 个标签，无需迁移`);
    }
    
    // 标记迁移已完成
    await storage.setMigrationFlag('favicon_urls_v1', true);
    
  } catch (error) {
    logError('迁移 favicon URLs 失败:', error);
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
    logError(`检查迁移状态失败 (${migrationKey}):`, error);
    // 如果检查失败，为了安全起见，假设需要运行迁移
    return true;
  }
}

export async function removeRecentRestoreHistory(): Promise<void> {
  try {
    await kvRemove('recent_restores');
    await storage.setMigrationFlag('recent_restore_history_removed_v1', true);
  } catch (error) {
    logError('移除最近恢复历史失败:', error);
    throw error;
  }
}

/**
 * 无墓碑模型迁移（2026-09-29 产品拍板：删除即物理移除，回收站/恢复废除）。
 *
 * 1. 清除本地组级墓碑（isDeleted 组，即旧「回收站」内容——含其中尚未恢复的标签）
 *    与组内标签级墓碑（历史单删/清理重复/合并去重累积的不可见死标签）。
 *    墓碑组的删除意图**先登记进 pendingDeleteIds 再物理移除**（1.22.10 修复）：
 *    旧注释假设「未上过云的残留由下一次 upload 的兜底标记覆盖」，但那个兜底
 *    （syncEngine.upload 的 legacyTombstoneIds）读的是 storage 里的 isDeleted 组——
 *    本迁移一旦把组从 storage 删掉，兜底就永远读不到它们。凡「离线删除 + 墓碑从未
 *    上过云（上传失败/未登录/升级前从未同步）+ 升级到 1.22.x」的组，云端行仍是
 *    活跃行，下次下载合并走 mergeOpStamped 的 cg && !lg 分支整组复活。登记顺序
 *    也只能先登记后移除：崩溃窗口落在「已登记、未移除」侧顶多重广播一次（幂等），
 *    反过来就是本缺陷本身。
 * 2. 旧 purge 队列（PENDING_PURGE_IDS，空壳硬删除遗留）转入删除广播队列
 *    PENDING_DELETE_IDS——标记删除（行保留）比物理删保守且语义正确。
 * 3. 删除旧「回收站列表」遗留键（DELETED_GROUPS / DELETED_TABS，早期实现，已死代码）。
 */
export async function purgeTombstones(): Promise<void> {
  try {
    // 写路径新鲜读：purgeTombstones 在 1.22.0 升级当天首次运行，是最不该
    // 拿陈旧快照整表写回去的时刻（见 storage.getGroupsForWrite 注释）。
    const groups = await storage.getGroupsForWrite();
    const hadGroupTombstones = groups.some(g => g.isDeleted);
    const hadTabTombstones = groups.some(g => g.tabs?.some(t => t.isDeleted));

    if (hadGroupTombstones || hadTabTombstones) {
      // 墓碑组的删除意图登记进广播队列（幂等去重；addPendingDeleteIds 失败会抛错，
      // 迁移整体中止、标志位不置位，下次启动重跑——绝不能在意图没落盘时就把组删掉）。
      const tombstoneGroupIds = groups.filter(g => g.isDeleted).map(g => g.id);
      await storage.addPendingDeleteIds(tombstoneGroupIds);

      const activeGroups = groups
        .filter(g => !g.isDeleted)
        .map(g =>
          g.tabs?.some(t => t.isDeleted)
            ? { ...g, tabs: g.tabs.filter(t => !t.isDeleted) }
            : g
        );
      // SW/后台语境同类写路径：直写落盘（迁移一次性，不经防抖窗口）
      await storage.setGroupsImmediate(activeGroups);
      const removedGroups = groups.length - activeGroups.length;
      const removedTabs = groups.reduce(
        (n, g) => n + (g.tabs?.filter(t => t.isDeleted).length ?? 0),
        0
      );
      logInfo(`[迁移] 无墓碑清理：移除 ${removedGroups} 个墓碑组（回收站内容）、${removedTabs} 个墓碑标签；` +
        `${tombstoneGroupIds.length} 条删除意图已登记进广播队列`);
    }

    // 旧 purge 队列 → 删除广播队列（标记删除语义，云端行保留广播删除意图）
    const legacyPurgeIds = await storage.getPendingPurgeIds();
    // 批量登记：旧队列可能很长，逐条是 2N 次 KV 往返。
    await storage.addPendingDeleteIds(legacyPurgeIds);

    // 遗留键清理（旧回收站列表 + 旧 purge 队列）
    await kvRemove(STORAGE_KEYS.DELETED_GROUPS);
    await kvRemove(STORAGE_KEYS.DELETED_TABS);
    await kvRemove(STORAGE_KEYS.PENDING_PURGE_IDS);

    await storage.setMigrationFlag('tombstones_removed_v1', true);
  } catch (error) {
    logError('无墓碑清理迁移失败:', error);
    throw error;
  }
}

/**
 * 运行所有必要的数据迁移
 */
export async function runMigrations(): Promise<void> {
  logInfo('开始检查数据迁移...');

  // 检查并运行 favicon URLs 迁移
  if (await shouldRunMigration('favicon_urls_v1')) {
    await migrateFaviconUrls();
  }

  if (await shouldRunMigration('recent_restore_history_removed_v1')) {
    await removeRecentRestoreHistory();
  }

  if (await shouldRunMigration('tombstones_removed_v1')) {
    await purgeTombstones();
  }

  logInfo('数据迁移检查完成');
}

// ── 2026-10-09：错误不再在这里吞掉 ──────────────────────────────────────
//
// 旧实现 `catch { logError(...) }` 并注释「不抛出错误，避免影响应用启动」。
// 在**当前调用结构**下这条理由已经不成立，且吞错会制造新的谎报成功：
//   - 调用方只剩 service-worker 的 RUN_MIGRATIONS 分支（单写者队列内）；
//   - 那里靠返回值把成败回给 TabList，若本函数吞掉错误，它永远回
//     `{success:true}` —— 迁移失败与成功在 UI 和日志里完全同形；
//   - 「不抛出 = 应用能启动」的保护现在由**调用方**负责：TabList 的 catch
//     照常 dispatch(loadGroups())，SW 的 runMigrations 也各自 try/catch。
//     应用启动与迁移失败已解耦，不需要这一层再吞一次。
//
// 【为什么子函数的 try/catch 仍然保留】migrateFaviconUrls / purgeTombstones /
// removeRecentRestoreHistory 各自的 catch 是为了**就地打日志再 rethrow**，
// 与这里不是同一层；这里原先的 catch 只吞不抛，才是谎报成功的源头。
//
// 迁移失败的后果（子函数已按幂等设计）：标志位不置位 ⇒ 下次启动重跑。
// 三件迁移都在 try 里、逐个短路，失败即中止本轮，绝不带着半成品继续。
