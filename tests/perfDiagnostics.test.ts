// 性能 span → 诊断聚合（buildPerfSummary）的回归。
//
// 这层最容易出的事故不是「算不准」，而是「算出一个看起来合理但含义错误的数字」，
// 把排障的人带偏。三条要钉住的红线：
// 1) apply 必须用「run 总和 − 各 step 总和」推出（精确），绝不能用 max 相减
//    （把不同次调用的极值混在一起，得出的数字没有含义）。
// 2) 相减为负时必须钳到 0 **并记账**（clampedApplyNames）。静默输出 0 会被读成
//    「纯计算不耗时」——那是一个会误导优化方向的假信号。
// 3) span 名必须过封闭词表：诊断文件会被贴到公开 issue，不容许存储里的
//    任意字符串成为输出键。
//
// 文件样板与 tests/diagnostics.test.ts 一致：@/ 别名需在 register(loader) 之后动态 import。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};
const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

before(async () => {
  register(LOADER_PATH);
});

const TS = '2026-10-04T10:00:00.000Z';

/** 造一条 span。origin/id 只用于合并去重，聚合层不读。 */
function span(
  name: string,
  phase: 'wait' | 'run' | 'step',
  ms: number,
  step: string | null = null,
  id = 1
): Record<string, unknown> {
  return { name, phase, step, ms, ts: TS, origin: 'ctx_a', id };
}

async function build(spans: unknown[]) {
  const { buildPerfSummary } = await import('@/utils/diagnostics');
  return buildPerfSummary(spans);
}

function find(summary: Awaited<ReturnType<typeof build>>, name: string) {
  return summary.byName.find(s => s.name === name);
}

describe('buildPerfSummary: 两段归因', () => {
  it('wait 与 run 分开累计：头阻塞与自身耗时可区分', async () => {
    const s = await build([
      span('cleanDuplicates', 'wait', 3000),
      span('cleanDuplicates', 'run', 40),
      span('cleanDuplicates', 'step', 25, 'read'),
      span('cleanDuplicates', 'step', 10, 'write'),
    ]);
    const e = find(s, 'cleanDuplicates')!;
    assert.equal(e.count, 4);
    assert.equal(e.waitTotalMs, 3000);
    assert.equal(e.runTotalMs, 40);
    assert.deepEqual(e.stepsTotalMs, { read: 25, write: 10 });
  });

  it('apply = run 总和 − 各 step 总和（纯计算段被精确推出）', async () => {
    const s = await build([
      span('cleanDuplicates', 'run', 40),
      span('cleanDuplicates', 'step', 25, 'read'),
      span('cleanDuplicates', 'step', 10, 'write'),
    ]);
    assert.equal(find(s, 'cleanDuplicates')!.applyTotalMs, 5);
  });

  it('多次调用时 apply 是各次之和，不是「max 相减」', async () => {
    // 第一次：run 100，read 90（apply 10）
    // 第二次：run 50，read 5（apply 45）
    // 总和相减：150 − 95 = 55 ✅（= 10 + 45）
    // max 相减：100 − 90 = 10 ❌（丢掉第二次的 45，含义错误）
    const s = await build([
      span('moveTab', 'run', 100),
      span('moveTab', 'step', 90, 'read'),
      span('moveTab', 'run', 50),
      span('moveTab', 'step', 5, 'read'),
    ]);
    const e = find(s, 'moveTab')!;
    assert.equal(e.runTotalMs, 150);
    assert.equal(e.stepsTotalMs.read, 95);
    assert.equal(e.applyTotalMs, 55, '必须是总和相减（10 + 45），不是 max 相减（10）');
  });

  it('max 与 total 分开输出：单次峰值不能被多次累计掩盖', async () => {
    const s = await build([
      span('deleteGroup', 'run', 10),
      span('deleteGroup', 'run', 900),
      span('deleteGroup', 'wait', 5),
      span('deleteGroup', 'wait', 2000),
    ]);
    const e = find(s, 'deleteGroup')!;
    assert.equal(e.runTotalMs, 910);
    assert.equal(e.runMaxMs, 900);
    assert.equal(e.waitTotalMs, 2005);
    assert.equal(e.waitMaxMs, 2000);
  });

  it('没有 step 记录时 apply = run 全部（整段都算纯计算）', async () => {
    const s = await build([span('saveGroup', 'run', 33)]);
    const e = find(s, 'saveGroup')!;
    assert.equal(e.applyTotalMs, 33);
    assert.deepEqual(e.stepsTotalMs, {});
  });
});

