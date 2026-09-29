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
import { maybeAuditConsistency } from '@/core/yAudit';

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
  setGroups: g => storage.setGroupsImmediate(g),
  scheduleUpload: ms => syncEngine.scheduleUpload(ms),
  now: () => new Date().toISOString(),
  journal,
  seq,
  // 无墓碑模型：物理删除的组登记 pendingDeleteIds，由 SyncEngine.upload
  // markCloudGroupsAsDeleted 标记云端行（删除广播）后 clear。
  noteGroupDeleted: id => storage.addPendingDeleteId(id),
  // V2 影子双写：落盘成功后异步翻译写入 Y.Doc（读仍走 blob）。
  // 灰度/开关/吞错全在 maybeShadowWrite 内部；此处仅做依赖绑定。
  shadowWrite: ({ op, stamp, now }) =>
    (async () => {
      // P1 对账：影子写后采样比对 Y 物化视图 vs 本地真相（默认 5% 命中才读 Y）。
      // 对账只读不写、失败吞错，返回值与调用约定（Promise<ShadowOutcome>）不变；
      // 上游 fire-and-forget 语义不变（见 mutationHandlers handle）。
      const getGroups = () => storage.getGroups();
      const getUserId = async () => {
        try {
          const { data } = await auth.getCurrentUser();
          const u = (data as { user?: { id?: string } | null } | null)?.user;
          return u?.id ?? null;
        } catch {
          return null;
        }
      };
      const out = await maybeShadowWrite(op, stamp, now, { getGroups, getUserId, kvGet, kvSet });
      try {
        await maybeAuditConsistency(stamp.s, { getGroups, getUserId, kvGet, kvSet });
      } catch {
        /* 对账永不阻断影子结果回传 */
      }
      return out;
    })(),
});