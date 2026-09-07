/**
 * SW 端语义命令执行器（规格 §3.2/§3.3）。编排固定为：读 storage → apply* 纯函数
 * → 写 storage → scheduleUpload。由 mutationQueue 串行调用，天然无并发写。
 * deps 注入便于 node:test；生产在 src/background/mutationService.ts 中绑定真实依赖。
 *
 * 本文件不引入 chrome 依赖（storage/syncEngine 不在此出现），生产绑定拆分到
 * mutationService.ts 以保持本文件可在 node:test 中直接 import。
 */
import type { TabGroup } from '@/types/tab';
import type { MutationOp, MutationResult } from '@/shared/mutationProtocol';
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
}

const DELETE_PRIORITY_MS = 1500; // 删除/新建类（对齐原 autoSyncMiddleware 优先级 ≥8）
const NORMAL_MS = 3000;

export function createMutationHandlers(deps: MutationDeps) {
  async function run(cmd: MutationOp): Promise<MutationResult> {
    const now = deps.now();
    switch (cmd.op) {
      case 'saveGroup': {
        const groups = await deps.getGroups();
        await deps.setGroups(applySaveGroup(groups, cmd.group, now));
        deps.scheduleUpload(DELETE_PRIORITY_MS);
        return { ok: true, payload: cmd.group };
      }
      case 'removeTab': {
        const groups = await deps.getGroups();
        const r = applyRemoveTab(groups, cmd.groupId, cmd.tabId, now);
        await deps.setGroups(r.groups);
        deps.scheduleUpload(DELETE_PRIORITY_MS);
        return { ok: true, payload: { group: r.group } };
      }
      case 'deleteGroup': {
        const groups = await deps.getGroups();
        await deps.setGroups(applyDeleteGroup(groups, cmd.groupId, now));
        deps.scheduleUpload(DELETE_PRIORITY_MS);
        return { ok: true, payload: cmd.groupId };
      }
      case 'deleteAllGroups': {
        const groups = await deps.getGroups();
        const r = applyDeleteAllGroups(groups, now);
        await deps.setGroups(r.groups);
        deps.scheduleUpload(DELETE_PRIORITY_MS);
        return { ok: true, payload: { count: r.count } };
      }
      case 'restoreGroup': {
        const groups = await deps.getGroups();
        const r = applyRestoreGroup(groups, cmd.groupId, now);
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
        await deps.setGroups(applyPurgeGroup(groups, cmd.groupId));
        deps.scheduleUpload(NORMAL_MS);
        return { ok: true, payload: cmd.groupId };
      }
      case 'importGroups': {
        const groups = await deps.getGroups();
        const r = applyImportGroups(
          groups,
          cmd.groups,
          { genId: () => nanoid(), sanitizeUrl: sanitizeTabUrl },
          now
        );
        await deps.setGroups(r.groups);
        deps.scheduleUpload(DELETE_PRIORITY_MS);
        return { ok: true, payload: r.imported };
      }
      case 'renameGroup': {
        const groups = await deps.getGroups();
        const r = applyRenameGroup(groups, cmd.groupId, cmd.name, now);
        await deps.setGroups(r.groups);
        deps.scheduleUpload(NORMAL_MS);
        return { ok: true, payload: { groupId: cmd.groupId, name: cmd.name } };
      }
      case 'toggleGroupLock': {
        const groups = await deps.getGroups();
        const r = applyToggleGroupLock(groups, cmd.groupId, now);
        await deps.setGroups(r.groups);
        deps.scheduleUpload(NORMAL_MS);
        return {
          ok: true,
          payload: { groupId: cmd.groupId, isLocked: r.isLocked },
        };
      }
      case 'updateGroupFields': {
        // 本地 UI 偏好（isFavorite/notes），不进入云端 sync 载荷；
        // 仍走单写者队列以避免 popup/SW 直写 storage 的 R1 race。
        // 字段语义上不需要触发上传，但保留 scheduleUpload 形状与其他字段命令一致。
        const groups = await deps.getGroups();
        const r = applyUpdateGroupFields(groups, cmd.groupId, cmd.fields, now);
        await deps.setGroups(r.groups);
        deps.scheduleUpload(NORMAL_MS);
        return {
          ok: true,
          payload: { groupId: cmd.groupId, updated: r.updated, fields: cmd.fields },
        };
      }
      case 'moveGroup': {
        const groups = await deps.getGroups();
        const next = applyMoveGroup(groups, cmd.dragIndex, cmd.hoverIndex);
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
        const r = applyMoveTab(groups, cmd, now);
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
        const r = applyCleanDuplicates(groups, now);
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
