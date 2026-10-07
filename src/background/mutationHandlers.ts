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
  applyMoveTab,
  applyCleanDuplicates,
} from '@/core/mutationOps';
import { logError } from '../utils/log';
import { perfTrace } from '@/utils/perfTrace';

export interface MutationDeps {
  getGroups(): Promise<TabGroup[]>;
  /**
   * originId：发起本次命令的上下文身份（见 @/core/contextOrigin）。
   * 落盘广播时原样带回，供发起方忽略自己的回声；缺失（SW 自身写入）则广播给所有人。
   */
  setGroups(groups: TabGroup[], originId?: string): Promise<void>;
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
  /**
   * 登录删除广播意图（批量）。cleanDuplicates 一次可能删上千个组，逐条登记
   * 是 2N 次 IndexedDB 往返（曾导致清理操作卡死数秒）；批量登记仅 2 次往返。
   */
  noteGroupDeleted?: (groupIds: readonly string[]) => Promise<void> | void;
}

const DELETE_PRIORITY_MS = 1500; // 删除/新建类（对齐原 autoSyncMiddleware 优先级 ≥8）
const NORMAL_MS = 3000;

/**
 * 物理删除的组登记云端删除广播队列。
 *
 * ── 2026-10-05：失败改为「如实回报」，不再只告警 ────────────────────────
 * 无墓碑模型下，删除分两段：本地物理移除（立即，用户看得见）+ 云端行标
 * is_deleted（广播，让对端也删）。第二段的载体就是 pendingDeleteIds 队列。
 * 登记失败时本地已经删干净、界面也已经少了那一组，但**云端行还在**——
 * 对端下次合并会把它当 remote-only 复活（这正是 pendingDeleteIds 存在的理由）。
 *
 * 原来这里 catch 之后只 logWarn，handle 照常返回 `ok: true`，于是 UI 报成功、
 * 用户以为删干净了，而实际是「本地删了、云端没删、对端会复活」。这类
 * 「谎报成功」比直接失败更难排查：用户不会再去检查第二遍。
 *
 * 现在返回失败信息（本地已删的事实照旧，UI 会刷新列表——乐观更新已经生效），
 * 让调用方能提示用户「本地已删除，但云端同步失败，可能在其它设备复活」。
 * 不改成 throw：本地删除已经生效（不可回滚），抛错会让 UI 显示成
 * 「删除失败」而实际本地已经没了，那才是真的误导。
 */
async function noteDeletedGroups(
  deps: MutationDeps,
  ids: (string | null | undefined)[]
): Promise<string | null> {
  const validIds = ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (validIds.length === 0) return null;
  try {
    // 一次登记整批：逐条会造成 2N 次 KV 往返（大清理场景卡死的根因）。
    await deps.noteGroupDeleted?.(validIds);
    return null;
  } catch (e) {
    logError('[mutationHandlers] 登记删除广播队列失败（云端行会残留、对端将复活）:', validIds, e);
    return `${validIds.length} 个会话已从本机删除，但未能登记云端删除广播；` +
      '它们可能在你的其它设备上重新出现（下次同步时会被带回来）。';
  }
}

