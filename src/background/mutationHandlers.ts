/**
 * SW 端语义命令执行器（规格 §3.2/§3.3 + §4.3）。
 * 编排：journal.appendEntry 先于状态写 → 取 stamp → apply* 纯函数 → 写 storage
 *        → scheduleUpload。由 mutationQueue 串行调用，天然无并发写。
 * deps 注入便于 node:test；生产在 src/background/mutationService.ts 中绑定真实依赖。
 *
 * ── 2026-09-29 无墓碑重写 ──
 * 删除一律物理移除。本地移除不等于删除广播完成：云端行必须标记 is_deleted=true
 * （行保留，对端合并时服从），否则对端活跃副本下轮合并会把该组当 remote-only 复活。
 * 广播载体 = pendingDeleteIds 持久化队列（deps.noteGroupDeleted 登记），
 * upload 侧 markCloudGroupsAsDeleted 成功后清队。
 */
import type { TabGroup } from '@/types/tab';
import type { MutationOp, MutationResult } from '@/shared/mutationProtocol';
import type { Journal } from '@/utils/journal';
import type { SeqRegistry } from '@/utils/seqRegistry';
import type { OpStamp } from '@/core/opStamp';
import { sanitizeTabUrl } from '@/utils/inputValidation';
import { nanoid } from '@reduxjs/toolkit';
import {
  applySaveGroup,
  applyRemoveTab,
  applyDeleteGroup,
  applyDeleteAllGroups,
  applyImportGroups,
  applyRenameGroup,
  applyToggleGroupLock,
  applyUpdateGroupFields,
  applyMoveTab,
  applyCleanDuplicates,
} from '@/core/mutationOps';
import { logWarn } from '../utils/log';

export interface MutationDeps {
  getGroups(): Promise<TabGroup[]>;
  setGroups(groups: TabGroup[]): Promise<void>;
  scheduleUpload(delayMs: number): void | Promise<void>;
  now(): string;
  journal: Journal;
  seq: SeqRegistry;
  /**
   * 删除广播出队记录。本地物理移除组后，把 id 记入持久化 pendingDeleteIds 队列，
   * 由 upload 侧调用 markCloudGroupsAsDeleted 标记云端行（含读回确认）。
   * 可选依赖——缺失时仅告警（本地已删干净，云端行残留则对端可能复活，
   * 日志中明确给出该风险而非静默）。
   */
  noteGroupDeleted?: (groupId: string) => Promise<void> | void;
  /**
   * V2 影子双写：主写（journal → apply* → setGroups）成功后由 handle()
   * fire-and-forget 调用。实现见 src/core/yShadow.ts maybeShadowWrite。
   * 可选依赖——缺失/抛错时主同步零影响（handle 内 try/catch + 不 await）。
   */
  shadowWrite?: (args: { op: MutationOp; stamp: OpStamp; now: string }) => unknown;
}

const DELETE_PRIORITY_MS = 1500; // 删除/新建类（对齐原 autoSyncMiddleware 优先级 ≥8）
const NORMAL_MS = 3000;

/**
 * 物理删除的组登记云端删除广播队列。
 * 登记失败只告警不阻断（本地已删干净，残留风险写进日志）。
 */
async function noteDeletedGroups(
  deps: MutationDeps,
  ids: (string | null | undefined)[]
): Promise<void> {
  for (const id of ids) {
    if (!id) continue;
    try {
      await deps.noteGroupDeleted?.(id);
    } catch (e) {
      logWarn('[mutationHandlers] 登记删除广播队列失败（云端行可能残留复活）:', id, e);
    }
  }
}

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
        await noteDeletedGroups(deps, [r.removedGroupId]);
        // 删除类必须 await 置位：组已从磁盘移除、广播队列已写入，但
        // pending_upload 还没落盘时 SW 被回收 → 后台看到 pendingUpload=false
        // 就不上传 → 云端行没标记删除，对端并集合并把已删的组拉回来。
        await deps.scheduleUpload(DELETE_PRIORITY_MS);
        return { ok: true, payload: { group: r.group } };
      }
      case 'deleteGroup': {
        const groups = await deps.getGroups();
        const r = applyDeleteGroup(groups, cmd.groupId, now, stamp);
        await deps.setGroups(r.groups);
        await noteDeletedGroups(deps, [r.removedGroupId]);
        await deps.scheduleUpload(DELETE_PRIORITY_MS);
        return { ok: true, payload: cmd.groupId };
      }
      case 'deleteAllGroups': {
        const groups = await deps.getGroups();
        const r = applyDeleteAllGroups(groups, now, stamp);
        await deps.setGroups(r.groups);
        await noteDeletedGroups(deps, r.removedGroupIds);
        await deps.scheduleUpload(DELETE_PRIORITY_MS);
        return { ok: true, payload: { count: r.count } };
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
        return {
          ok: true,
          payload: { groupId: cmd.groupId, name: cmd.name },
        };
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
      case 'moveTab': {
        const groups = await deps.getGroups();
        const r = applyMoveTab(groups, cmd, now, stamp);
        await deps.setGroups(r.groups);
        await noteDeletedGroups(deps, [r.removedGroupId]);
        // 搬空源组属删除类：置位必须落盘，否则那次删除广播不到云端
        await deps.scheduleUpload(r.removedGroupId ? DELETE_PRIORITY_MS : NORMAL_MS);
        return {
          ok: true,
          payload: {
            sourceGroupId: cmd.sourceGroupId,
            sourceIndex: cmd.sourceIndex,
            targetGroupId: cmd.targetGroupId,
            targetIndex: cmd.targetIndex,
            removedGroupId: r.removedGroupId,
          },
        };
      }
      case 'cleanDuplicates': {
        const groups = await deps.getGroups();
        const r = applyCleanDuplicates(groups, now, stamp);
        await deps.setGroups(r.groups);
        await noteDeletedGroups(deps, r.removedGroupIds);
        // 清空产生的删除同样依赖广播队列 + 置位，别让删除停在半路
        await deps.scheduleUpload(NORMAL_MS);
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
