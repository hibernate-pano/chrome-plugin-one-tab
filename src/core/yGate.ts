/**
 * V3 门禁判定（docs/v2-plan.md 的 P1 验收：对账差异率 < 0.1% 持续 7 天）。
 *
 * 【这个文件存在的理由：把「门禁没通过」和「门禁没数据」分开】
 * 采样对账一直在跑，结果写进 y_audit_log / y_audit_daily，但在本文件之前
 * **没有任何读取方**——门禁的信号被采集了，却没有人能看见，于是 V3 永远停在
 * 「待决策」。而一个只会输出 true/false 的门禁在这里尤其危险：
 * 「没有样本」与「样本全部达标」在布尔值上是同一个 false/true，
 * 决策者会把「没测过」读成「测过且没问题」。所以判定结果是四态而不是布尔：
 *
 *   no_data               → 没样本，什么都没测（绝不等价于通过）
 *   insufficient_coverage → 有样本，但 7 天窗口里有整天没覆盖，无法声称「持续」
 *   fail                  → 已知有样本超阈（不需要覆盖完整就能判负）
 *   pass                  → 窗口内每天都有样本，且无一超阈
 *
 * 【为什么负判定优先于覆盖不足】只要有任意样本超阈，门禁就已经失败了，
 * 此时再说「数据不足」等于用「还没测完」掩盖一个已知事实。判定顺序因此是
 * no_data → fail → insufficient_coverage → pass。
 *
 * 本文件是两个纯函数 + 三张封闭词表：无 IO、不读全局时间、无副作用，
 * 因此「7 天窗口怎么算」「跨天怎么合并」这类真正容易错的逻辑可以直接单测，
 * 不需要 IndexedDB 或 Y.Doc。
 */
import type { AuditResult } from '@/core/yAudit';
import { AUDIT_DAILY_MAX, GATE_MISMATCH_RATE_MAX, GATE_WINDOW_DAYS } from '@/core/yShadowConfig';

// ── 封闭词表（输出的动态键只可能来自这里，见 utils/diagnostics.ts 的白名单说明）──

/** 影子写入结果种类，来源 yShadow.ts 的 ShadowOutcome。 */
export const SHADOW_OUTCOMES = ['ok', 'killed', 'rollout', 'empty', 'error'] as const;
export type ShadowOutcomeKind = (typeof SHADOW_OUTCOMES)[number];

/** 对账差异的比对范围，来源 yAudit.ts 的 AuditMismatch['scope']。 */
export const MISMATCH_SCOPES = ['group', 'tab', 'order'] as const;
export type MismatchScope = (typeof MISMATCH_SCOPES)[number];

/**
 * 对账差异的字段名，来源 yAudit.ts 里 push(...field...) 的全部字面量。
 *
 * 这张表是**脱敏的关键**：一条 mismatch 的 ySide/localSide 装着 url/title/name
 * 的真实值（就是用户的浏览历史），而 field 只说明「哪个字段对不上」。
 * 只让 field 过关、values 一律不进输出，诊断文件才能既说清问题又不泄露内容。
 * 词表外一律丢弃并记账——存储里不应该有别的值，出现即说明上游改了协议。
 */
export const MISMATCH_FIELDS = [
  'missing_in_y',
  'missing_local',
  'name',
  'updatedAt',
  'isLocked',
  'is_deleted',
  'deletedAt',
  'url',
  'title',
  'lastAccessed',
  'order',
  'audit_crashed',
] as const;
export type MismatchField = (typeof MISMATCH_FIELDS)[number];

const SHADOW_OUTCOME_SET = new Set<string>(SHADOW_OUTCOMES);
const MISMATCH_SCOPE_SET = new Set<string>(MISMATCH_SCOPES);
const MISMATCH_FIELD_SET = new Set<string>(MISMATCH_FIELDS);

export function isShadowOutcomeKind(v: unknown): v is ShadowOutcomeKind {
  return typeof v === 'string' && SHADOW_OUTCOME_SET.has(v);
}