export function createMutationHandlers(deps: MutationDeps) {

  /**
   * 阶段计时包装（诊断观测，见 @/utils/perfTrace）。
   *
   * 为什么包 deps 而不是改 10 个 case：每个 case 的 IO 骨架都是同一条
   * 「journal → 读全量 → 纯计算 → 写全量 → 登记删除 → 调度上传」。在依赖注入
   * 边界上计时，一处覆盖全部命令，且新增 op 自动获得计时（漏不掉）。
   * 纯计算段没有 IO 可包，由诊断聚合时用 run 总时长减去各 IO 段推出
   * （见 buildDiagnosticsReport 的 applyMs）。
   *
   * 计时不改变行为：measure 只多记一次时间，异常原样向上抛。
   */
  function timedDeps(op: string): MutationDeps {
    return {
      ...deps,
      journal: {
        ...deps.journal,
        appendEntry: p => perfTrace().measure(op, 'journal', () => deps.journal.appendEntry(p)),
      },
      getGroups: () => perfTrace().measure(op, 'read', () => deps.getGroups()),
      setGroups: (g, originId) => perfTrace().measure(op, 'write', () => deps.setGroups(g, originId)),
      scheduleUpload: ms => perfTrace().measure(op, 'scheduleUpload', () => deps.scheduleUpload(ms)),
      // 可选依赖：缺失时保持缺失（noteDeletedGroups 用 `?.` 判定，不能把
      // undefined 包成一个函数，否则「没注入」会被误判成「注入了但很慢」）。
      ...(deps.noteGroupDeleted
        ? {
            noteGroupDeleted: (ids: readonly string[]) =>
              perfTrace().measure(op, 'noteDeleted', () => deps.noteGroupDeleted!(ids)),
          }
        : {}),
    };
  }

  async function run(cmd: MutationOp, originId?: string): Promise<MutationResult> {
    const d = timedDeps(cmd.op);
    const now = d.now();
    // 本次命令的统一落盘出口：把 originId 透传给写路径（广播过滤用）。
    const persist = (groups: TabGroup[]) => d.setGroups(groups, originId);

    // 阶段二·§4.3 写序：journal + seq 一次性落盘先于 apply* 状态写。
    // journal 在这里的作用是「取号 + 留一条命令轨迹」（诊断导出读它统计命令分布）；
    // 它声明的 WAL 重放从未实现，也不打算实现——单写者队列 + 每步直写落盘
    // 已经保证不会留下「需要重放」的中间态。
    const entry = await d.journal.appendEntry({
      type: cmd.op,
      groupId: 'groupId' in cmd ? (cmd as { groupId?: string }).groupId : undefined,
      tabId: 'tabId' in cmd ? (cmd as { tabId?: string }).tabId : undefined,
    });
    const stamp: OpStamp = { d: entry.d, s: entry.s };

    switch (cmd.op) {
      case 'saveGroup': {
        const groups = await d.getGroups();
        await persist(applySaveGroup(groups, cmd.group, now, stamp));
        d.scheduleUpload(DELETE_PRIORITY_MS);
        return { ok: true, payload: cmd.group };
      }
      case 'removeTab': {
        const groups = await d.getGroups();
        const r = applyRemoveTab(groups, cmd.groupId, cmd.tabId, now, stamp);
        await persist(r.groups);
        const delWarn = await noteDeletedGroups(d, [r.removedGroupId]);
        // 删除类必须 await 置位：组已从磁盘移除、广播队列已写入，但
        // pending_upload 还没落盘时 SW 被回收 → 后台看到 pendingUpload=false
        // 就不上传 → 云端行没标记删除，对端并集合并把已删的组拉回来。
        await d.scheduleUpload(DELETE_PRIORITY_MS);
        return { ok: true, payload: { group: r.group }, broadcastWarn: delWarn ?? undefined };
      }
      case 'deleteGroup': {
        const groups = await d.getGroups();
        const r = applyDeleteGroup(groups, cmd.groupId, now, stamp);
        await persist(r.groups);
        const delWarn = await noteDeletedGroups(d, [r.removedGroupId]);
        await d.scheduleUpload(DELETE_PRIORITY_MS);
        return { ok: true, payload: cmd.groupId, broadcastWarn: delWarn ?? undefined };
      }
      case 'deleteAllGroups': {
        const groups = await d.getGroups();
        const r = applyDeleteAllGroups(groups, now, stamp);
        await persist(r.groups);
        const delWarn = await noteDeletedGroups(d, r.removedGroupIds);
        await d.scheduleUpload(DELETE_PRIORITY_MS);
        return { ok: true, payload: { count: r.count }, broadcastWarn: delWarn ?? undefined };
      }
      case 'importGroups': {
        const groups = await d.getGroups();
        const r = applyImportGroups(
          groups,
          cmd.groups,
          { genId: () => nanoid(), sanitizeUrl: sanitizeTabUrl },
          now,
          stamp
        );
        await persist(r.groups);
        d.scheduleUpload(DELETE_PRIORITY_MS);
        return { ok: true, payload: r.imported };
      }
      case 'renameGroup': {
        const groups = await d.getGroups();
        const r = applyRenameGroup(groups, cmd.groupId, cmd.name, now, stamp);
        await persist(r.groups);
        d.scheduleUpload(NORMAL_MS);
        return {
          ok: true,
          payload: { groupId: cmd.groupId, name: cmd.name },
        };
      }
      case 'toggleGroupLock': {
        const groups = await d.getGroups();
        const r = applyToggleGroupLock(groups, cmd.groupId, now, stamp);
        await persist(r.groups);
        d.scheduleUpload(NORMAL_MS);
        return {
          ok: true,
          payload: { groupId: cmd.groupId, isLocked: r.isLocked },
        };
      }
      case 'moveTab': {
        const groups = await d.getGroups();
        const r = applyMoveTab(groups, cmd, now, stamp);
        await persist(r.groups);
        const delWarn = await noteDeletedGroups(d, [r.removedGroupId]);
        // 搬空源组属删除类：置位必须落盘，否则那次删除广播不到云端
        await d.scheduleUpload(r.removedGroupId ? DELETE_PRIORITY_MS : NORMAL_MS);
        return {
          ok: true,
          payload: {
            sourceGroupId: cmd.sourceGroupId,
            sourceIndex: cmd.sourceIndex,
            targetGroupId: cmd.targetGroupId,
            targetIndex: cmd.targetIndex,
            removedGroupId: r.removedGroupId,
          },
          broadcastWarn: delWarn ?? undefined,
        };
      }
      case 'cleanDuplicates': {
        const groups = await d.getGroups();
        const r = applyCleanDuplicates(groups, now, stamp);
        await persist(r.groups);
        const delWarn = await noteDeletedGroups(d, r.plan.removedGroupIds);
        // 清空产生的删除同样依赖广播队列 + 置位，别让删除停在半路
        await d.scheduleUpload(NORMAL_MS);
        return {
          ok: true,
          payload: {
            // 只回传计划 + 落盘用的 now/stamp，不回传 groups 全量。
            // popup 用同一份 plan + 同一个 now/stamp 跑 applyCleanDuplicatesPlan，
            // 得到与磁盘逐字段一致的结果（见 CleanDuplicatesPlan 的说明）。
            plan: r.plan,
            now,
            stamp,
          },
          broadcastWarn: delWarn ?? undefined,
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
    async handle(cmd: MutationOp, originId?: string): Promise<MutationResult> {
      try {
        return await run(cmd, originId);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
