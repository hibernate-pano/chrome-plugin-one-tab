/**
 * V2 影子双写 · MutationOp → Y 计划翻译（纯函数，无 IO，可 node:test 直测）。
 *
 * 设计（锚定 stamp 不变量）：
 * - 阶段二·§4.3/§5.3 保证：一次 mutation 触及的每个实体都被盖上同一 stamp
 *   （lastOp = { d, s }）。影子翻译不重新实现各 apply* 的条件分支，而是：
 *   受影响组 = 快照中 lastOp == 本次 stamp 的组（含其 tabs）。
 * - 因此翻译对 13 种 MutationOp 统一收敛为 3 种 Y 计划：
 *   upsertGroup（组+其 tabs 全量覆写，stamp 门控）、removeGroup（purge 物理移除）、
 *   setOrder（快照顺序重建 order 数组）。
 * - 幂等：同一 stamp 重复应用结果一致（覆写同一值；stamp 门控跳过旧 stamp）。
 * - 收敛：upsert 携带 stamp，应用时比较现有 lastOp，全序小者跳过（后写赢）。
 *
 * 翻译表（MutationOp → 计划推导）：
 * | op               | 计划来源 |
 * |------------------|----------|
 * | saveGroup        | 快照中带本次 stamp 的组 → upsertGroup |
 * | removeTab        | 同上（拿空组时组已物理移除 → setOrder 修剪） |
 * | deleteGroup      | 同上（组物理移除 → setOrder 修剪） |
 * | deleteAllGroups  | 同上（快照为空 → setOrder 修剪全部） |
 * | importGroups     | 同上（新组全带 stamp → 全部 upsert） |
 * | renameGroup / toggleGroupLock / updateGroupFields / moveGroup | 同上 |
 * | moveTab          | 同上（源组+目标组同 stamp → 双 upsert；源组移空 → 修剪） |
 * | cleanDuplicates  | 同上（被移除 tab/组随整组 upsert / setOrder 修剪） |
 * | 任意 op          | setOrder 恒附带（快照 id 序列；物理删除的组经修剪移除） |
 *
 * 状态表示（与 Y.Doc 同构，测试用 plain 实现，生产经 ydoc.ts 适配到 Y.*）：
 * - groups: Map<groupId, GroupRec>；tabs: Map<`${groupId}:${tabId}`, TabRec>；
 * - order: string[]（组 id 序列）。
 */
import type { TabGroup } from '@/types/tab';
import type { MutationOp } from '@/shared/mutationProtocol';
import type { OpStamp } from '@/core/opStamp';

export interface YGroupRec {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  isLocked: boolean;
  is_deleted: boolean;
  /** D3：删除时刻（恢复时缺席；缺失回退对端 updatedAt） */
  deletedAt?: string;
  version: number;
  last_op_device: string | null;
  last_op_seq: number | null;
  notes?: string;
  isFavorite?: boolean;
}

export interface YTabRec {
  id: string;
  groupId: string;
  url: string;
  title: string;
  lastAccessed: string;
  is_deleted: boolean;
  /** D3：删除时刻（恢复时缺席） */
  deletedAt?: string;
  last_op_device: string | null;
  last_op_seq: number | null;
}

export type YPlan =
  | { kind: 'upsertGroup'; group: YGroupRec; tabs: YTabRec[] }
  | { kind: 'removeGroup'; groupId: string }
  | { kind: 'setOrder'; order: string[] };

export interface YStateLike {
  groups: Map<string, YGroupRec>;
  tabs: Map<string, YTabRec>;
  order: string[];
}

export function newYState(): YStateLike {
  return { groups: new Map(), tabs: new Map(), order: [] };
}

function stampOf(g: TabGroup): { d: string; s: number } | null {
  return g.lastOp && typeof g.lastOp.s === 'number' ? { d: g.lastOp.d, s: g.lastOp.s } : null;
}

function sameStamp(a: { d: string; s: number }, b: OpStamp): boolean {
  return a.d === b.d && a.s === b.s;
}

/** stamp 全序比较：d 字典序为主？不——与 opStampMerge 一致：s 为主信号。 */
function stampGte(a: { d: string; s: number } | null, b: OpStamp): boolean {
  if (!a) return false;
  if (a.s !== b.s) return a.s > b.s;
  return a.d >= b.d;
}

