/**
 * 生产环境的 mutationService 单例（规格 §3.2 + §4.3 + §7）。
 *
 * 本文件 import 了 chrome 依赖（storage / syncEngine / kv adapter），仅在 SW 实际加载时使用；
 * node:test 不触碰本文件，保持 mutationHandlers.ts 纯净可测。
 *
 * 阶段二·§4.3：注入 journal + seqRegistry。每次 handle 前 journal.appendEntry 取
 * stamp，apply* 以此 stamp 写入实体。seq 由 seqRegistry 提供单调递增保证。
 *
 * 阶段二·§7：SW 启动时调用 ensureOpStampMigrated——一次性给所有未带 stamp 的实体
 * 盖 legacy 印记，幂等。本设备 seq 由 seqRegistry.getDeviceSeq 自动修复为 max+100。
 */
import { storage } from '@/utils/storage';
import { syncEngine } from '@/services/syncEngine';
import { createMutationHandlers } from './mutationHandlers';
import { createSeqRegistry } from '@/utils/seqRegistry';
import { createJournal } from '@/utils/journal';
import { kvGet, kvSet } from '@/storage/storageAdapter';
import { getDeviceId } from '@/utils/deviceUtils';
import { migrateOpStamps } from '@/utils/opStampMigration';

const seq = createSeqRegistry({
  kvGet,
  kvSet,
  getDeviceId,
  getGroups: () => storage.getGroups(),
});

const journal = createJournal({
  kvGet,
  kvSet,
  getDeviceId,
  nextSeq: () => seq.nextSeq(),
});

export const mutationService = createMutationHandlers({
  getGroups: () => storage.getGroups(),
  setGroups: g => storage.setGroups(g),
  scheduleUpload: ms => syncEngine.scheduleUpload(ms),
  now: () => new Date().toISOString(),
  journal,
  seq,
});

/**
 * 阶段二·§7：存量数据迁移入口（SW 启动时调用一次）。
 * 幂等——已迁移过的用户由 OP_STAMP_MIGRATED 标志位跳过。
 */
export async function ensureOpStampMigrated(): Promise<void> {
  if (await storage.getOpStampMigrated()) return;
  const groups = await storage.getGroups();
  const { groups: migratedGroups, migrated } = migrateOpStamps(groups);
  if (migrated > 0) {
    await storage.setGroups(migratedGroups);
    console.log(`[OpStamp] 迁移完成: ${migrated} 个实体盖 legacy 印记`);
  }
  await storage.setOpStampMigrated(true);
}