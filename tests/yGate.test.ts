// V3 门禁判定单测（core/yGate.ts）。
//
// 这个文件的重点是**不能出现假绿**：门禁是「V3 该不该开工」的唯一依据，
// 一个把「没数据」判成 pass 的实现比没有门禁更糟。所以逐条钉住：
//   - 边界：mismatchRate 恰好等于阈值算不算超（严格小于才算达标）；
//   - 覆盖：7 天里缺一天就不能说「持续」；
//   - 优先级：已知超阈时必须判 fail，不能被「覆盖不足」掩盖；
//   - 窗口：窗口外的老样本不许参与判定；
//   - 账目：畸形输入一律丢弃并计数，不静默、不猜。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

before(async () => {
  register(LOADER_PATH);
});

type GateMod = typeof import('@/core/yGate');
let gateMod: GateMod;
let cfg: typeof import('@/core/yShadowConfig');

before(async () => {
  gateMod = await import('@/core/yGate');
  cfg = await import('@/core/yShadowConfig');
});

/** 判定基准：固定时刻（纯函数不该依赖真实当前时间）。 */
const NOW = new Date('2026-09-29T12:00:00.000Z');

function isoDaysAgo(days: number, hour = 12): string {
  const ms = NOW.getTime() - days * 24 * 60 * 60 * 1000;
  const d = new Date(ms);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

/** 建一个当天桶的输入（直接喂 evaluateShadowGate，绕过 fold）。 */
function bucket(date: string, samples: number, worst: number, over = 0) {
  return {
    date,
    samples,
    overThresholdSamples: over,
    worstMismatchRate: worst,
    checkedGroups: 10,
    checkedTabs: 100,
  };
}

/** 连续 N 天（含今天）的全达标 buckets。 */
function healthyBuckets(days = 7) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(NOW.getTime() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    out.push(bucket(d, 4, 0));
  }
  return out;
}

function result(rate: number, over: Partial<{ checkedGroups: number; checkedTabs: number }> = {}) {
  return {
    checkedGroups: over.checkedGroups ?? 10,
    checkedTabs: over.checkedTabs ?? 100,
    mismatches: [],
    match: rate === 0,
    mismatchRate: rate,
  } as never;
}