export function toYGroupRec(g: TabGroup): YGroupRec {
  const st = stampOf(g);
  return {
    id: g.id,
    name: g.name,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
    isLocked: g.isLocked,
    is_deleted: g.isDeleted === true,
    ...(g.deletedAt !== undefined ? { deletedAt: g.deletedAt } : {}),
    version: g.version ?? 1,
    last_op_device: st ? st.d : null,
    last_op_seq: st ? st.s : null,
    ...(g.notes !== undefined ? { notes: g.notes } : {}),
    ...(g.isFavorite !== undefined ? { isFavorite: g.isFavorite } : {}),
  };
}

export function toYTabRecs(g: TabGroup): YTabRec[] {
  return (g.tabs ?? []).map(t => ({
    id: t.id,
    groupId: g.id,
    url: t.url,
    title: t.title,
    lastAccessed: t.lastAccessed,
    is_deleted: t.isDeleted === true,
    ...(t.deletedAt !== undefined ? { deletedAt: t.deletedAt } : {}),
    last_op_device: t.lastOp ? t.lastOp.d : null,
    last_op_seq: t.lastOp ? t.lastOp.s : null,
  }));
}

/**
 * 统一翻译入口：按 stamp 从快照取受影响组（无墓碑模型，2026-09-29）。
 * 物理删除（deleteGroup/拿空组/deleteAllGroups 等）不再有专门的 op 分支——
 * 被删组从快照消失，由 setOrder 的修剪语义统一移除（见 applyYPlans）。
 * now 入参保留签名位（排序/时间回填未来用），本期未使用。
 */
export function planShadowSync(
  // _op：签名保留（调用方按 op 统一分发）；物理删除由 setOrder 修剪统一覆盖
  _op: MutationOp,
  snapshot: TabGroup[],
  stamp: OpStamp,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 签名预留位（排序/时间回填未来用）
  _now: string
): YPlan[] {
  const plans: YPlan[] = [];
  for (const g of snapshot) {
    const st = stampOf(g);
    if (st && sameStamp(st, stamp)) {
      plans.push({ kind: 'upsertGroup', group: toYGroupRec(g), tabs: toYTabRecs(g) });
    }
  }
  plans.push({ kind: 'setOrder', order: snapshot.map(g => g.id) });
  return plans;
}

/**
 * 计划应用（幂等 + stamp 门控后写赢）。state 既可是测试用 plain，也可经
 * ydoc.ts 的适配器接到真实 Y.Map/Y.Array（同一事务内调用）。
 */
export function applyYPlans(state: YStateLike, plans: YPlan[], stamp: OpStamp): void {
  for (const p of plans) {
    if (p.kind === 'upsertGroup') {
      const existing = state.groups.get(p.group.id);
      const existingStamp =
        existing && existing.last_op_seq != null
          ? { d: existing.last_op_device ?? '', s: existing.last_op_seq }
          : null;
      if (existingStamp && stampGte(existingStamp, stamp)) continue; // 旧 stamp 重放 → 跳过
      state.groups.set(p.group.id, p.group);
      // 先清本组旧镜像，再写入当前 tabs（删除意图不残留）
      for (const key of [...state.tabs.keys()]) {
        if (key.startsWith(`${p.group.id}:`)) state.tabs.delete(key);
      }
      for (const t of p.tabs) state.tabs.set(`${t.groupId}:${t.id}`, t);
    } else if (p.kind === 'removeGroup') {
      state.groups.delete(p.groupId);
      for (const key of [...state.tabs.keys()]) {
        if (key.startsWith(`${p.groupId}:`)) state.tabs.delete(key);
      }
      state.order = state.order.filter(id => id !== p.groupId);
    } else {
      // setOrder：直接采用快照顺序（快照即 blob 真源，读路径仍走 blob）。
      // 无墓碑模型：快照里缺席的组 = 已被物理删除，顺带从影子修剪
      // （含其 tabs）——删除意图由此传播，不再依赖专门的 removeGroup 计划。
      const alive = new Set(p.order);
      for (const id of [...state.groups.keys()]) {
        if (!alive.has(id)) {
          state.groups.delete(id);
          for (const key of [...state.tabs.keys()]) {
            if (key.startsWith(`${id}:`)) state.tabs.delete(key);
          }
        }
      }
      state.order = [...p.order];
    }
  }
}
