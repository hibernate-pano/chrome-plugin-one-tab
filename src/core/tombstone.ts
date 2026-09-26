/**
 * D3 · 墓碑 7 天生命周期（客户端 single-source）。
 *
 * - TOMBSTONE_RETENTION_MS：7 天。对外承诺「删除后 7 天内可在回收站恢复，
 *   7 天后彻底删除」。写死常量，不做 per-user 配置（见 v2-plan §10）。
 * - expiresAtOf：墓碑到期时刻。deletedAt 缺失（老数据/老客户端）→ 回退
 *   updatedAt（组）/ lastAccessed（tab）；仍缺失 → 回退 now（按刚删除计，
 *   再留 7 天；偏保守，绝不提前清除）。
 * - isExpired：是否到期。
 * - sweepExpiredTombstones：纯函数。移除到期墓碑（组级整组移除；tab 级从组内
 *   摘除；摘空且未锁定的组整组移除——与 cleanDuplicates 空组语义一致），
 *   返回存活组 + 被清 id 清单。执行接线属 P2（需经单写者 sweepExpired op，
 *   见 v2-plan §6 P2）；本期只钉语义与单测。
 */
import type { TabGroup } from '@/types/tab';

/** 7 天（毫秒） */
export const TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function tsOf(v: string | undefined, fallbackNow: number): number {
  if (!v) return fallbackNow;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? fallbackNow : t;
}

/** 组墓碑到期时刻（ms 时间戳） */
export function groupExpiresAt(g: TabGroup, nowMs?: number): number {
  const now = nowMs ?? Date.now();
  const base = g.deletedAt ?? g.updatedAt;
  return tsOf(base, now) + TOMBSTONE_RETENTION_MS;
}

/** tab 墓碑到期时刻（ms 时间戳；回退组 updatedAt → now） */
export function tabExpiresAt(
  t: { deletedAt?: string; lastAccessed: string },
  groupUpdatedAt: string | undefined,
  nowMs?: number
): number {
  const now = nowMs ?? Date.now();
  const base = t.deletedAt ?? t.lastAccessed ?? groupUpdatedAt;
  return tsOf(base, now) + TOMBSTONE_RETENTION_MS;
}

export function isGroupExpired(g: TabGroup, nowMs: number): boolean {
  if (g.isDeleted !== true) return false;
  return nowMs >= groupExpiresAt(g, nowMs);
}

export interface TombstoneSweep {
  groups: TabGroup[];
  /** 被物理清除的组 id（含摘空连带移除的组） */
  sweptGroupIds: string[];
  /** 被物理清除的 tab key（`${groupId}:${tabId}`，组被整组清除时不同时列其 tabs） */
  sweptTabKeys: string[];
}

export function sweepExpiredTombstones(groups: TabGroup[], nowMs: number): TombstoneSweep {
  const sweptGroupIds: string[] = [];
  const sweptTabKeys: string[] = [];
  const out: TabGroup[] = [];

  for (const g of groups ?? []) {
    if (g.isDeleted === true) {
      if (isGroupExpired(g, nowMs)) {
        sweptGroupIds.push(g.id);
        continue;
      }
      out.push(g);
      continue;
    }
    const tabs = Array.isArray(g.tabs) ? g.tabs : [];
    const kept = tabs.filter(t => {
      if (t.isDeleted !== true) return true;
      if (nowMs >= tabExpiresAt(t, g.updatedAt, nowMs)) {
        sweptTabKeys.push(`${g.id}:${t.id}`);
        return false;
      }
      return true;
    });
    if (kept.length === 0 && tabs.length > 0 && !g.isLocked) {
      // 摘空且未锁定 → 整组移除（与 cleanDuplicates 空组墓碑语义对齐，此处直接物理移除
      // 是因为组内已无任何未到期实体；锁定组保留空壳等待整组到期）。
      sweptGroupIds.push(g.id);
      continue;
    }
    out.push(kept.length === tabs.length ? g : { ...g, tabs: kept });
  }

  return { groups: out, sweptGroupIds, sweptTabKeys };
}
