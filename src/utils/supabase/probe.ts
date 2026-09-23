/**
 * S3 拆分 · probe：云端列探测（tombstone/opStamp）与轻量 digest 探活。
 * （原 src/utils/supabase.ts 对应节逐字搬运；缓存单例语义不变。）
 */
import { supabase, checkSupabaseConfig, isSupabaseConfigured } from './client';

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
        console.warn(
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
        console.warn('[tombstone] 列探测失败（非 PGRST204），本次按不支持处理，下次重探:', probe.error.message);
        return false;
      }
    } else {
      tombstoneSupportCache = true;
    }
    return tombstoneSupportCache;
  } catch (err) {
    // P1-5：异常同样不缓存，下次重探（与 supportsOpStamp 同策略）。
    console.warn('[tombstone] 列探测异常，本次按不支持处理，下次重探:', (err as Error).message);
    return false;
  }
}

let opStampSupportCache: boolean | null = null;

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
        console.warn(
          '[op-stamp] 云端 tab_groups 表缺少 last_op_seq 列，本次上传省略印记列（降级为旧行为）。\n' +
          '  请执行：pnpm supabase:migrate（或 Supabase SQL Editor 跑 supabase/migrations/20260910_fix_op_stamp_guard_strict_lt.sql）'
        );
        // 确定性的「列不存在」→ 缓存结果（本 SW 生命周期内无需重探）
        opStampSupportCache = false;
      } else {
        // 网络/权限等非确定性失败：**不缓存**。写死 false 会让一次网络抖动把整个 SW
        // 生命周期钉在降级模式（不上传印记、软删走不带 stamp 的分支），且不会自愈。
        console.warn('[op-stamp] 列探测失败（非 PGRST204），本次按不支持处理，下次重探:', probe.error.message);
        return false;
      }
    } else {
      opStampSupportCache = true;
    }
    return opStampSupportCache;
  } catch (err) {
    console.warn('[op-stamp] 列探测异常，本次按不支持处理，下次重探:', (err as Error).message);
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
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) {
    throw new Error(`获取会话失败: ${sessionError.message}`);
  }
  if (!sessionData.session) {
    throw new Error('用户未登录或会话已过期，请重新登录');
  }
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError) {
    throw new Error(`获取用户信息失败: ${userError.message}`);
  }
  if (!user?.id) {
    throw new Error('用户未登录');
  }
  const uid = user.id !== sessionData.session.user.id ? sessionData.session.user.id : user.id;

  const [stampSupported, tombstoneSupported] = await Promise.all([
    supportsOpStamp(),
    supportsCloudTombstone(),
  ]);
  let columns = 'id, updated_at, version';
  if (tombstoneSupported) columns += ', is_deleted';
  if (stampSupported) columns += ', last_op_device, last_op_seq';

  const query = async (cols: string) =>
    supabase.from('tab_groups').select(cols).eq('user_id', uid);

  const { data, error } = await query(columns);
  if (!error) return ((data ?? []) as unknown) as TabGroupDigest[];

  // 未迁移 schema（42703 / PGRST204）→ 回退最小列；其他错误直接抛出
  const msg = `${error.code ?? ''} ${error.message ?? ''}`;
  if (/42703|PGRST204|column/i.test(msg) && columns !== 'id, updated_at') {
    console.warn(`[digest] 指纹列查询失败，回退最小列重试: ${msg}`);
    const fallback = await query('id, updated_at');
    if (fallback.error) throw fallback.error;
    return ((fallback.data ?? []) as unknown) as TabGroupDigest[];
  }
  throw error;
}