describe('buildPerfSummary: 钳位记账（不许输出误导性的假 0）', () => {
  it('run < step（缓冲截断丢了 run 记录）→ apply 钳到 0 且名字被记账', async () => {
    const s = await build([
      span('cleanDuplicates', 'run', 10),
      span('cleanDuplicates', 'step', 60, 'write'),
    ]);
    const e = find(s, 'cleanDuplicates')!;
    assert.equal(e.applyTotalMs, 0, '不能输出负数');
    assert.deepEqual(s.clampedApplyNames, ['cleanDuplicates'], '必须显式记账，不静默');
  });

  it('正常数据下 clampedApplyNames 为空', async () => {
    const s = await build([
      span('deleteGroup', 'run', 50),
      span('deleteGroup', 'step', 20, 'read'),
    ]);
    assert.deepEqual(s.clampedApplyNames, []);
  });

  it('多个 span 被钳位时按名字排序（输出稳定可 diff）', async () => {
    const s = await build([
      span('moveTab', 'run', 1), span('moveTab', 'step', 5, 'read'),
      span('cleanDuplicates', 'run', 1), span('cleanDuplicates', 'step', 5, 'read'),
    ]);
    assert.deepEqual(s.clampedApplyNames, ['cleanDuplicates', 'moveTab']);
  });
});

describe('buildPerfSummary: scheduleUpload 不参与 apply 推导（fire-and-forget）', () => {
  it('run 窗口内的 step 会触发钳位，scheduleUpload 不会', async () => {
    // saveGroup / importGroups / renameGroup / toggleGroupLock / updateGroupFields
    // 五条路径上 d.scheduleUpload(...) 不带 await：它的 span 在 run 段**结束之后**
    // 才落账。把它减掉会从 run 里扣一段根本不在其中的时间 → 负的 apply → 假告警。
    const s = await build([
      span('saveGroup', 'run', 10),
      span('saveGroup', 'step', 200, 'scheduleUpload'),  // 落在 run 窗口之外
    ]);
    const e = find(s, 'saveGroup')!;
    assert.equal(e.applyTotalMs, 10, 'scheduleUpload 不参与推导，apply 应等于 run 全部');
    assert.deepEqual(s.clampedApplyNames, [], '不该报「数据不可信」');
    assert.equal(e.stepsTotalMs.scheduleUpload, 200, '但它仍单独列出，需要时直接看');
  });

  it('await 了的 scheduleUpload 与未 await 的一视同仁：都不进推导（保守且一致）', async () => {
    // 删除类命令里 scheduleUpload 是 await 的（确实在 run 窗口内），
    // 但聚合层无法区分同一条 span 来自哪条路径 —— 统一排除，
    // 代价是删除类的 applyTotalMs 会把那次 pending_upload 写盘算进去（毫秒级）。
    // 宁可轻微高估 apply，也不产出假告警。
    const s = await build([
      span('deleteGroup', 'run', 50),
      span('deleteGroup', 'step', 5, 'scheduleUpload'),
      span('deleteGroup', 'step', 20, 'read'),
    ]);
    const e = find(s, 'deleteGroup')!;
    assert.equal(e.applyTotalMs, 30, '50 − read 20 = 30；scheduleUpload 5 不减');
    assert.deepEqual(s.clampedApplyNames, []);
  });

  it('只有 run 窗口内的 step 超过 run 才钳位（真·缓冲截断的形状）', async () => {
    const s = await build([
      span('cleanDuplicates', 'run', 10),
      span('cleanDuplicates', 'step', 60, 'write'),           // 在窗口内 → 触发钳位
      span('cleanDuplicates', 'step', 999, 'scheduleUpload'), // 在窗口外 → 不触发
    ]);
    const e = find(s, 'cleanDuplicates')!;
    assert.equal(e.applyTotalMs, 0);
    assert.deepEqual(s.clampedApplyNames, ['cleanDuplicates'], '钳位仍应如实记账');
  });
});

