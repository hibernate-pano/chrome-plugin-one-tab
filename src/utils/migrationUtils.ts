/**
 * 数据迁移工具
 * 用于处理应用版本升级时的数据迁移
 */

import { storage, STORAGE_KEYS } from './storage';
import { sanitizeFaviconUrl } from './faviconUtils';
import { kvRemove } from '@/storage/storageAdapter';
import { TabGroup } from '@/types/tab';
import { logError, logInfo } from './log';
import {
  hasOrphanedGroupFields,
  migrateOrphanedGroupFields,
} from '@/core/orphanedGroupFields';

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
 * 收敛 1.22.13 下线的「会话备注 / 收藏」残留字段（2026-10-20 审计 U-1）。
 *
 * ── 为什么必须有这条迁移 ────────────────────────────────────────────────
 * 1.22.13 把那两项功能整条下线（提交 `a7671ef`），但**用户磁盘上的数据没人管**：
 * 存储层不裁字段 ⇒ 数据还在；产品里却**没有任何入口能看见、编辑、搜到它**
 * ⇒ 变成孤儿数据。一次跨端合并（`core/opStampMerge.ts` 的「活跃 vs 活跃：整组
 * 覆盖，赢家通吃」）会把本地那份换成云端版本 ⇒ **字段物理消失，不可恢复**
 * （v1.22.0 起无回收站、删除即物理清除）。
 *
 * ── 处置口径（产品负责人 2026-10-20 拍板）────────────────────────────────
 * · **用户写下的文字**（备注）→ 并进 `name`（`原名 · 原文`）：
 *   name 是唯一既看得见、又编辑得了、还导得出的会话级文本字段 ⇒
 *   这是把用户的话救回「可见 + 可编辑 + 可导出」的唯一路径。
 *   用明确分隔符并进去 ⇒ 原名与原文都**原样可辨认**、可反向拆出。
 * · **布尔开关**（收藏标记）→ **丢弃**：它的全部功能（列表置顶）已随
 *   1.22.13 下线，剩下的信息量只有「用户标记过」这一个布尔位；把它编码进
 *   name 等于**把已下线的功能换个形状复活**（且会让纯本机偏好跟着上云、
 *   在别的设备上产生语义漂移）。
 * · **不复活功能**：类型 / UI / 搜索一律不加回去 —— 那是 1.22.13 的产品决定，
 *   本仓有 4 条守卫钉死（`tests/p0DataSafetyGuards.test.ts`）。
 *
 * ── 四条硬约束（与本文件另外两个迁移同口径）─────────────────────────────
 * 1. **无残留 ⇒ 一个字都不改、不写盘**（连 `setGroupsImmediate` 都不调）。
 *    「顺手统一格式」是数据安全的敌人 —— 那会让每一次启动都整表重写。
 * 2. **不改 `lastOp`**：它是跨端整组覆盖的**裁决依据**，动它 = 改仲裁结果。
 * 3. **不改 `updatedAt`**：它参与变更判定与排序。
 * 4. **不触发上传**：这是**本机**整理，不该把整理结果推上云
 *    （所以不调 `scheduleUpload`、不置 `pending_upload`）。
 *
 * 幂等：只摘字段、不加字段 ⇒ 第二遍检测不到残留 ⇒ 不再改动、不再写盘。
 */
export async function migrateOrphanedGroupFieldsOnce(): Promise<void> {
  try {
    // 写路径新鲜读：与同文件另外两个迁移同口径（先 flush pending 防抖写、
    // 失效 30s 缓存，再读真值）。读-改-写拿陈旧快照会把同期刚保存的会话抹掉。
    const groups = await storage.getGroupsForWrite();

    // 判据只看「有没有会话带这两个键」，不看别的 —— 危害在**形状**上。
    if (!groups.some(hasOrphanedGroupFields)) {
      // 无残留 ⇒ **不写盘**（连直写都不调）。这是本迁移最重要的一条：
      // 无残留的用户（绝大多数）升级时磁盘上一个字节都不该变。
      logInfo('[迁移] 无 1.22.13 遗留的旧字段，无需处理');
      return;
    }

    const result = migrateOrphanedGroupFields(groups);

    // 直写落盘（与 purgeTombstones / migrateFaviconUrls 同一写路径）：
    // 迁移是整表重写，不该挤在 500ms 防抖窗口里等定时器 —— SW 随时可能被回收。
    await storage.setGroupsImmediate(result.groups as TabGroup[]);

    // ⚠️ 文案里刻意**不出现**那两个已下线功能的名称：产品侧的「不得复活」
    // 守卫（tests/p0DataSafetyGuards.test.ts）会扫 src/ 里所有出现这些词的
    // 代码行。日志是开发者看的，不该让已下线功能的字样重新出现在源码里。
    logInfo(
      `[迁移] 已收敛 1.22.13 遗留字段：${result.migrated} 个会话带残留，` +
        `其中 ${result.notesMerged} 条用户手写内容已并入会话名、` +
        `${result.favoritesDropped} 个旧版标记位已丢弃`
    );
  } catch (error) {
    logError('收敛 1.22.13 遗留字段失败:', error);
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

  // 2026-10-20 审计 U-1：收敛 1.22.13 下线的「备注 / 收藏」残留字段。
  //
  // ⚠️ 这一条**刻意不用迁移标志位**（shouldRunMigration）—— 与前三条不同：
  // 前三条是「做一次性的全局清理」，标志位是它们的幂等闸门；而本条是
  // 「**按数据形状**判断要不要动」：残留字段可能因为「用户导入了一份旧备份」
  // 而在标志位已置位之后**重新出现** ⇒ 用标志位会永久漏掉那部分。
  //
  // 幂等由**数据形状**保证（跑完就没有那两个键了 ⇒ 下次检测不到 ⇒ 不动），
  // 而不是由标志位保证。这也让「无残留 ⇒ 不写盘」这条硬约束天然成立：
  // 检测不到就不写，不需要额外的标志位来提醒自己「已经跑过了」。
  //
  // ⚠️ **请不要"顺手"给它加一个标志位** —— 完整理由见
  // `src/core/orphanedGroupFields.ts` 的文件头（"为什么刻意不用迁移标志位"）。
  // 简版：标志位与磁盘真实形状可能不一致（丢键 / 清数据 / 手改），
  // 冲突时必须信**用户的数据**而不是我们的记账。
  await migrateOrphanedGroupFieldsOnce();

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
