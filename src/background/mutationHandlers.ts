/**
 * SW 端语义命令执行器（规格 §3.2/§3.3 + §4.3）。
 * 编排：journal.appendEntry 先于状态写 → 取 stamp → apply* 纯函数 → 写 storage
 *        → scheduleUpload。由 mutationQueue 串行调用，天然无并发写。
 * deps 注入便于 node:test；生产在 src/background/mutationService.ts 中绑定真实依赖。
 */
import type { TabGroup } from '@/types/tab';
import type { MutationOp, MutationResult } from '@/shared/mutationProtocol';
import type { Journal } from '@/utils/journal';
import type { SeqRegistry } from '@/utils/seqRegistry';
import type { OpStamp } from '@/utils/opStamp';import { sanitizeTabUrl } from '@/utils/inputValidation';
import { nanoid } from '@reduxjs/toolkit';
import {
  applySaveGroup,
  applyRemoveTab,
  applyDeleteGroup,
  applyDeleteAllGroups,
  applyRestoreGroup,
  applyPurgeGroup,
  applyImportGroups,
  applyRenameGroup,
  applyToggleGroupLock,
  applyUpdateGroupFields,
  applyMoveGroup,
  applyMoveTab,
  applyCleanDuplicates,
} from '@/utils/mutationOps';

export interface MutationDeps {
  getGroups(): Promise<TabGroup[]>;
  setGroups(groups: TabGroup[]): Promise<void>;
  scheduleUpload(delayMs: number): void;
  now(): string;
  journal: Journal;
  seq: SeqRegistry;
  /**
   * P1-6：purge 出队记录。本地物理移除组后，把 id 记入持久化 purge 队列，
   * 由 upload 侧调用 purgeCloudGroups 删掉云端对应行（含读回确认）。
   * 可选依赖——缺失时仅告警（本地 purge 照常，云端行残留则下轮下载可能复活，
   * 日志中明确给出该风险而非静默）。
   */
  notePurgedGroup?: (groupId: string) => Promise<void> | void;
  /**
   * V2 影子双写：主写（journal → apply* → setGroups）成功后由 handle()
   * fire-and-forget 调用。实现见 src/core/yShadow.ts maybeShadowWrite。
   * 可选依赖——缺失/抛错时主同步零影响（handle 内 try/catch + 不 await）。
   */
  shadowWrite?: (args: { op: MutationOp; stamp: OpStamp; now: string }) => unknown;
}

const DELETE_PRIORITY_MS = 1500; // 删除/新建类（对齐原 autoSyncMiddleware 优先级 ≥8）
const NORMAL_MS = 3000;

