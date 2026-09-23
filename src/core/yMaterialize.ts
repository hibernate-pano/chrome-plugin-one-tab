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

/** Y 快照（plain record 形态）→ Dexie 行 */
export function snapshotToRows(snapshot: {
  groups: Record<string, YGroupRec>;
  tabs: Record<string, YTabRec>;
  order: string[];
}): MVMaterialized {
  const orderIdx = new Map(snapshot.order.map((id, i) => [id, i]));
  const groups = Object.values(snapshot.groups)
    .map(g => ({
      ...g,
      tabCount: Object.values(snapshot.tabs).filter(t => t.groupId === g.id && !t.is_deleted).length,
    }))
    .sort((a, b) => (orderIdx.get(a.id) ?? 0) - (orderIdx.get(b.id) ?? 0));
  const tabs = Object.values(snapshot.tabs).map(t => ({
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

/** 物化写入 Dexie（幂等 bulkPut；失败/无 indexedDB → 内存兜底，永不抛错） */
export async function writeMaterializedView(
  rows: MVMaterialized
): Promise<{ persisted: boolean; groups: number; tabs: number }> {
  memoryFallback.groups = rows.groups;
  memoryFallback.tabs = rows.tabs;
  try {
    if (typeof indexedDB === 'undefined') return { persisted: false, groups: rows.groups.length, tabs: rows.tabs.length };
    const { default: Dexie } = await import('dexie');
    const db = new Dexie(MV_DB_NAME) as unknown as {
      version(v: number): { stores(s: Record<string, string>): unknown };
      table<T>(name: string): { bulkPut(rows: T[]): Promise<void> };
      close(): void;
    };
    db.version(MV_DB_VERSION).stores(MV_STORES_SCHEMA);
    await db.table<MVGroupRow>('tab_groups').bulkPut(rows.groups);
    await db.table<MVTabRow>('tabs').bulkPut(rows.tabs);
    db.close();
    return { persisted: true, groups: rows.groups.length, tabs: rows.tabs.length };
  } catch {
    return { persisted: false, groups: rows.groups.length, tabs: rows.tabs.length };
  }
}
