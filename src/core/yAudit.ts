/**
 * P1 · 影子对账（Y.Doc 物化视图 vs 本地真相 storage.getGroups）。
 *
 * - auditShadowConsistency：纯函数。比较组 id 集（双向）、组字段
 *  （name/updatedAt/isLocked/is_deleted）、tab 集与字段
 *  （url/title/lastAccessed/is_deleted）、组顺序。mismatch 上限截断，
 *   供日志与调试视图消费；永不抛错（输入畸形 → 记 mismatch）。
 * - maybeAuditConsistency：采样执行器。默认 5%（见 AUDIT_SAMPLE_PERCENT），
 *   fire-and-forget 语义：任何失败吞错返回 null，主同步零影响。
 *   对账只读（withYDoc 短命会话读快照），不写 Y、不碰网络。
 * - 每次命中采样写两份：逐条结果进 y_audit_log（FIFO 50，排障看单次差异形状），
 *   按天聚合进 y_audit_daily（FIFO 30 天，**门禁判定读这份**——逐条日志的窗口
 *   比 7 天门禁短，靠它无法证明「持续达标」，见 yGate.evaluateShadowGate）。
 */
import type { TabGroup } from '@/types/tab';
import type { MVMaterialized } from '@/core/yMaterialize';
import type { AuditDailyBucket } from '@/core/yGate';
import { foldAuditDaily } from '@/core/yGate';
import {
  AUDIT_LOG_MAX,
  AUDIT_SAMPLE_PERCENT,
  Y_AUDIT_DAILY_KEY,
  Y_AUDIT_LOG_KEY,
  isShadowSampled,
} from '@/core/yShadowConfig';

export interface AuditMismatch {
  scope: 'group' | 'tab' | 'order';
  id: string;
  field: string;
  ySide: unknown;
  localSide: unknown;
}

export interface AuditResult {
  checkedGroups: number;
  checkedTabs: number;
  mismatches: AuditMismatch[];
  match: boolean;
  /** mismatch 数 / max(1, 组数+tab数)，供阈值告警（P1 门：<0.1% 持续 7 天） */
  mismatchRate: number;
}

const MAX_MISMATCHES_DEFAULT = 20;

function push(list: AuditMismatch[], m: AuditMismatch, cap: number): void {
  if (list.length < cap) list.push(m);
}

export function auditShadowConsistency(
  y: MVMaterialized,
  local: TabGroup[],
  opts?: { maxMismatches?: number }
): AuditResult {
  const cap = opts?.maxMismatches ?? MAX_MISMATCHES_DEFAULT;
  const mismatches: AuditMismatch[] = [];
  try {
    const yGroups = new Map((y.groups ?? []).map(g => [g.id, g]));
    const localGroups = new Map((local ?? []).map(g => [g.id, g]));

    for (const id of localGroups.keys()) {
      if (!yGroups.has(id)) {
        push(mismatches, { scope: 'group', id, field: 'missing_in_y', ySide: null, localSide: 'present' }, cap);
      }
    }
    for (const id of yGroups.keys()) {
      if (!localGroups.has(id)) {
        push(mismatches, { scope: 'group', id, field: 'missing_local', ySide: 'present', localSide: null }, cap);
      }
    }

    const yTabs = new Map((y.tabs ?? []).map(t => [t.id, t]));

    for (const [id, g] of localGroups) {
      const yg = yGroups.get(id);
      if (!yg) continue;
      if ((yg.name ?? null) !== (g.name ?? null)) {
        push(mismatches, { scope: 'group', id, field: 'name', ySide: yg.name, localSide: g.name }, cap);
      }
      if ((yg.updatedAt ?? null) !== (g.updatedAt ?? null)) {
        push(mismatches, { scope: 'group', id, field: 'updatedAt', ySide: yg.updatedAt, localSide: g.updatedAt }, cap);
      }
      if ((yg.isLocked ?? false) !== (g.isLocked ?? false)) {
        push(mismatches, { scope: 'group', id, field: 'isLocked', ySide: yg.isLocked, localSide: g.isLocked }, cap);
      }
      if ((yg.is_deleted ?? false) !== (g.isDeleted === true)) {
        push(mismatches, { scope: 'group', id, field: 'is_deleted', ySide: yg.is_deleted, localSide: g.isDeleted === true }, cap);
      }
      if ((yg.deletedAt ?? null) !== (g.deletedAt ?? null)) {
        push(mismatches, { scope: 'group', id, field: 'deletedAt', ySide: yg.deletedAt ?? null, localSide: g.deletedAt ?? null }, cap);
      }
      const localTabs = Array.isArray(g.tabs) ? g.tabs : [];
      for (const t of localTabs) {
        const key = `${id}:${t.id}`;
        const yt = yTabs.get(key);
        if (!yt) {
          push(mismatches, { scope: 'tab', id: key, field: 'missing_in_y', ySide: null, localSide: 'present' }, cap);
          continue;
        }
        if ((yt.url ?? null) !== (t.url ?? null)) {
          push(mismatches, { scope: 'tab', id: key, field: 'url', ySide: yt.url, localSide: t.url }, cap);
        }
        if ((yt.title ?? null) !== (t.title ?? null)) {
          push(mismatches, { scope: 'tab', id: key, field: 'title', ySide: yt.title, localSide: t.title }, cap);
        }
        if ((yt.lastAccessed ?? null) !== (t.lastAccessed ?? null)) {
          push(mismatches, { scope: 'tab', id: key, field: 'lastAccessed', ySide: yt.lastAccessed, localSide: t.lastAccessed }, cap);
        }
        if ((yt.is_deleted ?? false) !== (t.isDeleted === true)) {
          push(mismatches, { scope: 'tab', id: key, field: 'is_deleted', ySide: yt.is_deleted, localSide: t.isDeleted === true }, cap);
        }
        if (((yt as { deletedAt?: string }).deletedAt ?? null) !== ((t as { deletedAt?: string }).deletedAt ?? null)) {
          push(
            mismatches,
            {
              scope: 'tab',
              id: key,
              field: 'deletedAt',
              ySide: (yt as { deletedAt?: string }).deletedAt ?? null,
              localSide: (t as { deletedAt?: string }).deletedAt ?? null,
            },
            cap
          );
        }
      }
    }

    // Y 侧多余 tab（本地组存在但 tab 已不在组内，如移出组残留 —— 物化差集删除的回归探针）
    const localTabKeys = new Set<string>();
    for (const g of localGroups.values()) {
      for (const t of Array.isArray(g.tabs) ? g.tabs : []) localTabKeys.add(`${g.id}:${t.id}`);
    }
    for (const key of yTabs.keys()) {
      if (!localTabKeys.has(key)) {
        push(mismatches, { scope: 'tab', id: key, field: 'missing_local', ySide: 'present', localSide: null }, cap);
      }
    }

    // 组顺序：Y groups 已按 order 排序；与本地数组顺序逐位比（长度不齐按缺失记）
    const yOrder = (y.groups ?? []).map(g => g.id);
    const localOrder = (local ?? []).map(g => g.id);
    const n = Math.max(yOrder.length, localOrder.length);
    for (let i = 0; i < n; i++) {
      if (yOrder[i] !== localOrder[i]) {
        push(
          mismatches,
          { scope: 'order', id: `pos:${i}`, field: 'order', ySide: yOrder[i] ?? null, localSide: localOrder[i] ?? null },
          cap
        );
        break; // 顺序分叉记一条，避免刷屏
      }
    }
  } catch (e) {
    push(
      mismatches,
      { scope: 'group', id: '*', field: 'audit_crashed', ySide: null, localSide: e instanceof Error ? e.message : String(e) },
      cap
    );
  }

  const checkedGroups = (local ?? []).length;
  const checkedTabs = (local ?? []).reduce((k, g) => k + (Array.isArray(g.tabs) ? g.tabs.length : 0), 0);
  const denom = Math.max(1, checkedGroups + checkedTabs);
  return {
    checkedGroups,
    checkedTabs,
    mismatches,
    match: mismatches.length === 0,
    mismatchRate: mismatches.length / denom,
  };
}