export function isMismatchScope(v: unknown): v is MismatchScope {
  return typeof v === 'string' && MISMATCH_SCOPE_SET.has(v);
}

export function isMismatchField(v: unknown): v is MismatchField {
  return typeof v === 'string' && MISMATCH_FIELD_SET.has(v);
}

// ── 按天滚动聚合 ────────────────────────────────────────────────────────

/**
 * 一天的聚合行。**只有数字与日期**：没有任何 groupId/tabId/字段值，
 * 因此它可以安全地进诊断文件，也可以被 UI 直接渲染。
 */
export interface AuditDailyBucket {
  /** UTC 日期，YYYY-MM-DD。 */
  date: string;
  /** 当天样本数。 */
  samples: number;
  /** 当天 mismatchRate ≥ 阈值的样本数（>0 即当天不达标）。 */
  overThresholdSamples: number;
  /** 当天最差（最大）mismatchRate。 */
  worstMismatchRate: number;
  /** 当天各样本 checkedGroups 的累计值（规模背景，用于读懂 rate 的分母）。 */
  checkedGroups: number;
  /** 当天各样本 checkedTabs 的累计值。 */
  checkedTabs: number;
}

/** ISO 时间 → UTC 日期串。不可解析返回 null（不猜日期）。 */
function utcDayOf(ts: unknown): string | null {
  if (typeof ts !== 'string' || ts === '') return null;
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** 把任意存储内容收敛成合法 buckets：畸形行丢弃（不猜、不修）。按 date 升序。 */
export function sanitizeDailyBuckets(raw: unknown): AuditDailyBucket[] {
  if (!Array.isArray(raw)) return [];
  const out: AuditDailyBucket[] = [];
  for (const item of raw) {
    const b = item as Partial<AuditDailyBucket> | null;
    if (!b || typeof b !== 'object') continue;
    const date = utcDayOf(`${b.date}T00:00:00.000Z`);
    if (date === null || date !== b.date) continue;
    const samples = finiteOrNull(b.samples);
    const over = finiteOrNull(b.overThresholdSamples);
    const worst = finiteOrNull(b.worstMismatchRate);
    if (samples === null || over === null || worst === null) continue;
    out.push({
      date,
      samples,
      // 超阈样本数不可能多于样本数：超出即存储被写坏，钳到 samples（而不是丢弃整行，
      // 那会让一天凭空消失，反而更像「覆盖不足」）
      overThresholdSamples: Math.min(over, samples),
      worstMismatchRate: worst,
      checkedGroups: finiteOrNull(b.checkedGroups) ?? 0,
      checkedTabs: finiteOrNull(b.checkedTabs) ?? 0,
    });
  }
  // 同一天出现多行（并发写/迁移残留）→ 合并，而不是让后一行覆盖前一行
  const merged = new Map<string, AuditDailyBucket>();
  for (const b of out) {
    const cur = merged.get(b.date);
    if (!cur) {
      merged.set(b.date, { ...b });
      continue;
    }
    cur.samples += b.samples;
    cur.overThresholdSamples += b.overThresholdSamples;
    cur.worstMismatchRate = Math.max(cur.worstMismatchRate, b.worstMismatchRate);
    cur.checkedGroups += b.checkedGroups;
    cur.checkedTabs += b.checkedTabs;
  }
  return [...merged.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * 把一次对账结果折进按天聚合。**纯函数**（返回新数组，不改入参）。
 *
 * @param ts 样本时间（ISO）。不可解析 → 原样返回已净化的 buckets：
 *        无法归日的样本不进聚合（逐条日志里仍有它），而不是硬塞进今天——
 *        塞错日期会让某一天凭空多个样本，门禁的「持续」就成了假的。
 * @param result 对账结果。畸形结果按**最差**记账（overThreshold +1、rate 记 1），
 *        不静默算作达标：对账本身崩了是明确的坏消息，不该被读成绿色。
 */
export function foldAuditDaily(
  prev: unknown,
  ts: string,
  result: AuditResult,
  maxDays = AUDIT_DAILY_MAX
): AuditDailyBucket[] {
  const buckets = sanitizeDailyBuckets(prev);
  const date = utcDayOf(ts);
  if (date === null) return buckets;

  const r = result as Partial<AuditResult> | null;
  const rawRate = r && typeof r === 'object' ? finiteOrNull(r.mismatchRate) : null;
  // mismatchRate 非法（缺失/NaN/负数）→ 视作 1（最差），见函数头说明
  const rate = rawRate === null ? 1 : rawRate;
  const overThreshold = !(rate < GATE_MISMATCH_RATE_MAX);

  const groups = r && typeof r === 'object' ? (finiteOrNull(r.checkedGroups) ?? 0) : 0;
  const tabs = r && typeof r === 'object' ? (finiteOrNull(r.checkedTabs) ?? 0) : 0;

  const idx = buckets.findIndex(b => b.date === date);
  if (idx >= 0) {
    const cur = buckets[idx];
    buckets[idx] = {
      ...cur,
      samples: cur.samples + 1,
      overThresholdSamples: cur.overThresholdSamples + (overThreshold ? 1 : 0),
      worstMismatchRate: Math.max(cur.worstMismatchRate, rate),
      checkedGroups: cur.checkedGroups + groups,
      checkedTabs: cur.checkedTabs + tabs,
    };
  } else {
    buckets.push({
      date,
      samples: 1,
      overThresholdSamples: overThreshold ? 1 : 0,
      worstMismatchRate: rate,
      checkedGroups: groups,
      checkedTabs: tabs,
    });
  }

  // 先按日期升序再 FIFO。
  //
  // 顺序不是装饰：FIFO 从头部 shift()，数组一旦乱序，丢掉的就不是最老的那天。
  // 这里曾被单测抓到真实缺陷——fold 只 push 不排序，于是「保留最近 7 天」
  // 实际保留的是最早 7 天，最近样本全被丢掉，门禁永远显示无数据。
  buckets.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  while (buckets.length > maxDays) buckets.shift();
  return buckets;
}

// ── 门禁判定 ────────────────────────────────────────────────────────────

export type GateVerdict = 'pass' | 'fail' | 'insufficient_coverage' | 'no_data';

/** 窗口内某一天的判定行（给 UI 逐日渲染用）。 */
export interface GateDay {
  date: string;
  samples: number;
  overThreshold: boolean;
  worstMismatchRate: number;
}

export interface ShadowGateVerdict {
  verdict: GateVerdict;
  /** 门禁要求的连续天数（GATE_WINDOW_DAYS）。 */
  windowDays: number;
  /** 阈值（GATE_MISMATCH_RATE_MAX）。 */
  threshold: number;
  /** 窗口内有样本的天数。 */
  daysWithSamples: number;
  /** 窗口内的样本总数。 */
  samples: number;
  /** 窗口内超阈样本总数。 */
  overThresholdSamples: number;
  /** 窗口内最差 mismatchRate（无样本 = 0，配合 samples 一起读）。 */
  worstMismatchRate: number;
  /** 窗口内逐日明细，升序（无样本的那天也会出现，samples=0）。 */
  days: GateDay[];
  /** 结论的一句话理由（中文，直接给 UI 用）。 */
  reason: string;
}

/** UTC 日期串加天数（用 UTC 毫秒运算，避免本地时区把窗口挪一天）。 */
function addDays(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  return new Date(ms + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function pct(rate: number): string {
  // mismatchRate 是比值；0.001 → 0.1%。保留 3 位小数足够表达阈值附近的差异。
  return `${(rate * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

/**
 * 由按天聚合判定门禁。**纯函数**：给定 buckets 与 now，输出必然一致。
 *
 * @param rawBuckets y_audit_daily 的原始内容（畸形行由 sanitize 丢弃）
 * @param now 判定基准时间（窗口右端 = now 的 UTC 当天）
 */
export function evaluateShadowGate(
  rawBuckets: unknown,
  now: Date,
  opts?: { windowDays?: number; threshold?: number }
): ShadowGateVerdict {
  const windowDays = opts?.windowDays ?? GATE_WINDOW_DAYS;
  const threshold = opts?.threshold ?? GATE_MISMATCH_RATE_MAX;

  const buckets = sanitizeDailyBuckets(rawBuckets);
  const byDate = new Map(buckets.map(b => [b.date, b] as const));

  // 先查 getTime() 是否为 NaN 再调 toISOString()：Invalid Date 上 toISOString()
  // 会抛 RangeError（不是返回空串），放在表达式里会让整个判定崩掉而不是报「无数据」。
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  const today = Number.isNaN(nowMs) ? null : utcDayOf(now.toISOString());
  if (today === null) {
    // now 非法（调用方传了 Invalid Date）：不猜窗口，直接报没数据
    return {
      verdict: 'no_data',
      windowDays,
      threshold,
      daysWithSamples: 0,
      samples: 0,
      overThresholdSamples: 0,
      worstMismatchRate: 0,
      days: [],
      reason: '判定基准时间无效，无法确定 7 天窗口',
    };
  }

  // 窗口 = [today - (windowDays-1), today]，逐日展开（含没有样本的那天）
  const days: GateDay[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const date = addDays(today, -i);
    const b = byDate.get(date);
    days.push({
      date,
      samples: b?.samples ?? 0,
      overThreshold: (b?.overThresholdSamples ?? 0) > 0,
      worstMismatchRate: b?.worstMismatchRate ?? 0,
    });
  }

  const samples = days.reduce((n, d) => n + d.samples, 0);
  const overThresholdSamples = days.reduce(
    (n, d) => n + (byDate.get(d.date)?.overThresholdSamples ?? 0),
    0
  );
  const worstMismatchRate = days.reduce((m, d) => Math.max(m, d.worstMismatchRate), 0);
  const daysWithSamples = days.filter(d => d.samples > 0).length;

  const base = {
    windowDays,
    threshold,
    daysWithSamples,
    samples,
    overThresholdSamples,
    worstMismatchRate,
    days,
  };

  if (samples === 0) {
    return {
      ...base,
      verdict: 'no_data',
      reason: `最近 ${windowDays} 天没有任何对账样本，门禁无从判定（影子开关或采样是否生效？）`,
    };
  }

  // 负判定优先：已知超阈就不必再谈覆盖完整度
  if (overThresholdSamples > 0) {
    const worstDay = days.filter(d => d.overThreshold).sort((a, b) => b.worstMismatchRate - a.worstMismatchRate)[0];
    return {
      ...base,
      verdict: 'fail',
      reason:
        `${windowDays} 天窗口内有 ${overThresholdSamples} 个样本超过 ${pct(threshold)}` +
        (worstDay ? `（最差 ${worstDay.date}，${pct(worstDay.worstMismatchRate)}）` : '') +
        '：Y 侧物化视图与本地真相已分叉，切读会把分叉暴露给用户',
    };
  }

  if (daysWithSamples < windowDays) {
    const missing = days.filter(d => d.samples === 0).map(d => d.date);
    return {
      ...base,
      verdict: 'insufficient_coverage',
      reason:
        `${windowDays} 天窗口内只有 ${daysWithSamples} 天有样本，` +
        `${missing.length} 天无覆盖（${missing.join('、')}）：全部样本均未超阈，但「持续」尚无法成立`,
    };
  }

  return {
    ...base,
    verdict: 'pass',
    reason:
      `${windowDays} 天窗口内每天都有样本（共 ${samples} 个），最差 ${pct(worstMismatchRate)} ` +
      `未触及 ${pct(threshold)}：P1 门禁达成，V3 可进入决策`,
  };
}

/** 门禁结论 → 中文标签（UI 与摘要共用，避免两处各写一套词）。 */
export function gateVerdictLabel(verdict: GateVerdict): string {
  switch (verdict) {
    case 'pass':
      return '达成';
    case 'fail':
      return '未达成';
    case 'insufficient_coverage':
      return '覆盖不足';
    case 'no_data':
      return '无数据';
  }
}