export function createMutationHandlers(deps: MutationDeps) {
  // V2 影子双写：run() 内最近一次成功取到的 stamp/now（handle 在主写 ok 后取用）。
  let lastMeta: { stamp: OpStamp; now: string } | null = null;

  async function run(cmd: MutationOp): Promise<MutationResult> {
    const now = deps.now();

    // 阶段二·§4.3 写序：journal + seq 一次性落盘先于 apply* 状态写。
    const entry = await deps.journal.appendEntry({
      type: cmd.op,
      groupId: 'groupId' in cmd ? (cmd as { groupId?: string }).groupId : undefined,
      tabId: 'tabId' in cmd ? (cmd as { tabId?: string }).tabId : undefined,
    });
    const stamp: OpStamp = { d: entry.d, s: entry.s };
    lastMeta = { stamp, now };

    switch (cmd.op) {
      case 'saveGroup': {
        const groups = await deps.getGroups();
        await deps.setGroups(applySaveGroup(groups, cmd.group, now, stamp));
        deps.scheduleUpload(DELETE_PRIORITY_MS);
        return { ok: true, payload: cmd.group };
      }
      case 'removeTab': {
        const groups = await deps.getGroups();
        const r = applyRemoveTab(groups, cmd.groupId, cmd.tabId, now, stamp);
        await deps.setGroups(r.groups);
        deps.scheduleUpload(DELETE_PRIORITY_MS);
        return { ok: true, payload: { group: r.group } };
      }
      case 'deleteGroup': {
        const groups = await deps.getGroups();
        await deps.setGroups(applyDeleteGroup(groups, cmd.groupId, now, stamp));
        deps.scheduleUpload(DELETE_PRIORITY_MS);
        return { ok: true, payload: cmd.groupId };
      }
      case 'deleteAllGroups': {
        const groups = await deps.getGroups();
        const r = applyDeleteAllGroups(groups, now, stamp);
        await deps.setGroups(r.groups);
        deps.scheduleUpload(DELETE_PRIORITY_MS);
        return { ok: true, payload: { count: r.count } };
      }
      case 'restoreGroup': {
        const groups = await deps.getGroups();
        const r = applyRestoreGroup(groups, cmd.groupId, now, stamp);
        if (!r.restored) throw new Error('未找到该标签组');
        await deps.setGroups(r.groups);
        deps.scheduleUpload(DELETE_PRIORITY_MS);
        return {
          ok: true,
          payload: { groupId: cmd.groupId, restoredGroup: r.restored },
        };
      }
      case 'purgeGroup': {
        // P1-6 purge 语义修齐：
        // 1) 仅允许 purge 回收站中的墓碑（isDeleted=true）。活跃组直接物理移除会
        //    绕过墓碑广播——云端行残留，下次下载以 remote-only 复活（静默丢删除意图）。
        //    必须先 deleteGroup（墓碑+上传广播）再 purge，且两次上传之间要有间隔
        //    让墓碑先上云；否则拦截并报错，由调用方引导用户走“删除→清空回收站”两步。
        // 2) purge 通过后把 id 记入持久化队列，upload 侧删云端行；无 is_deleted 列
        //    的环境走硬删并给出明确告警（见 supabase.markCloudGroupsAsDeleted）。
        const groups = await deps.getGroups();
        const target = groups.find(g => g.id === cmd.groupId);
        if (!target) throw new Error('未找到该标签组');
        if (!target.isDeleted) {
          throw new Error('仅允许彻底删除回收站中的已删除组（请先删除该组，等待同步后再清空）');
        }
        await deps.setGroups(applyPurgeGroup(groups, cmd.groupId, now, stamp));
        try {
          await deps.notePurgedGroup?.(cmd.groupId);
        } catch (e) {
          console.warn('[mutationHandlers] 记录 purge 队列失败（云端行可能残留复活）:', e);
        }
        deps.scheduleUpload(NORMAL_MS);
        return { ok: true, payload: cmd.groupId };
      }
      case 'importGroups': {
        const groups = await deps.getGroups();
        const r = applyImportGroups(
          groups,
          cmd.groups,
          { genId: () => nanoid(), sanitizeUrl: sanitizeTabUrl },
          now,
          stamp
        );
        await deps.setGroups(r.groups);
        deps.scheduleUpload(DELETE_PRIORITY_MS);
        return { ok: true, payload: r.imported };
      }
      case 'renameGroup': {
        const groups = await deps.getGroups();
        const r = applyRenameGroup(groups, cmd.groupId, cmd.name, now, stamp);
        await deps.setGroups(r.groups);
        deps.scheduleUpload(NORMAL_MS);
        return { ok: true, payload: { groupId: cmd.groupId, name: cmd.name } };
      }
      case 'toggleGroupLock': {
        const groups = await deps.getGroups();
        const r = applyToggleGroupLock(groups, cmd.groupId, now, stamp);
        await deps.setGroups(r.groups);
        deps.scheduleUpload(NORMAL_MS);
        return {
          ok: true,
          payload: { groupId: cmd.groupId, isLocked: r.isLocked },
        };
      }
      case 'updateGroupFields': {
        const groups = await deps.getGroups();
        const r = applyUpdateGroupFields(groups, cmd.groupId, cmd.fields, now, stamp);
        await deps.setGroups(r.groups);
        deps.scheduleUpload(NORMAL_MS);
        return {
          ok: true,
          payload: { groupId: cmd.groupId, updated: r.updated, fields: cmd.fields },
        };
      }
      case 'moveGroup': {
        const groups = await deps.getGroups();
        const next = applyMoveGroup(groups, cmd.dragIndex, cmd.hoverIndex, stamp);
        if (!next) return { ok: false, error: '无效的标签组索引' };
        await deps.setGroups(next);
        deps.scheduleUpload(NORMAL_MS);
        return {
          ok: true,
          payload: { dragIndex: cmd.dragIndex, hoverIndex: cmd.hoverIndex },
        };
      }
      case 'moveTab': {
        const groups = await deps.getGroups();
        const r = applyMoveTab(groups, cmd, now, stamp);
        await deps.setGroups(r.groups);
        if (r.autoDeletedGroupId) deps.scheduleUpload(DELETE_PRIORITY_MS);
        else deps.scheduleUpload(NORMAL_MS);
        return {
          ok: true,
          payload: {
            sourceGroupId: cmd.sourceGroupId,
            sourceIndex: cmd.sourceIndex,
            targetGroupId: cmd.targetGroupId,
            targetIndex: cmd.targetIndex,
            autoDeletedGroupId: r.autoDeletedGroupId,
          },
        };
      }
      case 'cleanDuplicates': {
        const groups = await deps.getGroups();
        const r = applyCleanDuplicates(groups, now, stamp);
        await deps.setGroups(r.groups);
        deps.scheduleUpload(NORMAL_MS);
        return {
          ok: true,
          payload: {
            removedTabsCount: r.removedTabsCount,
            removedGroupsCount: r.removedGroupsCount,
            updatedGroups: r.groups,
          },
        };
      }
      default:
        return {
          ok: false,
          error: `未知命令: ${(cmd as { op: string }).op}`,
        };
    }
  }

  return {
    async handle(cmd: MutationOp): Promise<MutationResult> {
      try {
        const res = await run(cmd);
        if (res.ok && lastMeta && deps.shadowWrite) {
          // V2 影子双写：mutation 落盘成功后异步翻译写入 Y.Doc（读仍走 blob）。
          // fire-and-forget（不 await，不延迟 SW 响应）+ 全程吞错：
          // 影子永不阻断主同步、不影响返回值（结果由 yShadow 内部 journallog 化）。
          const meta = lastMeta;
          try {
            void Promise.resolve(deps.shadowWrite({ op: cmd, stamp: meta.stamp, now: meta.now })).catch(() => {});
          } catch {
            /* 同步抛错同样静默 */
          }
        }
        return res;
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}