describe('yGate · 按天聚合 foldAuditDaily', () => {
  it('首次样本建当天桶，数字逐项落账', async () => {
    const { foldAuditDaily } = gateMod;
    const out = foldAuditDaily([], isoDaysAgo(0), result(0.0005, { checkedGroups: 3, checkedTabs: 7 }));
    assert.equal(out.length, 1);
    assert.equal(out[0].date, '2026-09-29');
    assert.equal(out[0].samples, 1);
    assert.equal(out[0].overThresholdSamples, 0);
    assert.equal(out[0].worstMismatchRate, 0.0005);
    assert.equal(out[0].checkedGroups, 3);
    assert.equal(out[0].checkedTabs, 7);
  });

  it('同一天多次样本累加，worst 取最大而不是最后一次', async () => {
    const { foldAuditDaily } = gateMod;
    let buckets = foldAuditDaily([], isoDaysAgo(0), result(0.002));
    buckets = foldAuditDaily(buckets, isoDaysAgo(0), result(0.0001));
    buckets = foldAuditDaily(buckets, isoDaysAgo(0), result(0.0002));
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].samples, 3);
    assert.equal(buckets[0].worstMismatchRate, 0.002);
    // 0.002 ≥ 0.001 → 当天记 1 条超阈；后两条达标不加
    assert.equal(buckets[0].overThresholdSamples, 1);
  });

  it('跨天分桶，且按日期升序', async () => {
    const { foldAuditDaily } = gateMod;
    let buckets = foldAuditDaily([], isoDaysAgo(0), result(0));
    buckets = foldAuditDaily(buckets, isoDaysAgo(2), result(0));
    buckets = foldAuditDaily(buckets, isoDaysAgo(1), result(0));
    assert.deepEqual(
      buckets.map(b => b.date),
      ['2026-09-27', '2026-09-28', '2026-09-29']
    );
  });

  it('阈值边界：mismatchRate 恰好 = 0.1% 算超阈（门禁要求严格小于）', async () => {
    const { foldAuditDaily } = gateMod;
    const at = foldAuditDaily([], isoDaysAgo(0), result(cfg.GATE_MISMATCH_RATE_MAX));
    assert.equal(at[0].overThresholdSamples, 1, '恰好等于阈值必须算不达标');

    const justUnder = foldAuditDaily([], isoDaysAgo(0), result(cfg.GATE_MISMATCH_RATE_MAX * 0.9));
    assert.equal(justUnder[0].overThresholdSamples, 0);
  });

  it('畸形 result（rate 缺失/NaN）按最差记账，不静默算作达标', async () => {
    const { foldAuditDaily } = gateMod;
    const missing = foldAuditDaily([], isoDaysAgo(0), {} as never);
    assert.equal(missing[0].samples, 1);
    assert.equal(missing[0].overThresholdSamples, 1);
    assert.equal(missing[0].worstMismatchRate, 1);

    const nan = foldAuditDaily([], isoDaysAgo(0), { mismatchRate: Number.NaN } as never);
    assert.equal(nan[0].overThresholdSamples, 1);

    const negative = foldAuditDaily([], isoDaysAgo(0), { mismatchRate: -1 } as never);
    assert.equal(negative[0].overThresholdSamples, 1);
  });

  it('ts 不可解析 → 样本不进聚合，原样返回已净化内容（不硬塞进今天）', async () => {
    const { foldAuditDaily } = gateMod;
    const before = foldAuditDaily([], isoDaysAgo(0), result(0));
    const after = foldAuditDaily(before, 'not-a-date', result(0));
    assert.deepEqual(after, before);
  });

  it('FIFO 截断到 maxDays，且保留最近的天', async () => {
    const { foldAuditDaily } = gateMod;
    let buckets: ReturnType<typeof foldAuditDaily> = [];
    for (let i = 0; i < 12; i++) buckets = foldAuditDaily(buckets, isoDaysAgo(i), result(0), 7);
    assert.equal(buckets.length, 7);
    assert.equal(buckets[buckets.length - 1].date, '2026-09-29');
    assert.equal(buckets[0].date, '2026-09-23');
  });

  it('是纯函数：不修改入参数组', async () => {
    const { foldAuditDaily } = gateMod;
    const input = [bucket('2026-09-29', 1, 0)];
    const snapshot = JSON.parse(JSON.stringify(input));
    foldAuditDaily(input, isoDaysAgo(0), result(0));
    assert.deepEqual(input, snapshot);
  });

  it('存储被写坏的行（缺字段/日期非法/超阈数大于样本数）不会让整天消失', async () => {
    const { sanitizeDailyBuckets } = gateMod;
    const out = sanitizeDailyBuckets([
      { date: '2026-09-29', samples: 2, overThresholdSamples: 9, worstMismatchRate: 0.5, checkedGroups: 1, checkedTabs: 1 },
      { date: 'x', samples: 1, overThresholdSamples: 0, worstMismatchRate: 0 },
      { samples: 1 },
      null,
      'garbage',
    ]);
    assert.equal(out.length, 1);
    // 超阈数被钳到样本数：宁可记「当天全超」也不让这天消失（消失会被读成覆盖不足）
    assert.equal(out[0].overThresholdSamples, 2);
    assert.equal(out[0].samples, 2);
  });

  it('同一天出现多行 → 合并（并发写/迁移残留），不让后一行覆盖前一行', async () => {
    const { sanitizeDailyBuckets } = gateMod;
    const out = sanitizeDailyBuckets([
      bucket('2026-09-29', 2, 0.0001),
      bucket('2026-09-29', 3, 0.004, 1),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].samples, 5);
    assert.equal(out[0].overThresholdSamples, 1);
    assert.equal(out[0].worstMismatchRate, 0.004);
  });
});