export interface AuditDeps {
  getGroups(): Promise<TabGroup[]>;
  getUserId(): Promise<string | null>;
  kvGet<T>(key: string): Promise<T | null>;
  kvSet(key: string, value: unknown): Promise<void>;
  /** 注入点（测试替身）；默认读真实 Y 快照 → 物化行 */
  readMaterialized?: () => Promise<MVMaterialized>;
  /** 采样 key 覆写（仅测试用；默认 `${userId}:${seq}`） */
  sampleKey?: string;
  now?: () => string;
}

export interface AuditLogEntry {
  ts: string;
  sampleKey: string;
  result: AuditResult;
}

async function defaultReadMaterialized(): Promise<MVMaterialized> {
  const { withYDoc, readDocSnapshot } = await import('@/core/ydoc');
  const { snapshotToRows } = await import('@/core/yMaterialize');
  const { result: snap } = await withYDoc(doc => readDocSnapshot(doc));
  return snapshotToRows(snap);
}

/** 采样对账：命中采样才读 Y；结果进 y_audit_log（FIFO）；永不抛错 */
export async function maybeAuditConsistency(
  seq: number,
  deps: AuditDeps
): Promise<AuditResult | null> {
  try {
    let userId: string | null = null;
    try {
      userId = await deps.getUserId();
    } catch {
      userId = null;
    }
    const key = deps.sampleKey ?? `${userId ?? 'local'}:${seq}`;
    if (!isShadowSampled(key, AUDIT_SAMPLE_PERCENT)) return null;
    const reader = deps.readMaterialized ?? defaultReadMaterialized;
    const [y, local] = await Promise.all([reader(), deps.getGroups()]);
    const result = auditShadowConsistency(y, local);
    const ts = deps.now ? deps.now() : new Date().toISOString();
    try {
      const cur = (await deps.kvGet<AuditLogEntry[]>(Y_AUDIT_LOG_KEY)) ?? [];
      const next = [...cur, { ts, sampleKey: key, result }];
      while (next.length > AUDIT_LOG_MAX) next.splice(0, next.length - AUDIT_LOG_MAX);
      await deps.kvSet(Y_AUDIT_LOG_KEY, next);
    } catch {
      /* 日志失败不影响对账结果返回 */
    }
    // 按天聚合：门禁判定读这份（逐条日志只留 50 条，窗口比 7 天门禁短，
    // 见 yShadowConfig.Y_AUDIT_DAILY_KEY 的说明）。独立 try：
    // 逐条日志写失败不该连带丢掉落进聚合的那份门禁事实。
    try {
      const curDaily = await deps.kvGet<AuditDailyBucket[]>(Y_AUDIT_DAILY_KEY);
      await deps.kvSet(Y_AUDIT_DAILY_KEY, foldAuditDaily(curDaily, ts, result));
    } catch {
      /* 聚合失败不影响对账结果返回 */
    }
    return result;
  } catch {
    return null;
  }
}
