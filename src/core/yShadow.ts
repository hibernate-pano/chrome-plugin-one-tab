/**
 * V2 影子双写 · 异步写入口（mutation 落盘成功后调用，读路径仍走 blob）。
 *
 * 调用约定（见 src/background/mutationHandlers.ts handle()）：
 * - 仅在主写 ok 时 fire-and-forget 调用；本函数永不抛错（全程 try/catch），
 *   永不阻断主同步，结果写入 SHADOW_LOG_KEY（journallog 化，供调试视图读取）。
 * - 顺序：kill-switch → 灰度采样 → 取快照 → 翻译 plans → withYDoc 单事务
 *   应用（y-indexeddb 持久化 best-effort）→ update 进 KV 日志（compact 阈值
 *   检查）→ Dexie 物化视图。
 * - MV3 可杀：Y.Doc 短命（withYDoc 内建内销）；KV/Dexie 写失败各自吞错记录。
 *
 * 可测性：docRunner 可注入替身；默认走真实 ydoc/yMaterialize。
 */
import type { TabGroup } from '@/types/tab';
import type { MutationOp } from '@/shared/mutationProtocol';
import type { OpStamp } from '@/core/opStamp';
import type { YPlan } from '@/core/yTranslate';
import { planShadowSync } from '@/core/yTranslate';
import {
  COMPACT_LOG_BYTES_THRESHOLD,
  COMPACT_LOG_COUNT_THRESHOLD,
  SHADOW_LOG_KEY,
  SHADOW_LOG_MAX,
  SHADOW_ROLLOUT_PERCENT,
  SHADOW_WRITE_ENABLED,
  Y_UPDATE_LOG_KEY,
  isShadowSampled,
} from '@/core/yShadowConfig';

export interface ShadowDeps {
  getGroups(): Promise<TabGroup[]>;
  getUserId(): Promise<string | null>;
  kvGet<T>(key: string): Promise<T | null>;
  kvSet(key: string, value: unknown): Promise<void>;
  /** 注入点（测试替身）；默认真实实现（Y.Doc 单事务 + Dexie 物化） */
  docRunner?: (plans: YPlan[], stamp: OpStamp) => Promise<{ updateBytes: number; updateB64: string }>;
  now?: () => string;
}

export type ShadowOutcome =
  | { ok: true; plans: number; updateBytes: number; needsSnapshot: boolean }
  | { ok: false; skipped: 'killed' | 'rollout' | 'empty' | 'error'; error?: string };

export interface ShadowLogEntry {
  ts: string;
  op: MutationOp['op'];
  stamp: OpStamp;
  outcome: ShadowOutcome;
}

function toB64(bytes: Uint8Array): string {
  if (typeof btoa !== 'undefined') {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  // node 兜底（SW/浏览器恒走 btoa；单测走注入 runner，不经过此函数）
  return Buffer.from(bytes).toString('base64');
}

/** 默认 runner：同一短命 Doc 会话内应用 plans 并读回快照 → Dexie 物化（内部永不抛错） */
async function defaultDocRunner(
  plans: YPlan[],
  stamp: OpStamp
): Promise<{ updateBytes: number; updateB64: string }> {
  const { withYDoc, plansToDoc, readDocSnapshot } = await import('@/core/ydoc');
  const { snapshotToRows, writeMaterializedView } = await import('@/core/yMaterialize');
  const { result: snap, update } = await withYDoc(doc => {
    plansToDoc(doc, plans, stamp);
    return readDocSnapshot(doc);
  });
  try {
    await writeMaterializedView(snapshotToRows(snap));
  } catch {
    /* 物化失败不影响影子主结果 */
  }
  return { updateBytes: update.length, updateB64: toB64(update) };
}

export async function maybeShadowWrite(
  op: MutationOp,
  stamp: OpStamp,
  now: string,
  deps: ShadowDeps
): Promise<ShadowOutcome> {
  const ts = deps.now ? deps.now() : new Date().toISOString();
  let outcome: ShadowOutcome;
  try {
    if (!SHADOW_WRITE_ENABLED) {
      outcome = { ok: false, skipped: 'killed' };
    } else {
      let userId: string | null = null;
      try {
        userId = await deps.getUserId();
      } catch {
        userId = null;
      }
      if (!isShadowSampled(userId, SHADOW_ROLLOUT_PERCENT)) {
        outcome = { ok: false, skipped: 'rollout' };
      } else {
        const snapshot = await deps.getGroups();
        const plans = planShadowSync(op, snapshot, stamp, now);
        const meaningful = plans.filter(p => p.kind !== 'setOrder');
        if (meaningful.length === 0) {
          // 快照里找不到本次 stamp（如并发覆盖）或 purge 后无残留 → 记 empty，不写 Y
          outcome = { ok: false, skipped: 'empty' };
        } else {
          const runner = deps.docRunner ?? defaultDocRunner;
          const { updateBytes, updateB64 } = await runner(plans, stamp);
          const needsSnapshot = await appendUpdateLog(deps, {
            ts,
            stamp,
            op: op.op,
            updateB64,
            updateBytes,
          });
          outcome = { ok: true, plans: plans.length, updateBytes, needsSnapshot };
        }
      }
    }
  } catch (e) {
    outcome = { ok: false, skipped: 'error', error: e instanceof Error ? e.message : String(e) };
  }
  await appendShadowLog(deps, { ts, op: op.op, stamp, outcome });
  return outcome;
}

interface UpdateLogItem {
  ts: string;
  stamp: OpStamp;
  op: string;
  updateB64: string;
  updateBytes: number;
}

/** Y update KV 日志追加（FIFO 上限 COMPACT_LOG_COUNT_THRESHOLD；超阈值 → needsSnapshot=true） */
async function appendUpdateLog(deps: ShadowDeps, item: UpdateLogItem): Promise<boolean> {
  try {
    const cur = (await deps.kvGet<UpdateLogItem[]>(Y_UPDATE_LOG_KEY)) ?? [];
    const next = [...cur, item];
    while (next.length > COMPACT_LOG_COUNT_THRESHOLD) next.splice(0, next.length - COMPACT_LOG_COUNT_THRESHOLD);
    await deps.kvSet(Y_UPDATE_LOG_KEY, next);
    const bytes = next.reduce((n, e) => n + (e.updateBytes || 0), 0);
    return next.length >= COMPACT_LOG_COUNT_THRESHOLD || bytes >= COMPACT_LOG_BYTES_THRESHOLD;
  } catch {
    return false;
  }
}

/** 影子结果 journallog 化（FIFO 上限 SHADOW_LOG_MAX；写失败吞错） */
async function appendShadowLog(deps: ShadowDeps, entry: ShadowLogEntry): Promise<void> {
  try {
    const cur = (await deps.kvGet<ShadowLogEntry[]>(SHADOW_LOG_KEY)) ?? [];
    const next = [...cur, entry];
    if (next.length > SHADOW_LOG_MAX) next.splice(0, next.length - SHADOW_LOG_MAX);
    await deps.kvSet(SHADOW_LOG_KEY, next);
  } catch {
    /* 影子日志自身失败不阻断任何事 */
  }
}
