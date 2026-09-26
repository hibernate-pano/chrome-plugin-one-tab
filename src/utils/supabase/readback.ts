/**
 * S3 拆分 · readback：上传/墓碑/硬删读回校验（纯比对 compare* + IO 验证 verify*）。
 * （原 src/utils/supabase.ts 对应节逐字搬运；verify* 原为模块私有，现导出供 upload 使用，门面不转出。）
 */
import { supabase } from './client';

// ── P0-1 上传读回校验（纯比对 + 读回验证，防服务端静默吞写） ───────────────
//
// 背景：云端 op-stamp 守卫触发器在仲裁失败时 `RETURN NULL`（静默吞写、不报错），
// RLS 策略也可能静默丢行——upsert 返回成功不代表落盘。成功后按 id 读回关键列
// （last_op_seq/is_deleted/updated_at）逐行比对，不一致直接抛错，让调用方保留
// pending_upload 走重试，而不是清标志/刷 lastUploadTime 假装成功。
// 纯函数 compare* 可单测；verify* 做 IO 并在不一致时 throw。

export interface UploadReadbackExpect {
  id: string;
  updatedAt?: string;
  lastOp?: { d: string; s: number } | null;
  /** 期望的云端 is_deleted（省略 = false = 活跃）。覆盖模式上行墓碑时为 true。 */
  isDeleted?: boolean;
}

export interface UploadReadbackRow {
  id: string;
  updated_at: string;
  last_op_seq?: number | null;
  last_op_device?: string | null;
  is_deleted?: boolean | null;
}

export function compareUploadReadback(
  expect: UploadReadbackExpect[],
  actual: UploadReadbackRow[],
  opts: { checkStamp: boolean; checkTombstone: boolean }
): { ok: boolean; reason?: string } {
  if (expect.length === 0) return { ok: true };
  const byId = new Map(actual.map(r => [r.id, r]));
  for (const e of expect) {
    const row = byId.get(e.id);
    if (!row) {
      return { ok: false, reason: `云端缺失组 ${e.id}（疑似服务端守卫/RLS 静默吞写）` };
    }
    if (opts.checkTombstone && row.is_deleted !== undefined && row.is_deleted !== null) {
      const wantDeleted = e.isDeleted === true;
      if (row.is_deleted !== wantDeleted) {
        return {
          ok: false,
          reason: `组 ${e.id} 读回 is_deleted=${String(row.is_deleted)}，期望 ${String(wantDeleted)}（${
            wantDeleted ? '墓碑未落盘' : '复位失败'
          }）`,
        };
      }
    }
    if (opts.checkStamp && e.lastOp) {
      if ((row.last_op_seq ?? null) !== e.lastOp.s || (row.last_op_device ?? null) !== e.lastOp.d) {
        return { ok: false, reason: `组 ${e.id} 读回印记(${String(row.last_op_device)},${String(row.last_op_seq)})与本地(${e.lastOp.d},${e.lastOp.s})不一致` };
      }
    }
    if (e.updatedAt) {
      const a = Date.parse(row.updated_at);
      const b = Date.parse(e.updatedAt);
      const same = Number.isNaN(a) || Number.isNaN(b) ? row.updated_at === e.updatedAt : a === b;
      if (!same) {
        return { ok: false, reason: `组 ${e.id} 读回 updated_at=${row.updated_at} 与本地 ${e.updatedAt} 不一致` };
      }
    }
  }
  return { ok: true };
}

export async function verifyUploadReadback(
  expect: UploadReadbackExpect[],
  userId: string,
  opts: { checkStamp: boolean; checkTombstone: boolean }
): Promise<void> {
  if (expect.length === 0) return;
  const ids = expect.map(e => e.id);
  let cols = 'id, updated_at';
  if (opts.checkStamp) cols += ', last_op_device, last_op_seq';
  if (opts.checkTombstone) cols += ', is_deleted';
  const { data, error } = await supabase
    .from('tab_groups')
    .select(cols)
    .eq('user_id', userId)
    .in('id', ids);
  if (error) throw error;
  const cmp = compareUploadReadback(expect, ((data ?? []) as unknown) as UploadReadbackRow[], opts);
  if (!cmp.ok) throw new Error(`[upload-verify] ${cmp.reason}`);
  console.log(`[upload-verify] 读回校验通过（${expect.length} 组）`);
}

/** 软删读回：目标行必须存在且 is_deleted=true，否则删除意图没落盘 */
export function compareTombstoneReadback(
  ids: string[],
  rows: Array<{ id: string; is_deleted?: boolean | null }>
): { ok: boolean; reason?: string } {
  const byId = new Map(rows.map(r => [r.id, r]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      return { ok: false, reason: `云端缺失组 ${id}（软删目标行不存在，删除意图未落盘）` };
    }
    if (row.is_deleted !== true) {
      return { ok: false, reason: `组 ${id} 读回 is_deleted=${String(row.is_deleted)}，期望 true` };
    }
  }
  return { ok: true };
}

export async function verifyTombstoneReadback(ids: string[], userId: string): Promise<void> {
  if (ids.length === 0) return;
  const { data, error } = await supabase
    .from('tab_groups')
    .select('id, is_deleted')
    .eq('user_id', userId)
    .in('id', ids);
  if (error) throw error;
  const cmp = compareTombstoneReadback(ids, ((data ?? []) as unknown) as Array<{ id: string; is_deleted?: boolean | null }>);
  if (!cmp.ok) throw new Error(`[tombstone-verify] ${cmp.reason}`);
  console.log(`[tombstone-verify] 软删读回校验通过（${ids.length} 组）`);
}

/** 硬删读回：目标 id 必须全部消失，残留即抛错（P1-6 明确阻断而非静默） */
export function compareHardDeleteReadback(
  _ids: string[],
  remainingRows: Array<{ id: string }>
): { ok: boolean; reason?: string } {
  if (remainingRows.length === 0) return { ok: true };
  return {
    ok: false,
    reason: `云端仍残留 ${remainingRows.length} 行未删(${remainingRows.slice(0, 5).map(r => r.id).join(',')}${remainingRows.length > 5 ? '…' : ''})`,
  };
}
