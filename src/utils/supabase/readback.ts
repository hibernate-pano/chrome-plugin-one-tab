/**
 * S3 拆分 · readback：上传/墓碑/硬删读回校验（纯比对 compare* + IO 验证 verify*）。
 * （原 src/utils/supabase.ts 对应节逐字搬运；verify* 原为模块私有，现导出供 upload 使用，门面不转出。）
 */
import { supabase } from './client';
import { compareStamps, EMPTY_STAMP } from '@/core/opStamp';
import { logInfo } from '../log';
import { chunkIds } from './idBatches';

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
  /**
   * 本次上行的 version。用于区分两种"没写上"：云端 version 更高 = 对端更新、
   * 本次写入输掉了竞争（OpStamp 合并本来就让先到的写输，不是故障）；云端
   * version 不更高 = 真被守卫静默吞写，必须报错。
   */
  version?: number | null;
}

export interface UploadReadbackRow {
  id: string;
  updated_at: string;
  last_op_seq?: number | null;
  last_op_device?: string | null;
  is_deleted?: boolean | null;
  version?: number | null;
}

/**
 * 本次写入是否被更新的一侧合法取代（而非被守卫静默吞写）。
 *
 * 生产库有遗留的 version BEFORE UPDATE 守卫：`NEW.version < OLD.version`
 * 即 RETURN NULL 整行丢弃（HTTP 200、无 error）。设备离线久了本地 version
 * 落后云端时，它的上传会被这条守卫静默吞掉——若读回校验只认"不一致即失败"，
 * 整台上传就会永久失败；而上传失败又会跳过下载（避免用旧云端覆盖本地），
 * 该设备就此既不能上传也不能下载，只能靠连续编辑把 version 一格格追平。
 *
 * 云端 version 更高说明对端确实更新、这次写入按设计输掉，标记为"已被取代"
 * 让上传继续走完；数据没有丢（云端存着更新的那份），本地下次下载会合并回来。
 */
export function isSupersededByCloud(expect: UploadReadbackExpect, row: UploadReadbackRow): boolean {
  if (expect.version == null || row.version == null) return false;
  return row.version > expect.version;
}

/**
 * 本次「写活跃」是否输给了**更新的云端墓碑**（收敛，不是故障）。
 *
 * 背景：合并模式上传时每个活跃组都以 is_deleted=false 写出。若同一行的云端
 * 版本是**另一台设备**写的墓碑、且它的 last_op_seq 更大，那么按全序
 * （opStamp.compareStamps）本地本来就该认输——mergeOpStamped 对
 * 「云端墓碑 vs 本地活跃」正是这条判据：云端印记大 → 本地组服从删除。
 * 但上传层原本不知道这件事：它拿更旧的 stamp 去 upsert，服务端
 * guard_tab_group_op_stamp 判 `NEW.last_op_seq < OLD.last_op_seq` → RETURN NULL
 * 整行静默吞写（HTTP 200、无 error），紧接着 is_deleted 比对抛错 →
 * upload 失败 → pending_upload 永不清 → downloadAndMerge 永远撞 upload_first
 * → 该设备既传不上也下不来（后台闹钟每 60s 重试一次）。
 *
 * 口径与两处保持一致，缺一不可：
 *   1. 只认「本次要写活跃、读回是墓碑」这一个方向；反方向（要写墓碑读回活跃）
 *      永远是「墓碑未落盘」的故障，不能放过。
 *   2. 云端墓碑**必须带印记**才算数：两侧任一无印记时服务端守卫是放行的
 *      （守卫第 2 条「NULL 不是最小印记，是不知道」），那种情况下读回不一致
 *      是真被吞写，必须报错。
 * 上传侧已在 upsert **之前**用同一判据预检（见 upload.ts 的预检）把这类组
 * 剔出本次写入；本函数是那条预检与 upsert 之间的竞态兜底。
 */
export function isConcededToCloudTombstone(
  expect: UploadReadbackExpect,
  row: UploadReadbackRow
): boolean {
  if (expect.isDeleted === true) return false;
  if (row.is_deleted !== true) return false;
  if (typeof row.last_op_seq !== 'number' || !row.last_op_device) return false;
  return compareStamps(
    { d: String(row.last_op_device), s: row.last_op_seq },
    expect.lastOp ?? EMPTY_STAMP
  ) > 0;
}

