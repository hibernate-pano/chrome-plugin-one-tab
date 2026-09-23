/**
 * 按 OpStamp 全序决胜的合并纯函数（规格 §5）：替代现有 syncUtils.mergeTabGroups
 * （其使用 version + 时间戳 LWW）。同全序保证下，交换律/幂等/收敛自然成立。
 *
 * 设计要点：
 * - stamp 缺失视为全序最小值（EMPTY_STAMP），保证迁移前数据 + 云端空列正确输给
 *   任何带 stamp 的实体（§7.1）
 * - 合并设备产生的墓碑（§5.4 URL 败者）必须盖合并设备的 stamp，由调用方传入
 *   { mergeStamp }；此函数不做 IO
 * - 严格按 id 并集 + stamp 决胜；不引入 URL 维度墓碑（§5.4 已拍板：跨设备同 URL
 *   重加视为独立实体）
 */
import type { TabGroup, Tab } from '../types/tab';
import { compareStamps, EMPTY_STAMP } from './opStamp';
import type { OpStamp } from './opStamp';

export interface MergeOptions {
  /** 合并设备产生的墓碑（§5.4 URL 败者）盖此 stamp；不传则不盖 */
  mergeStamp?: OpStamp;
}

export function mergeOpStamped(
  local: TabGroup[],
  cloud: TabGroup[],
  opts: MergeOptions = {}
): TabGroup[] {
  const byId = new Map<string, { local?: TabGroup; cloud?: TabGroup }>();
  for (const g of local) byId.set(g.id, { ...(byId.get(g.id) || {}), local: g });
  for (const g of cloud) byId.set(g.id, { ...(byId.get(g.id) || {}), cloud: g });

  const merged: TabGroup[] = [];
  for (const [, sides] of byId) {
    const { local: lg, cloud: cg } = sides;
    if (lg && !cg) { merged.push(lg); continue; }
    if (cg && !lg) { merged.push(cg); continue; }
    // 都有 → 按 stamp 决胜组 + OR 锁 + 组字段跟随赢家
    const winner = pickByStamp(lg!, cg!);
    const mergedTabs = mergeTabsOpStamped(lg!.tabs, cg!.tabs, opts);
    // §5.2：name/isFavorite/displayOrder 跟随组 stamp 赢家；isLocked OR；
    // version 冻结保留赢家原值；notes 本地优先
    const out: TabGroup = {
      ...winner,
      id: winner.id,
      isLocked: !!(lg!.isLocked || cg!.isLocked),
      tabs: mergedTabs,
      version: winner.version, // §11 冻结，不参与判定
    };
    // notes：本地优先；仅在两侧至少有一侧有值时设置键（避免 { notes: undefined } 与 {} 不等）
    const notesVal = lg!.notes ?? cg!.notes;
    if (notesVal !== undefined) out.notes = notesVal;
    merged.push(out);
  }
  return merged;
}

function pickByStamp(a: TabGroup, b: TabGroup): TabGroup {
  const sa = a.lastOp ?? EMPTY_STAMP;
  const sb = b.lastOp ?? EMPTY_STAMP;
  return compareStamps(sa, sb) >= 0 ? a : b;
}

export function mergeTabsOpStamped(
  local: Tab[],
  cloud: Tab[],
  opts: MergeOptions = {}
): Tab[] {
  const byId = new Map<string, { local?: Tab; cloud?: Tab }>();
  for (const t of local) byId.set(t.id, { ...(byId.get(t.id) || {}), local: t });
  for (const t of cloud) byId.set(t.id, { ...(byId.get(t.id) || {}), cloud: t });

  const winners: Tab[] = [];
  for (const [, sides] of byId) {
    const { local: lt, cloud: ct } = sides;
    if (lt && !ct) { winners.push(lt); continue; }
    if (ct && !lt) { winners.push(ct); continue; }
    winners.push(pickTabByStamp(lt!, ct!));
  }

  // §5.4 URL 去重：同 URL 多活跃 tab，败者盖墓碑并盖 mergeStamp（合并设备产生的变更）。
  // 不传 mergeStamp → 仅决出胜者，不主动墓碑（默认保守路径）。
  if (!opts.mergeStamp) return winners;
  const byUrl = new Map<string, Tab[]>();
  for (const t of winners) {
    if (t.isDeleted) continue;
    if (!t.url) continue;
    const key = t.url.startsWith('loading://') ? `${t.url}|${t.title}` : t.url;
    if (!byUrl.has(key)) byUrl.set(key, []);
    byUrl.get(key)!.push(t);
  }

  const tombstoned = new Set<string>();
  for (const [, list] of byUrl) {
    if (list.length <= 1) continue;
    const sorted = [...list].sort((a, b) => {
      const sa = a.lastOp ?? EMPTY_STAMP;
      const sb = b.lastOp ?? EMPTY_STAMP;
      return compareStamps(sb, sa); // 高 → 低
    });
    for (let i = 1; i < sorted.length; i++) {
      tombstoned.add(sorted[i].id);
    }
  }

  return winners.map(t =>
    tombstoned.has(t.id)
      ? { ...t, isDeleted: true, lastOp: opts.mergeStamp as OpStamp }
      : t
  );
}

function pickTabByStamp(a: Tab, b: Tab): Tab {
  const sa = (a.lastOp ?? EMPTY_STAMP) as OpStamp;
  const sb = (b.lastOp ?? EMPTY_STAMP) as OpStamp;
  return compareStamps(sa, sb) >= 0 ? a : b;
}