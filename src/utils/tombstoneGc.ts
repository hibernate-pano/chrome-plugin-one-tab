/**
 * Tombstone GC — 客户端协作式清理过期的软删标记
 *
 * 背景：
 * v1.12.0 引入 pending_delete 列作为跨设备删除传播的 tombstone。
 * 物理删除会导致其他设备收不到删除信号，所以采用软删。
 *
 * 副作用：tombstone 行永远不会消失，会在云端累积。
 * 10 万次删除后，云端行数会膨胀，下载时间变长、Supabase 成本上升。
 *
 * 解决策略（客户端协作式 GC）：
 * - 每次 upload() 后，fire-and-forget 异步清理
 * - 仅清理自己设备产生的 tombstone（device_id = 当前设备）
 * - 仅清理超过 30 天的（确保所有设备已收到信号）
 * - 失败不阻塞主流程
 *
 * 为什么不用 Supabase scheduled function：
 * - RLS 不允许普通客户端写跨 user 的 delete
 * - service_role key 不能进客户端扩展 bundle
 *
 * 安全：
 * - .delete() 仅作用于 pending_delete=true 的行（不会误删活跃数据）
 * - .lt('updated_at', cutoff) 保证 tombstone 已跨设备传播完毕
 * - .eq('device_id', deviceId) 避免误删其他设备的 tombstone
 * - try/catch 包住整个调用，不影响主流程
 */

import { supabase } from './supabase';
import { getDeviceId } from './supabase';
import { computeCutoff } from './tombstoneGcUtil';

export interface GcResult {
  /** 扫描到的过期 tombstone 数（== deleted，因为我们是 delete 立即返回 deleted 数） */
  scanned: number;
  /** 实际删除的 tombstone 数 */
  deleted: number;
  /** 错误数（0 = 成功，1 = 失败） */
  errors: number;
}

export interface CleanupOptions {
  /** 多少天前的 tombstone 视为可清理（默认 30 天） */
  olderThanDays?: number;
}

/**
 * 清理云端过期的 tombstone 行
 *
 * @returns { scanned, deleted, errors }
 */
export async function cleanupCloudTombstones(
  options: CleanupOptions = {}
): Promise<GcResult> {
  const olderThanDays = options.olderThanDays ?? 30;

  try {
    // 1. 检查登录
    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData?.session) {
      // 未登录不报错 —— 只是无事可做
      return { scanned: 0, deleted: 0, errors: 0 };
    }

    const userId = sessionData.session.user.id;
    const deviceId = await getDeviceId();
    const cutoff = computeCutoff(olderThanDays);

    // 2. 删除自己设备的、超过 N 天的 tombstone
    const { data, error } = await supabase
      .from('tab_groups')
      .delete()
      .eq('user_id', userId)
      .eq('device_id', deviceId)
      .eq('pending_delete', true)
      .lt('updated_at', cutoff)
      .select('id');

    if (error) {
      console.warn('[tombstoneGc] cleanup failed:', error.message);
      return { scanned: 0, deleted: 0, errors: 1 };
    }

    const deleted = data?.length ?? 0;
    if (deleted > 0) {
      console.log(
        `[tombstoneGc] cleaned ${deleted} expired tombstone(s) ` +
          `(older than ${olderThanDays} days, device=${deviceId.slice(0, 8)}...)`
      );
    }

    return { scanned: deleted, deleted, errors: 0 };
  } catch (err) {
    // 任何未预期的异常也不抛出 —— GC 是 best-effort
    console.warn('[tombstoneGc] unexpected error:', err);
    return { scanned: 0, deleted: 0, errors: 1 };
  }
}