export function compareUploadReadback(
  expect: UploadReadbackExpect[],
  actual: UploadReadbackRow[],
  opts: { checkStamp: boolean; checkTombstone: boolean }
): { ok: boolean; reason?: string; superseded?: string[]; conceded?: string[] } {
  if (expect.length === 0) return { ok: true };
  const byId = new Map(actual.map(r => [r.id, r]));
  // 被更新一侧合法取代的组：不算失败，但要记下来给调用方看（见 isSupersededByCloud）
  const superseded: string[] = [];
  // 输给更新的云端墓碑的组：同属收敛（见 isConcededToCloudTombstone）
  const conceded: string[] = [];
  for (const e of expect) {
    const row = byId.get(e.id);
    if (!row) {
      return { ok: false, reason: `云端缺失组 ${e.id}（疑似服务端守卫/RLS 静默吞写）` };
    }
    if (isSupersededByCloud(e, row)) {
      superseded.push(e.id);
      continue;
    }
    if (opts.checkTombstone && isConcededToCloudTombstone(e, row)) {
      conceded.push(e.id);
      continue;
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
  if (superseded.length === 0 && conceded.length === 0) return { ok: true };
  return {
    ok: true,
    ...(superseded.length > 0 ? { superseded } : {}),
    ...(conceded.length > 0 ? { conceded } : {}),
  };
}

export async function verifyUploadReadback(
  expect: UploadReadbackExpect[],
  userId: string,
  opts: { checkStamp: boolean; checkTombstone: boolean }
): Promise<void> {
  if (expect.length === 0) return;
  const ids = expect.map(e => e.id);
  // version 必须取：没有它就无法区分"被守卫静默吞写"与"被更新一侧合法取代"，
  // 后者若也判失败会让整台设备的上传永久卡死（连带下载被跳过）。
  let cols = 'id, updated_at, version';
  if (opts.checkStamp) cols += ', last_op_device, last_op_seq';
  if (opts.checkTombstone) cols += ', is_deleted';
  // 分批读：ids 可能上千，整串 .in() 会让 URL 超过网关上限（400 纯文本，无 code）。
  const rows: UploadReadbackRow[] = [];
  for (const batch of chunkIds(ids)) {
    const { data, error } = await supabase
      .from('tab_groups')
      .select(cols)
      .eq('user_id', userId)
      .in('id', batch);
    if (error) throw error;
    rows.push(...((data ?? []) as unknown as UploadReadbackRow[]));
  }
  const cmp = compareUploadReadback(expect, rows, opts);
  if (!cmp.ok) throw new Error(`[upload-verify] ${cmp.reason}`);
  if (cmp.superseded?.length) {
    logInfo(
      `[upload-verify] ${cmp.superseded.length} 个组被更新一侧合法取代（云端 version 更高），` +
        `按设计让先到的写入输，不计为失败：${cmp.superseded.join(', ')}`
    );
  }
  if (cmp.conceded?.length) {
    logInfo(
      `[upload-verify] ${cmp.conceded.length} 个组输给了更新的云端墓碑（云端 last_op_seq 更大），` +
        `按合并语义让本地认输，不计为失败（本地副本由下次下载合并物理移除）：${cmp.conceded.join(', ')}`
    );
  }
  logInfo(`[upload-verify] 读回校验通过（${expect.length} 组）`);
}

/**
 * 软删读回：存在的行必须 is_deleted=true，否则删除意图没落盘。
 *
 * 【缺失行怎么办是调用方的语义决定】云端没有这一行 = 无行可复活（本地新建从未上过云
 * 就被删、或已被他端物理删），删除意图事实上已达成；但默认仍按缺失报错——因为 stamp
 * 分支拿到的 touchedIds 本来就不含云端没有的 id，读回再缺行只能说明出了别的事，
 * 保守报错是对的。只有 plain 模式（没有「先读现有行」这步、拿不到 touchedIds，只能
 * 拿全量队列校验）才显式传 missingAsAchieved，见 upload.ts 的 plain 分支。
 */
export function compareTombstoneReadback(
  ids: string[],
  rows: Array<{ id: string; is_deleted?: boolean | null }>,
  opts?: { missingAsAchieved?: boolean }
): { ok: boolean; reason?: string; missing?: string[] } {
  const byId = new Map(rows.map(r => [r.id, r]));
  const missing: string[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      missing.push(id);
      continue;
    }
    if (row.is_deleted !== true) {
      return { ok: false, reason: `组 ${id} 读回 is_deleted=${String(row.is_deleted)}，期望 true` };
    }
  }
  if (missing.length > 0 && !opts?.missingAsAchieved) {
    return { ok: false, reason: `云端缺失组 ${missing[0]}（软删目标行不存在，删除意图未落盘）` };
  }
  return { ok: true, ...(missing.length > 0 ? { missing } : {}) };
}

export async function verifyTombstoneReadback(
  ids: string[],
  userId: string,
  opts?: { missingAsAchieved?: boolean }
): Promise<void> {
  if (ids.length === 0) return;
  // 分批读：见 idBatches.ts（删除队列可能上千，整串 .in() 会 400）。
  const rows: Array<{ id: string; is_deleted?: boolean | null }> = [];
  for (const batch of chunkIds(ids)) {
    const { data, error } = await supabase
      .from('tab_groups')
      .select('id, is_deleted')
      .eq('user_id', userId)
      .in('id', batch);
    if (error) throw error;
    rows.push(...((data ?? []) as unknown as Array<{ id: string; is_deleted?: boolean | null }>));
  }
  const cmp = compareTombstoneReadback(ids, rows, opts);
  if (!cmp.ok) throw new Error(`[tombstone-verify] ${cmp.reason}`);
  if (cmp.missing?.length) {
    logInfo(
      `[tombstone-verify] ${cmp.missing.length} 个 id 云端无行（从未上过云即被删 / 已被他端物理删），` +
      '无行可复活，视为删除意图已达成'
    );
  }
  logInfo(`[tombstone-verify] 软删读回校验通过（${ids.length} 组）`);
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
