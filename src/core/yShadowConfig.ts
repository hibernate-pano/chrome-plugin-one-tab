/**
 * V2 影子双写 · 灰度与阈值配置（单源常量）。
 *
 * - SHADOW_WRITE_ENABLED：kill-switch。false = 整条影子链路零执行
 *  （mutationHandlers 甚至不调用 writer），主同步零影响。
 * - SHADOW_ROLLOUT_PERCENT：按 userId 哈希百分比切流（默认 10）。
 *   调整为 100 即全量；调整为 0 等价于软 kill（保留调用开销，可观测）。
 * - COMPACT_*：Y update 本地 KV 日志的 compact 阈值（>500 条或 >256KB 时
 *   置 needsSnapshot，由 V2 同步面做 snapshot 上传；影子本期只打标不上传）。
 * - BUNDLE_GZIP_BUDGET_KB：扩展构建 gzip 增量预算 120KB（见 scripts/report-y-bundle.mjs）。
 * - SHADOW_LOG_KEY / Y_UPDATE_LOG_KEY：KV 键（经 kvGet/kvSet 注入，与现有
 *   storage-kv 键表解耦，避免循环依赖）。
 */

/** kill-switch：false 即关闭整条影子链路（默认 ON=true，影子模式） */
export const SHADOW_WRITE_ENABLED = true;

/** 灰度百分比（0-100，默认 10）。按 userId 稳定哈希切流。 */
export const SHADOW_ROLLOUT_PERCENT = 10;

/** compact 阈值：本地 Y update 日志条数 */
export const COMPACT_LOG_COUNT_THRESHOLD = 500;

/** compact 阈值：本地 Y update 日志字节数（256KB） */
export const COMPACT_LOG_BYTES_THRESHOLD = 256 * 1024;

/** 扩展构建 gzip 增量预算（KB） */
export const BUNDLE_GZIP_BUDGET_KB = 120;

/** 影子执行结果日志 KV 键（FIFO 上限 200，供调试视图读取；不消耗 seq） */
export const SHADOW_LOG_KEY = 'y_shadow_log';

/** Y update 本地日志 KV 键（FIFO 上限见 COMPACT_LOG_COUNT_THRESHOLD） */
export const Y_UPDATE_LOG_KEY = 'y_update_log';

/** 影子日志 FIFO 上限 */
export const SHADOW_LOG_MAX = 200;

function hashUserId(userId: string): number {
  // FNV-1a 32bit：稳定、无依赖、与服务端切流可复刻
  let h = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 灰度判定：userId 哈希 % 100 < percent。空串/缺失按 'local' 兜底。 */
export function isShadowSampled(userId: string | null | undefined, percent = SHADOW_ROLLOUT_PERCENT): boolean {
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  const id = userId && userId.length > 0 ? userId : 'local';
  return hashUserId(id) % 100 < percent;
}
