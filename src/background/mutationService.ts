/**
 * 生产环境的 mutationService 单例（规格 §3.2 + §4.3 + §7）。
 *
 * 本文件 import 了 chrome 依赖（storage / syncEngine / kv adapter），仅在 SW 实际加载时使用；
 * node:test 不触碰本文件，保持 mutationHandlers.ts 纯净可测。
 *
 * 阶段二·§4.3：注入 journal + seqRegistry。每次 handle 前 journal.appendEntry 取
 * stamp，apply* 以此 stamp 写入实体。seq 由 seqRegistry 提供单调递增保证。
 *
 * 阶段二·§7：存量印记迁移见 background/opStampMigratedGuard.ts（单独成文件避免循环依赖）。
 */
import { storage } from '@/utils/storage';
import { syncEngine } from '@/services/syncEngine';
import { createMutationHandlers } from './mutationHandlers';
import { createSeqRegistry } from '@/utils/seqRegistry';
import { createJournal } from '@/utils/journal';
import { kvGet, kvSet } from '@/storage/storageAdapter';
import { getDeviceId } from '@/utils/deviceUtils';

const seq = createSeqRegistry({
  kvGet,
  kvSet,
  getGroups: () => storage.getGroups(),
});

const journal = createJournal({
  kvGet,
  kvSet,
  getDeviceId,
  nextSeq: () => seq.nextSeq(),
});

export const mutationService = createMutationHandlers({
  // 读-改-写必须读真值：getGroups() 的 30s 缓存可能比 popup 上下文
  // （runMigrations 会写 GROUPS key）更旧，拿旧快照改完写回会抹掉期间的数据。
  // 详见 storage.getGroupsForWrite 的注释。
  getGroups: () => storage.getGroupsForWrite(),
  setGroups: (g, originId) => storage.setGroupsImmediate(g, originId),
  scheduleUpload: ms => syncEngine.scheduleUpload(ms),
  now: () => new Date().toISOString(),
  journal,
  seq,
  // 无墓碑模型：物理删除的组登记 pendingDeleteIds，由 SyncEngine.upload
  // markCloudGroupsAsDeleted 标记云端行（删除广播）后 clear。
  noteGroupDeleted: ids => storage.addPendingDeleteIds(ids),
});
