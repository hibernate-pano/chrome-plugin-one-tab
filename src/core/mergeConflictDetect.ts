/**
 * 并发覆盖检测（P0-1）：把「多台设备同时改了同一个会话、整组印记决胜后一边的
 * 改动被静默覆盖」这件事变成**可判定的事实**。
 *
 * ── 为什么不能只比「两端内容不同」──────────────────────────────────────────
 * 组级 LWW 整组覆盖下，「云端比本机新」有两种完全不同的成因：
 *   ① 本机没改过，只是另一台设备改了 → 本机只是**落后**，采纳云端天经地义；
 *   ② 本机也改了，两边同时改 → 本机的改动被覆盖 = **真数据丢失**。
 * 只有内容差异无法区分这两者（后者才是必须提示用户的），所以需要一个
 * 「上次双方达成一致时的组印」作为**共同祖先**（基线）。本模块只用基线做
 * 一件很窄的事：判断**某一侧自上次一致后有没有改过**——印记（lastOp）随每次
 * 改动单调提升，比较当前印记与基线印记是否相等即可，无需存整份内容。
 *
 * ── 判定（全部条件同时成立才报）────────────────────────────────────────────
 *   1. 该组两端都存在且都活跃（墓碑/单侧不涉及「覆盖」）；
 *   2. 该组在本轮「活跃 vs 活跃」里被整组覆盖（由 mergeOpStampedDetailed 的
 *      winnerByGroupId 给出赢家）；
 *   3. 基线里有该组（首次同步/新增组没有基线 ⇒ 无法判断是否并发，只建立基线）；
 *   4. **两端印记都 != 基线印记**（都改过）——只有一端变，那是「另一端落后」；
 *   5. 败方有、赢方没有的标签数 > 0，或组名不同（否则只是删标签的传播，不算丢数据）。
 *
 * 这样既不产生「恒为 0 的假数字」（真实并发场景会命中），也不会把
 * 「云端只是比你新」误报成冲突（条件 4 挡住）。
 */
import type { TabGroup } from '../types/tab';
import type { OpStamp } from './opStamp';

/** 上次同步「双方一致」时的组印记账本：groupId → 该组当时达成一致的 lastOp。 */
export type StampLedger = Record<string, OpStamp>;

export type ConflictWinner = 'local' | 'cloud';

/** 一个被整组覆盖、且两端自上次一致后都改过的会话（事实，不是推断）。 */
export interface MergeConflict {
  groupId: string;
  /** 赢家的组名（覆盖后用户看到的那个名字）。 */
  name: string;
  /** 哪一侧的版本被采用。'cloud' = 云端赢了本地；'local' = 本地即将覆盖云端。 */
  winner: ConflictWinner;
  /** 败方有、赢方没有的标签数（真正被这轮覆盖抹掉的标签）。 */
  lostTabs: number;
  localTabCount: number;
  cloudTabCount: number;
}

/** 后台写盘、popup 挂载时读取展示的待办提示（持久化，跨 SW/popup 生命周期）。 */
export interface PendingConflictNotice {
  /** 写入时刻 ISO 字符串。 */
  at: string;
  totalGroups: number;
  totalLostTabs: number;
  /** 每个被覆盖会话的精简描述（最多保留 20 条，避免 KV 值膨胀）。 */
  groups: Array<{ name: string; lostTabs: number; winner: ConflictWinner }>;
}

function stampOf(g: TabGroup): OpStamp {
  return g.lastOp ?? { d: '', s: 0 };
}

function sameStamp(a: OpStamp, b: OpStamp): boolean {
  return a.d === b.d && a.s === b.s;
}

/**
 * 从本轮合并的产出里挑出「真并发覆盖」。
 *
 * @param local   本轮参与合并的本地组
 * @param cloud   本轮参与合并的云端组
 * @param ancestor 上次一致基线（groupId → lastOp）；缺失表示首次同步
 * @param winnerByGroupId 本轮「活跃 vs 活跃」的赢家（mergeOpStampedDetailed 产出）
 */
export function detectMergeConflicts(
  local: TabGroup[],
  cloud: TabGroup[],
  ancestor: StampLedger,
  winnerByGroupId: ReadonlyMap<string, ConflictWinner>
): MergeConflict[] {
  const localById = new Map(local.map(g => [g.id, g]));
  const cloudById = new Map(cloud.map(g => [g.id, g]));
  const out: MergeConflict[] = [];

  for (const [id, winner] of winnerByGroupId) {
    const lg = localById.get(id);
    const cg = cloudById.get(id);
    // 条件 1：两端都在且都活跃
    if (!lg || !cg) continue;
    if (lg.isDeleted || cg.isDeleted) continue;

    // 条件 3：必须有基线，否则无法判断「是否并发」，本次只建立基线
    const anc = ancestor[id];
    if (!anc) continue;

    // 条件 4：两端都自上次一致后改过
    const localChanged = !sameStamp(stampOf(lg), anc);
    const cloudChanged = !sameStamp(stampOf(cg), anc);
    if (!localChanged || !cloudChanged) continue;

    const winnerGroup = winner === 'local' ? lg : cg;
    const loserGroup = winner === 'local' ? cg : lg;
    const winnerTabIds = new Set(winnerGroup.tabs.map(t => t.id));
    const lostTabs = loserGroup.tabs.filter(t => !winnerTabIds.has(t.id)).length;
    const nameChanged = winnerGroup.name !== loserGroup.name;

    // 条件 5：确实丢了内容（标签或名字），否则只是删除传播，不算数据丢失
    if (lostTabs === 0 && !nameChanged) continue;

    out.push({
      groupId: id,
      name: winnerGroup.name,
      winner,
      lostTabs,
      localTabCount: lg.tabs.length,
      cloudTabCount: cg.tabs.length,
    });
  }

  return out;
}

/** 用「本轮合并结果」建立下一轮基线。墓碑不记（它已退出活跃集合）。 */
export function buildStampLedger(groups: TabGroup[]): StampLedger {
  const ledger: StampLedger = {};
  for (const g of groups) {
    if (g.isDeleted) continue;
    ledger[g.id] = stampOf(g);
  }
  return ledger;
}