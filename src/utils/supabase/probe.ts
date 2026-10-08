/**
 * S3 拆分 · probe：云端列探测（tombstone/opStamp）与轻量 digest 探活。
 * （原 src/utils/supabase.ts 对应节逐字搬运；缓存单例语义不变。）
 */
import { supabase, checkSupabaseConfig, isSupabaseConfigured } from './client';
import { requireSessionUserId } from './session';
import { logWarn } from '../log';

// ── 云端 tombstone（软删）双轨支持 ────────────────────────────────
// 背景：Web 端删除需要跨端一致（扩展端上传不能"复活"已删的云端行）。
// 正确做法是云端 tab_groups 增加 is_deleted 列（软删墓碑），但需要
// Supabase 控制台执行 migration（anon key 无 DDL 权限）：
//   ALTER TABLE tab_groups ADD COLUMN is_deleted boolean NOT NULL DEFAULT false;
// 代码侧双轨：探测到列 → 走 tombstone；未探测到 → 回退硬删并给出提示。

let tombstoneSupportCache: boolean | null = null;

/**
 * 探测云端 tab_groups 表是否已有 is_deleted 列（结果缓存）。
 * 探测方式：select 该列 limit 1，列不存在时 Supabase 会返回 PGRST204 错误。
 */
export async function supportsCloudTombstone(): Promise<boolean> {
  if (tombstoneSupportCache !== null) return tombstoneSupportCache;
  if (!isSupabaseConfigured()) {
    tombstoneSupportCache = false;
    return false;
  }
  try {
    const probe = await supabase.from('tab_groups').select('is_deleted').limit(1);
    if (probe.error) {
      if (probe.error.code === 'PGRST204' || /is_deleted/i.test(probe.error.message)) {
        logWarn(
          '[tombstone] 云端 tab_groups 表缺少 is_deleted 列，降级为硬删。\n' +
          '  如需跨端软删一致性，请在 Supabase 控制台 SQL Editor 执行：\n' +
          '  ALTER TABLE tab_groups ADD COLUMN is_deleted boolean NOT NULL DEFAULT false;'
        );
        // 确定性的「列不存在」→ 缓存结果（本 SW 生命周期内无需重探）
        tombstoneSupportCache = false;
      } else {
        // P1-5：网络/权限等非确定性失败：**不缓存**，与 supportsOpStamp 同策略。
        // 写死 false 会让一次网络抖动把整个 SW 生命周期钉在降级模式（硬删分支），
        // 且不会自愈——本次按不支持处理，下次重探。
        logWarn('[tombstone] 列探测失败（非 PGRST204），本次按不支持处理，下次重探:', probe.error.message);
        return false;
      }
    } else {
      tombstoneSupportCache = true;
    }
    return tombstoneSupportCache;
  } catch (err) {
    // P1-5：异常同样不缓存，下次重探（与 supportsOpStamp 同策略）。
    logWarn('[tombstone] 列探测异常，本次按不支持处理，下次重探:', (err as Error).message);
    return false;
  }
}

let deletedAtSupportCache: boolean | null = null;

/**
 * D3：探测云端 tab_groups 表是否已有 deleted_at 列（结果缓存）。
 * 口径与 supportsCloudTombstone/supportsOpStamp 完全一致：
 * 确定性缺列（PGRST204）→ 缓存 false；网络抖动 → 不缓存下次重探。
 * 缺列时调用方省略 deleted_at（墓碑过期回退 updatedAt，见 tombstone.ts）。
 */
export async function supportsDeletedAt(): Promise<boolean> {
  if (deletedAtSupportCache !== null) return deletedAtSupportCache;
  if (!isSupabaseConfigured()) {
    deletedAtSupportCache = false;
    return false;
  }
  try {
    const probe = await supabase.from('tab_groups').select('deleted_at').limit(1);
    if (probe.error) {
      if (probe.error.code === 'PGRST204' || /deleted_at/i.test(probe.error.message)) {
        logWarn(
          '[tombstone] 云端 tab_groups 表缺少 deleted_at 列，墓碑过期回退 updatedAt。\n' +
          '  请执行：pnpm supabase:migrate（见 supabase/migrations/*tombstone_expiry*.sql）'
        );
        deletedAtSupportCache = false;
      } else {
        logWarn('[tombstone] deleted_at 列探测失败（非 PGRST204），本次按不支持处理，下次重探:', probe.error.message);
        return false;
      }
    } else {
      deletedAtSupportCache = true;
    }
    return deletedAtSupportCache;
  } catch (err) {
    logWarn('[tombstone] deleted_at 列探测异常，本次按不支持处理，下次重探:', (err as Error).message);
    return false;
  }
}