describe('buildPerfSummary: 封闭词表与畸形数据', () => {
  it('词表外的 span 名被丢弃并记账（诊断文件不外带来路不明的字符串）', async () => {
    const s = await build([
      span('https://zzmarker-host.example/secret', 'run', 5),
      span('ZZMARKER-NAME', 'run', 5),
      span('deleteGroup', 'run', 5),
    ]);
    assert.equal(s.spanCount, 1);
    assert.equal(s.malformedCount, 2);
    assert.equal(s.byName.length, 1);
    assert.equal(s.byName[0].name, 'deleteGroup');
  });

  it('词表外的 step 名被丢弃并记账', async () => {
    const s = await build([span('deleteGroup', 'step', 5, 'ZZMARKER-STEP')]);
    assert.equal(s.spanCount, 0);
    assert.equal(s.malformedCount, 1);
    assert.equal(s.byName.length, 0, '不该为畸形条目建出 count=0 的空记录');
  });

  it('畸形条目（null / 非对象 / 缺字段 / 非法耗时）不崩且被记账', async () => {
    const s = await build([
      null,
      'not-an-object',
      42,
      { name: 'deleteGroup' },                                  // 缺 ms
      { name: 'deleteGroup', phase: 'run', ms: 'x' },            // ms 非数字
      { name: 'deleteGroup', phase: 'run', ms: -1 },              // 负耗时
      { name: 'deleteGroup', phase: 'run', ms: Number.NaN },      // NaN
      span('deleteGroup', 'run', 7),                              // 唯一合法的一条
    ] as unknown[]);
    assert.equal(s.spanCount, 1);
    assert.equal(s.malformedCount, 7);
    assert.equal(find(s, 'deleteGroup')!.runTotalMs, 7);
  });

  it('非数组输入按空处理（不崩、不编数据）', async () => {
    for (const bad of [undefined, null, 'x', 42, {}]) {
      const s = await build(bad as never);
      assert.equal(s.spanCount, 0);
      assert.deepEqual(s.byName, []);
    }
  });
});

