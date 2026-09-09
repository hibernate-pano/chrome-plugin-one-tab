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
import type { OpStamp } from '@/utils/opStamp';
import { sanitizeTabUrl } from '@/utils/inputValidation';
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
}

const DELETE_PRIORITY_MS = 1500; // 删除/新建类（对齐原 autoSyncMiddleware 优先级 ≥8）
const NORMAL_MS = 3000;

export function createMutationHandlers(deps: MutationDeps) {
  async function run(cmd: MutationOp): Promise<MutationResult> {
    const now = deps.now();

    // 阶段二·§4.3 写序：journal + seq 一次性落盘先于 apply* 状态写。
    const entry = await deps.journal.appendEntry({
      type: cmd.op,
      groupId: 'groupId' in cmd ? (cmd as { groupId?: string }).groupId : undefined,
      tabId: 'tabId' in cmd ? (cmd as { tabId?: string }).tabId : undefined,
    });
    const stamp: OpStamp = { d: entry.d, s: entry.s };

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
        const groups = await deps.getGroups();
        await deps.setGroups(applyPurgeGroup(groups, cmd.groupId, now, stamp));
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
        return await run(cmd);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}