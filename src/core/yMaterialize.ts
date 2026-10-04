/**
 * V2 影子双写 · Dexie 物化视图（读路径本期仍走 blob，此视图仅供查询/验证）。
 *
 * 库名 'tapstack-y-mv'，版本 1：
 * - tab_groups 表：主键 id；索引 updatedAt / is_deleted
 *   schema: 'id, updatedAt, is_deleted'
 * - tabs 表：主键 id（`${groupId}:${tabId}` 全局唯一）；索引 groupId / updatedAt / is_deleted
 *   schema: 'id, groupId, updatedAt, is_deleted'
 *
 * snapshotToRows() 为纯函数（node:test 直测）；writeMaterializedView() 内动态
 * import('dexie')（vite 异步 chunk，主包零增长），indexedDB 不可用时返回
 * { persisted: false } 且永不抛错（影子链路不阻断主同步）。
 *
 * 一致性：写入走 upsert + 差集删除（bulkDelete 本次快照缺席的主键），
 * 否则 purge/移出组的行会在物化视图里永久残留，与 Y.Doc 静默分叉。
 * 物化视图是 Y.Doc 的全量镜像（快照即真相），不做增量合并。
 */
import type { YGroupRec, YTabRec } from '@/core/yTranslate';

export const MV_DB_NAME = 'tapstack-y-mv';
export const MV_DB_VERSION = 1;

/** Dexie stores 定义（索引 = groupId / updatedAt / is_deleted，见文件头） */
export const MV_STORES_SCHEMA: Record<string, string> = {
  tab_groups: 'id, updatedAt, is_deleted',
  tabs: 'id, groupId, updatedAt, is_deleted',
};

export interface MVGroupRow extends YGroupRec {
  tabCount: number;
}

export interface MVTabRow extends YTabRec {
  updatedAt: string;
}

export interface MVMaterialized {
  groups: MVGroupRow[];
  tabs: MVTabRow[];
}

/**
 * Y 快照（plain record 形态）→ Dexie 行。
 *
 * 【tabCount 为什么必须先计数一遍】
 * 原实现是在 groups.map 里对**全表 tabs 做一次 filter**：O(G×T)。
 * 实测 1000 组 × 20 标签（2 万标签）≈ 2.9 秒，而等价的「先按 groupId 计数一遍、
 * 再查表」只要 4ms（711x）；300 组时是 184ms → 0.9ms（196x）。
 *
 * 这不是无关紧要的后台开销：snapshotToRows 是**同步纯计算**，跑在 Service Worker
 * 的唯一线程上。影子写虽然 fire-and-forget（不 await），但它一旦开始同步计算，
 * 这段时间内 SW 无法执行队列里的下一个任务 —— 用户点「删除会话 / 清理重复」
 * 就得等它算完。也就是说这条 O(G×T) 直接转成了用户可感知的点击延迟，
 * 且随会话数**平方级**恶化（正是「数据越多越卡」的形状）。
 *
 * 语义完全等价：计数条件仍是「groupId 匹配且 is_deleted 为假」，
 * 不属于任何组的 tab 依旧不计入任何组。
 */
export function snapshotToRows(snapshot: {
  groups: Record<string, YGroupRec>;
  tabs: Record<string, YTabRec>;
  order: string[];
}): MVMaterialized {
  const orderIdx = new Map(snapshot.order.map((id, i) => [id, i]));
  const tabValues = Object.values(snapshot.tabs);
  // 一次遍历按 groupId 累加活跃 tab 数（跳过墓碑），之后 O(1) 查表
  const activeTabCounts = new Map<string, number>();
  for (const t of tabValues) {
    if (t.is_deleted) continue;
    activeTabCounts.set(t.groupId, (activeTabCounts.get(t.groupId) ?? 0) + 1);
  }
  const groups = Object.values(snapshot.groups)
    .map(g => ({
      ...g,
      tabCount: activeTabCounts.get(g.id) ?? 0,
    }))
    .sort((a, b) => (orderIdx.get(a.id) ?? 0) - (orderIdx.get(b.id) ?? 0));
  const tabs = tabValues.map(t => ({
    ...t,
    updatedAt: t.lastAccessed,
  }));
  return { groups, tabs };
}

export interface MVMemoryFallback {
  groups: MVGroupRow[];
  tabs: MVTabRow[];
}

/** 内存兜底（node/无 indexedDB 环境；SW 被杀后下次影子写重建） */
const memoryFallback: MVMemoryFallback = { groups: [], tabs: [] };

export function readMemoryFallback(): MVMemoryFallback {
  return { groups: [...memoryFallback.groups], tabs: [...memoryFallback.tabs] };
}

/** Dexie 最小面（供默认实现与 node 单测替身共用） */
export interface MVDbLike {
  version(v: number): { stores(s: Record<string, string>): unknown };
  table<T extends { id: string }>(name: string): {
    toCollection(): { primaryKeys(): Promise<string[]> };
    bulkPut(rows: T[]): Promise<void>;
    bulkDelete(keys: string[]): Promise<void>;
  };
  close(): void;
}

/** upsert + 差集删除：让表内容收敛到本次快照（不残留已消失的 id） */
async function syncStore<T extends { id: string }>(db: MVDbLike, name: string, rows: T[]): Promise<void> {
  const table = db.table<T>(name);
  await table.bulkPut(rows);
  const keep = new Set(rows.map(r => r.id));
  const stale = (await table.toCollection().primaryKeys()).filter(id => !keep.has(id));
  if (stale.length > 0) await table.bulkDelete(stale);
}

/** 物化写入 Dexie（幂等 upsert + 删除缺席行；失败/无 indexedDB → 内存兜底，永不抛错） */
export async function writeMaterializedView(
  rows: MVMaterialized,
  /** createDb 仅供 node 单测注入（node 无 indexedDB，无法直测删除路径） */
  opts: { createDb?: () => MVDbLike } = {}
): Promise<{ persisted: boolean; groups: number; tabs: number }> {
  memoryFallback.groups = rows.groups;
  memoryFallback.tabs = rows.tabs;
  let db: MVDbLike | null = null;
  try {
    if (opts.createDb) {
      db = opts.createDb();
    } else {
      if (typeof indexedDB === 'undefined') {
        return { persisted: false, groups: rows.groups.length, tabs: rows.tabs.length };
      }
      const { default: Dexie } = await import('dexie');
      db = new Dexie(MV_DB_NAME) as unknown as MVDbLike;
    }
    db.version(MV_DB_VERSION).stores(MV_STORES_SCHEMA);
    await syncStore(db, 'tab_groups', rows.groups);
    await syncStore(db, 'tabs', rows.tabs);
    return { persisted: true, groups: rows.groups.length, tabs: rows.tabs.length };
  } catch {
    return { persisted: false, groups: rows.groups.length, tabs: rows.tabs.length };
  } finally {
    // bulkPut 失败也必须关闭，否则 Dexie 连接泄漏
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}