let opStampSupportCache: boolean | null = null;

/**
 * 仅供单元测试：清空列探测缓存。
 * 探测结果在进程内是单例缓存（同一 SW 生命周期只探一次），而测试要在同一个
 * 进程里分别跑 stamp / plain / hard-delete 三种列形态，必须能重置。
 * 生产代码不得调用。
 */
export function __resetCloudColumnProbeCacheForTests(): void {
  tombstoneSupportCache = null;
  opStampSupportCache = null;
  deletedAtSupportCache = null;
}

/**
 * 探测云端 tab_groups 表是否已有 last_op_seq 列（结果缓存）。
 *
 * 为什么必须探测：客户端先于 SQL 迁移发布时，上传 payload 里带上不存在的列会让
 * PostgREST 报 42703（column does not exist）——整个 upsert 失败，用户数据全部卡在本地。
 * 探测失败就整列省略，退回到「无印记」的旧上传行为，等迁移跑完自动启用。
 */
export async function supportsOpStamp(): Promise<boolean> {
  if (opStampSupportCache !== null) return opStampSupportCache;
  if (!isSupabaseConfigured()) {
    opStampSupportCache = false;
    return false;
  }
  try {
    const probe = await supabase.from('tab_groups').select('last_op_seq').limit(1);
    if (probe.error) {
      if (probe.error.code === 'PGRST204' || /last_op_seq/i.test(probe.error.message)) {
        logWarn(
          '[op-stamp] 云端 tab_groups 表缺少 last_op_seq 列，本次上传省略印记列（降级为旧行为）。\n' +
          '  请执行：pnpm supabase:migrate（或 Supabase SQL Editor 跑 supabase/migrations/20260910_fix_op_stamp_guard_strict_lt.sql）'
        );
        // 确定性的「列不存在」→ 缓存结果（本 SW 生命周期内无需重探）
        opStampSupportCache = false;
      } else {
        // 网络/权限等非确定性失败：**不缓存**。写死 false 会让一次网络抖动把整个 SW
        // 生命周期钉在降级模式（不上传印记、软删走不带 stamp 的分支），且不会自愈。
        logWarn('[op-stamp] 列探测失败（非 PGRST204），本次按不支持处理，下次重探:', probe.error.message);
        return false;
      }
    } else {
      opStampSupportCache = true;
    }
    return opStampSupportCache;
  } catch (err) {
    logWarn('[op-stamp] 列探测异常，本次按不支持处理，下次重探:', (err as Error).message);
    return false;
  }
}
// ── 轻量变更探活（降 egress） ──────────────────────────────────────────
//
// 背景：后台每 60s 一次 downloadAndMerge 轮询，绝大多数时候云端无变化，
// 却每次都 select * 全量拉取（含 tabs_data / compressed_data 大 JSONB）。
// fetchTabGroupsDigest 只取 (id, updated_at, version, is_deleted[, 印记列])
// 指纹列做变更判断，无变更时 SyncEngine 直接返回本地快照、不走全量下载。
// 列集合按 supportsOpStamp / supportsCloudTombstone 探测结果组装：
// 未迁移的云端带上不存在的列会报 42703 / PGRST204，失败时回退最小列。

/**
 * digest 分页的每页行数。
 *
 * 必须严格小于网关 db-max-rows（PostgREST 默认 1000）：页内行数一旦触及上限，
 * 网关会**静默截断**响应（不报错），单页内部没有短页信号可用 —— 这是分页
 * 本身防不住的洞，由 queryAll 里的 count 交叉校验兜底。500 留一倍余量。
 */
export const DIGEST_PAGE_SIZE = 500;