describe('yGate · 门禁判定 evaluateShadowGate', () => {
  it('无任何样本 → no_data（不是 pass）', async () => {
    const { evaluateShadowGate } = gateMod;
    const v = evaluateShadowGate([], NOW);
    assert.equal(v.verdict, 'no_data');
    assert.equal(v.samples, 0);
    assert.equal(v.days.length, cfg.GATE_WINDOW_DAYS, '7 天窗口逐日展开，缺的天也要画出来');
    assert.ok(v.reason.includes('没有任何对账样本'));
  });

  it('存储里是垃圾（null / 非数组）→ no_data，不抛错', async () => {
    const { evaluateShadowGate } = gateMod;
    for (const junk of [null, undefined, 'x', 42, {}]) {
      assert.equal(evaluateShadowGate(junk, NOW).verdict, 'no_data');
    }
  });

  it('7 天每天都有样本且全部达标 → pass', async () => {
    const { evaluateShadowGate } = gateMod;
    const v = evaluateShadowGate(healthyBuckets(7), NOW);
    assert.equal(v.verdict, 'pass');
    assert.equal(v.daysWithSamples, 7);
    assert.equal(v.samples, 28);
    assert.equal(v.overThresholdSamples, 0);
    assert.ok(v.reason.includes('门禁达成'));
  });

  it('7 天里缺一天 → insufficient_coverage（全部样本都没超阈也不行）', async () => {
    const { evaluateShadowGate } = gateMod;
    const buckets = healthyBuckets(7).filter(b => b.date !== '2026-09-27');
    const v = evaluateShadowGate(buckets, NOW);
    assert.equal(v.verdict, 'insufficient_coverage');
    assert.equal(v.daysWithSamples, 6);
    assert.ok(v.reason.includes('2026-09-27'), '理由里要指出缺的是哪一天');
    assert.ok(v.reason.includes('无法成立') || v.reason.includes('尚无法成立'));
  });

  it('有样本超阈 → fail', async () => {
    const { evaluateShadowGate } = gateMod;
    const buckets = healthyBuckets(7);
    buckets[3] = bucket('2026-09-26', 4, 0.02, 1);
    const v = evaluateShadowGate(buckets, NOW);
    assert.equal(v.verdict, 'fail');
    assert.equal(v.overThresholdSamples, 1);
    assert.ok(v.reason.includes('2026-09-26'));
  });

  it('已知超阈 + 同时缺日 → 判 fail，不用「覆盖不足」掩盖已知失败', async () => {
    const { evaluateShadowGate } = gateMod;
    const buckets = [
      ...healthyBuckets(7).filter(b => b.date !== '2026-09-27'),
      bucket('2026-09-29', 1, 0.01, 1),
    ];
    assert.equal(evaluateShadowGate(buckets, NOW).verdict, 'fail');
  });

  it('窗口外的老样本不参与判定（7 天前的超阈记录不该拖累今天）', async () => {
    const { evaluateShadowGate } = gateMod;
    const buckets = [...healthyBuckets(7), bucket('2026-09-01', 5, 0.9, 5)];
    const v = evaluateShadowGate(buckets, NOW);
    assert.equal(v.verdict, 'pass');
    assert.equal(v.overThresholdSamples, 0, '窗口外的超阈样本不许计入');
  });

  it('窗口恰好第 7 天（NOW-6d）算在窗口内，第 8 天（NOW-7d）算在外', async () => {
    const { evaluateShadowGate } = gateMod;
    const inWindow = evaluateShadowGate([...healthyBuckets(7)], NOW);
    assert.equal(inWindow.days[0].date, '2026-09-23');

    const withEighth = [...healthyBuckets(8)];
    const v = evaluateShadowGate(withEighth, NOW);
    assert.equal(v.daysWithSamples, 7);
    assert.ok(!v.days.some(d => d.date === '2026-09-22'), '第 8 天不进窗口');
  });

  it('now 非法 → no_data 且不猜窗口', async () => {
    const { evaluateShadowGate } = gateMod;
    const v = evaluateShadowGate(healthyBuckets(7), new Date('nonsense'));
    assert.equal(v.verdict, 'no_data');
    assert.deepEqual(v.days, []);
  });

  it('阈值/窗口可通过 opts 覆写（门禁参数变更不必改测试）', async () => {
    const { evaluateShadowGate } = gateMod;
    const v = evaluateShadowGate(healthyBuckets(7), NOW, { windowDays: 3, threshold: 0.5 });
    assert.equal(v.windowDays, 3);
    assert.equal(v.threshold, 0.5);
    assert.equal(v.days.length, 3);
  });

  it('四态都有中文标签（UI 与摘要共用，防止两处各写一套词）', async () => {
    const { gateVerdictLabel } = gateMod;
    assert.equal(gateVerdictLabel('pass'), '达成');
    assert.equal(gateVerdictLabel('fail'), '未达成');
    assert.equal(gateVerdictLabel('insufficient_coverage'), '覆盖不足');
    assert.equal(gateVerdictLabel('no_data'), '无数据');
  });

  it('词表：outcome / scope / field 只认已知字面量', async () => {
    const { isShadowOutcomeKind, isMismatchScope, isMismatchField } = gateMod;
    assert.ok(isShadowOutcomeKind('ok'));
    assert.ok(isShadowOutcomeKind('rollout'));
    assert.ok(!isShadowOutcomeKind('OK'));
    assert.ok(!isShadowOutcomeKind('whatever'));

    assert.ok(isMismatchScope('tab'));
    assert.ok(!isMismatchScope('https://evil.example'));

    assert.ok(isMismatchField('url'));
    assert.ok(isMismatchField('audit_crashed'));
    assert.ok(!isMismatchField('https://evil.example'));
  });
});
