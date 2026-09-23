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
import { auth } from '@/utils/supabase/auth';
import { maybeShadowWrite } from '@/core/yShadow';

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
  getGroups: () => storage.getGroups(),
  setGroups: g => storage.setGroups(g),
  scheduleUpload: ms => syncEngine.scheduleUpload(ms),
  now: () => new Date().toISOString(),
  journal,
  seq,
  // P1-6：purge 出队记入持久化队列，由 SyncEngine.upload 删云端行后 clear。
  notePurgedGroup: id => storage.addPendingPurgeId(id),
  // V2 影子双写：落盘成功后异步翻译写入 Y.Doc（读仍走 blob）。
  // 灰度/开关/吞错全在 maybeShadowWrite 内部；此处仅做依赖绑定。
  shadowWrite: ({ op, stamp, now }) =>
    maybeShadowWrite(op, stamp, now, {
      getGroups: () => storage.getGroups(),
      getUserId: async () => {
        try {
          const { data } = await auth.getCurrentUser();
          const u = (data as { user?: { id?: string } | null } | null)?.user;
          return u?.id ?? null;
        } catch {
          return null;
        }
      },
      kvGet,
      kvSet,
    }),
});