export interface TabGroupDigest {
  id: string;
  updated_at: string;
  version?: number | null;
  is_deleted?: boolean | null;
  last_op_device?: string | null;
  last_op_seq?: number | null;
}

/**
 * 轻量探活：只拉用户行的指纹列，不含 tabs_data 大字段。
 * 与 downloadTabGroups 相同的鉴权前置；失败时抛错，调用方 fail-open 走全量。
 */
export async function fetchTabGroupsDigest(): Promise<TabGroupDigest[]> {
  checkSupabaseConfig();
  const uid = await requireSessionUserId();

  const [stampSupported, tombstoneSupported] = await Promise.all([
    supportsOpStamp(),
    supportsCloudTombstone(),
  ]);
  let columns = 'id, updated_at, version';
  if (tombstoneSupported) columns += ', is_deleted';
  if (stampSupported) columns += ', last_op_device, last_op_seq';

  /**
   * 按固定顺序分页拉取全部指纹行（主路径与 42703 回退路径共用）。
   *
   * 【为什么要分页】此前是单次无序 select：行数超过网关 db-max-rows（默认
   * 1000）时响应被**静默截断**（不报错）。截断后的 digest 若恰好与本地快照
   * 一致，hasRemoteChanges（syncDecision.ts）返回 false → SyncEngine 判
   * up_to_date，本该修复差异的那次全量下载永远不会发生 —— 探活必须自己
   * 先保证完整性。
   *
   * 顺序固定为 id ASC（唯一键 → 全序），offset 窗口才能跨请求稳定拼接。
   *
   * 【为什么要 count 交叉校验】首个请求带 { count: 'exact' }：supabase-js
   * 会在**同一个请求**里经 PostgREST 的 Content-Range 带回总行数（零额外
   * 请求）。分页结束后若累计行数 ≠ 总行数，说明有响应仍被截断（或分页期间
   * 云端行数变化）——此时 digest 不可信，必须 throw。方向是安全的：
   * fetchTabGroupsDigest 的调用契约就是「失败 → fail-open 走全量下载」，
   * 宁可多一次全量，也绝不交出一份可能漏行的 digest 让引擎误判 up_to_date。
   */
  const queryAll = async (cols: string): Promise<TabGroupDigest[]> => {
    const out: TabGroupDigest[] = [];
    let count: number | null = null;
    for (let from = 0; ; from += DIGEST_PAGE_SIZE) {
      const isFirstPage = from === 0;
      // 首个请求带 count=exact 拿总行数；后续页不再要（同一份数据里 count
      // 若中途变化，短页推断与最终交叉校验都无法自洽，只能整体重试）。
      const req = supabase
        .from('tab_groups')
        .select(cols, isFirstPage ? { count: 'exact' } : {})
        .eq('user_id', uid)
        .order('id', { ascending: true })
        .range(from, from + DIGEST_PAGE_SIZE - 1);
      const { data, error, count: c } = await req;
      if (error) throw error;
      if (isFirstPage) count = c ?? null;
      out.push(...((data ?? []) as unknown as TabGroupDigest[]));
      if (!data || data.length < DIGEST_PAGE_SIZE) break; // 短页 = 已取完
    }
    if (count !== null && out.length !== count) {
      throw new Error(
        `[digest] 分页结果不完整：累计 ${out.length} 行 != 云端总行数 ${count}，` +
          `疑似被网关 db-max-rows 截断（或分页期间行数变化）。fail-open：抛错走全量下载。`
      );
    }
    return out;
  };

  // 未迁移 schema（42703 / PGRST204）→ 回退最小列整段重拉；其他错误直接抛出。
  // 回退与主路径共用 queryAll：同样的排序、分页与 count 截断检测，两条路径
  // 都不会被 db-max-rows 静默截断。
  try {
    return await queryAll(columns);
  } catch (error: any) {
    const msg = `${error?.code ?? ''} ${error?.message ?? ''}`;
    if (/42703|PGRST204|column/i.test(msg) && columns !== 'id, updated_at') {
      logWarn(`[digest] 指纹列查询失败，回退最小列重试: ${msg}`);
      return await queryAll('id, updated_at');
    }
    throw error;
  }
}