describe('buildPerfSummary: 排序与纯函数性', () => {
  it('按 wait+run 降序：最慢的排最前（用户一眼看到问题）', async () => {
    const s = await build([
      span('saveGroup', 'run', 10),
      span('cleanDuplicates', 'wait', 5000), span('cleanDuplicates', 'run', 20),
      span('deleteGroup', 'run', 100),
    ]);
    assert.deepEqual(
      s.byName.map(e => e.name),
      ['cleanDuplicates', 'deleteGroup', 'saveGroup']
    );
  });

  it('纯函数：同样输入 ⇒ 逐字节相同输出（诊断可复现、可 diff）', async () => {
    const spans = [
      span('cleanDuplicates', 'wait', 1200),
      span('cleanDuplicates', 'run', 80),
      span('cleanDuplicates', 'step', 30, 'read'),
      span('sync:download', 'run', 900),
    ];
    const a = await build(spans);
    const b = await build(spans);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  it('输出里不含 ts / origin / id：只留聚合数字', async () => {
    const s = await build([span('deleteGroup', 'run', 5, null, 999)]);
    const json = JSON.stringify(s.byName);
    assert.doesNotMatch(json, /ctx_a/, '上下文身份不进输出');
    assert.doesNotMatch(json, /"ts"/, '单条时间戳不进输出');
    assert.doesNotMatch(json, /"id"/, '单条序号不进输出');
  });

  it('小数保留 1 位（避免浮点噪声让两次导出 diff 不干净）', async () => {
    const s = await build([span('moveTab', 'run', 0.1), span('moveTab', 'run', 0.2)]);
    assert.equal(find(s, 'moveTab')!.runTotalMs, 0.3);
  });
});

describe('诊断报告：perf 段接线与摘要文本', () => {
  const NOW = new Date('2026-10-04T12:00:00.000Z');

  function makeSources(overrides: Record<string, unknown> = {}) {
    return {
      groups: [],
      settings: { syncEnabled: true, syncStrategy: 'newest' },
      productEvents: [],
      journal: [],
      isAuthenticated: true,
      lastSyncTime: null,
      lastSyncedSeq: 0,
      pendingDeleteCount: 0,
      pendingUpload: false,
      perfSpans: [],
      // v3 起 DiagnosticsSources 多了影子/对账三键。这里给「读到了但是空的」形态
      // （键不存在 → kvGet 返回 null 是正常态，**不进 unavailable**）。
      // 读**抛错**才会 null → unavailable，那条路径由 diagnostics.test.ts 覆盖。
      shadowAudit: { auditLog: null, auditDaily: null, shadowLog: null },
      environment: {
        extensionVersion: '1.22.9',
        userAgent: 'Mozilla/5.0',
        platform: 'MacIntel',
        language: 'zh-CN',
      },
      ...overrides,
    };
  }

  it('report.perf 由 sources.perfSpans 聚合而来', async () => {
    const { buildDiagnosticsReport } = await import('@/utils/diagnostics');
    const report = buildDiagnosticsReport(
      makeSources({
        perfSpans: [
          span('cleanDuplicates', 'wait', 4000),
          span('cleanDuplicates', 'run', 30),
        ],
      }) as never,
      NOW
    );
    assert.equal(report.perf.spanCount, 2);
    assert.equal(report.perf.byName[0].name, 'cleanDuplicates');
    assert.equal(report.perf.byName[0].waitTotalMs, 4000);
    assert.deepEqual(report.perf.clampedApplyNames, []);
  });

  it('没有 span 时 perf 段是空表而不是崩（观测缺失是正常态）', async () => {
    const { buildDiagnosticsReport, serializeDiagnosticsReport } = await import('@/utils/diagnostics');
    const report = buildDiagnosticsReport(makeSources() as never, NOW);
    assert.equal(report.perf.spanCount, 0);
    assert.deepEqual(report.perf.byName, []);
    assert.doesNotThrow(() => JSON.parse(serializeDiagnosticsReport(report)));
  });

  it('perfSpans 不进 unavailable：读失败已降级为空，宣称观测不到的失败是假指示灯', async () => {
    const { buildDiagnosticsReport } = await import('@/utils/diagnostics');
    const report = buildDiagnosticsReport(
      makeSources({ groups: null, settings: null, pendingDeleteCount: null }) as never,
      NOW
    );
    assert.deepEqual(report.unavailable.sort(), ['groups', 'pendingDeleteIds', 'settings']);
    assert.ok(!report.unavailable.includes('perfSpans' as never));
  });

  it('摘要文本点名最慢的一条，并说清耗时在「等队列」还是「自身执行」', async () => {
    const { buildDiagnosticsReport, diagnosticsSummaryText } = await import('@/utils/diagnostics');
    // wait 远大于 run → 应判为头阻塞
    const headBlocked = buildDiagnosticsReport(
      makeSources({
        perfSpans: [
          span('cleanDuplicates', 'wait', 5000),
          span('cleanDuplicates', 'run', 40),
        ],
      }) as never,
      NOW
    );
    const text = diagnosticsSummaryText(headBlocked);
    assert.match(text, /cleanDuplicates/);
    assert.match(text, /等队列（头阻塞）/);

    // run 远大于 wait → 应判为自身执行
    const selfSlow = buildDiagnosticsReport(
      makeSources({
        perfSpans: [
          span('deleteGroup', 'wait', 2),
          span('deleteGroup', 'run', 1500),
        ],
      }) as never,
      NOW
    );
    assert.match(diagnosticsSummaryText(selfSlow), /自身执行/);
  });

  it('无 span 时摘要明说「暂无记录」，不假装测到了什么', async () => {
    const { buildDiagnosticsReport, diagnosticsSummaryText } = await import('@/utils/diagnostics');
    const report = buildDiagnosticsReport(makeSources() as never, NOW);
    assert.match(diagnosticsSummaryText(report), /暂无 span 记录/);
  });

  it('钳位发生时摘要出声提醒（apply 数字不可信）', async () => {
    const { buildDiagnosticsReport, diagnosticsSummaryText } = await import('@/utils/diagnostics');
    const report = buildDiagnosticsReport(
      makeSources({
        perfSpans: [
          span('cleanDuplicates', 'run', 5),
          span('cleanDuplicates', 'step', 90, 'write'),
        ],
      }) as never,
      NOW
    );
    assert.deepEqual(report.perf.clampedApplyNames, ['cleanDuplicates']);
    assert.match(diagnosticsSummaryText(report), /纯计算耗时不可信/);
  });
});
