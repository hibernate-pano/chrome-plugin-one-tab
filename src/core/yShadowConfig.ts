/**
 * V2 影子双写 · 灰度与阈值配置（单源常量）。
 *
 * - SHADOW_WRITE_ENABLED：kill-switch。false = 整条影子链路零执行
 *  （mutationHandlers 甚至不调用 writer），主同步零影响。
 * - SHADOW_ROLLOUT_PERCENT：按 userId 哈希百分比切流（开发阶段默认 100 全量，快速验证影子数据质量；进生产前按需调低）。
 *   调整为 100 即全量；调整为 0 等价于软 kill（保留调用开销，可观测）。
 * - COMPACT_*：Y update 本地 KV 日志的 compact 阈值（>500 条或 >256KB 时
 *   置 needsSnapshot，由 V2 同步面做 snapshot 上传；影子本期只打标不上传）。
 * - BUNDLE_GZIP_BUDGET_KB：扩展构建 gzip 增量预算 120KB（见 scripts/report-y-bundle.mjs）。
 * - SHADOW_LOG_KEY / Y_UPDATE_LOG_KEY：KV 键（经 kvGet/kvSet 注入，与现有
 *   storage-kv 键表解耦，避免循环依赖）。
 * - Y_AUDIT_LOG_KEY / Y_AUDIT_DAILY_KEY：对账结果的逐条日志与按天聚合。
 *   **门禁判定读按天聚合**（逐条 FIFO 50 条的时间跨度可能远短于 7 天窗口，
 *   靠它无法证明「持续」——见 Y_AUDIT_DAILY_KEY 的说明）。
 */

/** kill-switch：false 即关闭整条影子链路（默认 ON=true，影子模式） */
export const SHADOW_WRITE_ENABLED = true;

/** 灰度百分比（0-100，开发阶段默认 100 全量）。按 userId 稳定哈希切流。 */
export const SHADOW_ROLLOUT_PERCENT = 100;

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

/** P1 对账采样率（%）：命中才读 Y 快照做一致性比对，默认 5% */
export const AUDIT_SAMPLE_PERCENT = 5;

/** 对账结果日志 KV 键（FIFO 上限 AUDIT_LOG_MAX，供调试视图读取） */
export const Y_AUDIT_LOG_KEY = 'y_audit_log';

/** 对账日志 FIFO 上限 */
export const AUDIT_LOG_MAX = 50;

/**
 * 对账「按天滚动聚合」KV 键（FIFO 上限 AUDIT_DAILY_MAX 天）。
 *
 * 【为什么必须有它，而不是直接读 Y_AUDIT_LOG_KEY 判定门禁】
 * 门禁要求「7 天持续」，但 Y_AUDIT_LOG_KEY 只留最近 50 条样本。采样率 5% 时，
 * 50 条对一个正常使用的用户可能只覆盖几小时——**日志窗口比门禁窗口短**，
 * 于是「7 天持续达标」这件事在原日志里根本无法被证明，只能永远显示「数据不足」。
 * 逐条日志仍保留（排障要看具体某次 mismatch 的形状），但门禁判定改读按天聚合：
 * 每天一行（样本数 / 最差 mismatchRate / 超阈样本数），30 天容量，
 * 早年样本被 FIFO 淘汰也不会把「那一天达标了」这个事实一起丢掉。
 */
export const Y_AUDIT_DAILY_KEY = 'y_audit_daily';

/** 按天聚合的保留天数（≥ 门禁窗口，留出余量以便看趋势） */
export const AUDIT_DAILY_MAX = 30;

/**
 * P1 门禁阈值：mismatchRate 上限 0.1%（见 docs/v2-plan.md 的 P1 验收口径）。
 *
 * 对齐的是「影子物化视图能否替代 blob 作为读路径」这一判断——超过阈值说明
 * Y 侧与本地真相已经开始分叉，此时切读会把分叉暴露给用户。
 */
export const GATE_MISMATCH_RATE_MAX = 0.001;

/** P1 门禁窗口：连续达标天数（见 docs/v2-plan.md 的 P1 验收口径）。 */
export const GATE_WINDOW_DAYS = 7;

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
