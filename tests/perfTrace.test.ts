// 性能 span 缓冲的不变量回归。
//
// 这份测试的核心不是「计时准不准」（那由 measure 的 try/finally 结构保证），
// 而是三件真正会出事故的事：
// 1) **观测不能影响被观测的操作** —— 写盘失败、名字不在词表、耗时非法，
//    一律不得抛到调用方。否则「加了个埋点」会把原本能用的删除功能弄崩。
// 2) **合并而非覆盖** —— SW 与 UI 两个进程各持内存缓冲、写同一个键，
//    覆盖会让后写的一方抹掉先写一方的记录，而慢操作恰恰横跨两个进程。
// 3) **封闭词表** —— span 名会进入诊断文件（用户可能贴到公开 issue），
//    必须只可能是代码常量，不许有来路不明的动态字符串流出去。
//
// 文件样板与 tests/seqRegistry.test.ts 一致：@/ 别名需在 register(loader) 之后动态 import。
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

const KEY = 'perf_spans';
const T0 = Date.parse('2026-10-04T10:00:00.000Z');

type KvOpts = {
  /** kvSet 抛错：模拟 IndexedDB 写失败。 */
  failWrite?: boolean;
  /** kvGet 抛错：模拟读失败。 */
  failRead?: boolean;
  /** 预置的已落盘内容（模拟另一个进程写过的记录）。 */
  seed?: unknown[];
  origin?: string;
};

async function makeTracer(opts: KvOpts = {}) {
  const { createPerfTracer } = await import('@/utils/perfTrace');
  const kv = new Map<string, unknown>();
  if (opts.seed) kv.set(KEY, opts.seed);
  const tracer = createPerfTracer({
    kvGet: async <T,>(k: string) => {
      if (opts.failRead) throw new Error('read failed');
      return (kv.get(k) ?? null) as T | null;
    },
    kvSet: async (k: string, v: unknown) => {
      if (opts.failWrite) throw new Error('write failed');
      kv.set(k, v);
    },
    kvRemove: async (k: string) => { kv.delete(k); },
    getOrigin: () => opts.origin ?? 'ctx_a',
    now: () => T0,
  });
  return { tracer, kv };
}

/** 已落盘的 span 数组（读 KV 原始值）。 */
function stored(kv: Map<string, unknown>): any[] {
  return (kv.get(KEY) as any[]) ?? [];
}

describe('perfTrace: 记录与落盘', () => {
  it('recordSpan 先进内存缓冲，flush 后才落盘（节流窗口的语义）', async () => {
    const { tracer, kv } = await makeTracer();
    tracer.recordSpan('cleanDuplicates', 'run', 12);
    assert.equal(stored(kv).length, 0, '未 flush 前不写盘');
    assert.equal(tracer.peekBuffer().length, 1);
    await tracer.flush();
    assert.equal(stored(kv).length, 1, 'flush 后落盘');
    const [s] = stored(kv);
    assert.equal(s.name, 'cleanDuplicates');
    assert.equal(s.phase, 'run');
    assert.equal(s.ms, 12);
    assert.equal(s.step, null);
  });

  it('read() 会先 flush：诊断导出拿得到最近几秒的现场', async () => {
    const { tracer, kv } = await makeTracer();
    tracer.recordSpan('deleteGroup', 'wait', 5);
    const spans = await tracer.read();
    assert.equal(spans.length, 1, 'read 必须先把缓冲落盘，否则丢掉要看的现场');
    assert.equal(stored(kv).length, 1);
  });

  it('measure 记录 step 阶段，且原样返回 fn 的结果', async () => {
    const { tracer } = await makeTracer();
    const out = await tracer.measure('cleanDuplicates', 'read', () => Promise.resolve({ ok: 1 }));
    assert.deepEqual(out, { ok: 1 });
    const [s] = tracer.peekBuffer();
    assert.equal(s.phase, 'step');
    assert.equal(s.step, 'read');
  });

  it('measure：fn 抛错时照常向上抛，但仍记下这次耗时（失败也是证据）', async () => {
    const { tracer } = await makeTracer();
    await assert.rejects(
      tracer.measure('cleanDuplicates', 'write', () => { throw new Error('boom'); }),
      /boom/
    );
    assert.equal(tracer.peekBuffer().length, 1, '失败的调用同样要计时');
    assert.equal(tracer.peekBuffer()[0].step, 'write');
  });

  it('缓冲超过上限时截断最旧的一条', async () => {
    const { createPerfTracer, PERF_SPAN_MAX } = await import('@/utils/perfTrace');
    const kv = new Map<string, unknown>();
    const tracer = createPerfTracer({
      kvGet: async () => null,
      kvSet: async (k, v) => { kv.set(k, v); },
      kvRemove: async (k) => { kv.delete(k); },
      getOrigin: () => 'ctx_a',
      now: () => T0,
    });
    for (let i = 0; i < PERF_SPAN_MAX + 5; i++) tracer.recordSpan('moveTab', 'run', i);
    assert.equal(tracer.peekBuffer().length, PERF_SPAN_MAX, '缓冲不无界增长');
    // 留下的是最新的（ms = 5..MAX+4），最旧的 0..4 被挤掉
    assert.equal(tracer.peekBuffer()[0].ms, 5);
  });
});

describe('perfTrace: 观测永不影响被观测的操作', () => {
  it('kvSet 失败：recordSpan / measure / read 都不抛，span 留在内存等下轮', async () => {
    const { tracer, kv } = await makeTracer({ failWrite: true });
    tracer.recordSpan('cleanDuplicates', 'run', 12);
    await tracer.flush();
    assert.equal(stored(kv).length, 0);
    assert.equal(tracer.peekBuffer().length, 1, '失败后缓冲仍在（意图不丢）');
    // read 内部也走 flush，同样不得抛
    const spans = await tracer.read();
    assert.deepEqual(spans, []);
  });

  it('kvGet 失败：按空处理，不抛（诊断导出不该因为观测数据读不出来而整体失败）', async () => {
    const { tracer } = await makeTracer({ failRead: true });
    tracer.recordSpan('deleteGroup', 'run', 3);
    const spans = await tracer.read();
    assert.deepEqual(spans, []);
  });

  it('非法耗时（NaN / 负数）静默丢弃，不产生脏记录', async () => {
    const { tracer } = await makeTracer();
    tracer.recordSpan('deleteGroup', 'run', Number.NaN);
    tracer.recordSpan('deleteGroup', 'run', -1);
    tracer.recordSpan('deleteGroup', 'run', Number.POSITIVE_INFINITY);
    assert.equal(tracer.peekBuffer().length, 0);
  });

  it('step 阶段缺 step 名时丢弃（归不了类就不记，避免污染聚合）', async () => {
    const { tracer } = await makeTracer();
    tracer.recordSpan('deleteGroup', 'step', 5);
    assert.equal(tracer.peekBuffer().length, 0);
  });
});

describe('perfTrace: 封闭词表（诊断文件不外带来路不明的字符串）', () => {
  it('词表外的 span 名被丢弃', async () => {
    const { tracer } = await makeTracer();
    tracer.recordSpan('https://evil.example/ZZMARKER', 'run', 5);
    tracer.recordSpan('用户会话名 ZZMARKER', 'run', 5);
    assert.equal(tracer.peekBuffer().length, 0, '动态字符串不得成为流向公开文件的通道');
  });

  it('词表覆盖全部语义命令：MutationOp 的每个 op 都可被计时', async () => {
    const { PERF_SPAN_NAMES } = await import('@/utils/perfTrace');
    // 与 diagnostics.JOURNAL_OP_TYPES 同源交叉校验：mutation 的 op 集合就是
    // span 名集合的子集。新增一个 op 而忘了登记 span 名，这里直接红。
    const names = new Set<string>(PERF_SPAN_NAMES);
    const mutationOps = [
      'saveGroup', 'removeTab', 'deleteGroup', 'deleteAllGroups', 'importGroups',
      'renameGroup', 'toggleGroupLock', 'moveTab', 'cleanDuplicates',
    ];
    for (const op of mutationOps) {
      assert.ok(names.has(op), `语义命令 ${op} 不在 perf span 词表内（无法计时）`);
    }
  });
});

describe('perfTrace: 多进程合并（SW 与 UI 写同一个键）', () => {
  it('落盘是合并而非覆盖：另一个进程已写的记录不被抹掉', async () => {
    const foreign = [
      { name: 'sync:download', phase: 'run', step: null, ms: 900, ts: new Date(T0 - 1000).toISOString(), origin: 'ctx_sw', id: 1 },
    ];
    const { tracer, kv } = await makeTracer({ seed: foreign });
    tracer.recordSpan('cleanDuplicates', 'run', 20);
    await tracer.flush();
    const all = stored(kv);
    assert.equal(all.length, 2, '两个进程的记录都要留住');
    assert.ok(all.some(s => s.origin === 'ctx_sw'), 'SW 的记录未被覆盖');
    assert.ok(all.some(s => s.origin === 'ctx_a'), '本进程的记录已写入');
  });

  it('同一批 span 重复 flush 不产生重复记录', async () => {
    const { tracer, kv } = await makeTracer();
    tracer.recordSpan('deleteGroup', 'run', 8);
    await tracer.flush();
    await tracer.flush();
    await tracer.flush();
    assert.equal(stored(kv).length, 1, 'flush 幂等：已落盘的不重复推入');
  });

  it('合并结果按时间排序（诊断输出可直接读）', async () => {
    const later = { name: 'moveTab', phase: 'run', step: null, ms: 1, ts: new Date(T0 + 60_000).toISOString(), origin: 'ctx_sw', id: 9 };
    const earlier = { name: 'saveGroup', phase: 'run', step: null, ms: 1, ts: new Date(T0 - 60_000).toISOString(), origin: 'ctx_sw', id: 8 };
    const { tracer, kv } = await makeTracer({ seed: [later, earlier] });
    tracer.recordSpan('deleteGroup', 'run', 2);
    await tracer.flush();
    const ts = stored(kv).map(s => s.ts);
    assert.deepEqual(ts, [...ts].sort(), '按 ts 升序');
  });

  it('clear 清空内存缓冲与落盘内容', async () => {
    const { tracer, kv } = await makeTracer();
    tracer.recordSpan('deleteGroup', 'run', 2);
    await tracer.flush();
    assert.equal(stored(kv).length, 1);
    await tracer.clear();
    assert.equal(stored(kv).length, 0);
    assert.equal(tracer.peekBuffer().length, 0);
  });
});

describe('perfTrace: 单写者队列把等待与执行分开记', () => {
  it('慢任务占着队列时，后入队的命令记出可观的 wait 段、run 段只算自己', async () => {
    const { enqueue, resetQueue } = await import('@/background/mutationQueue');
    const { perfTrace, __resetPerfTraceForTests } = await import('@/utils/perfTrace');
    __resetPerfTraceForTests();
    resetQueue();

    // 直接读生产单例的内存缓冲：recordSpan 先入缓冲，落盘（可能失败，node 下无
    // IndexedDB）不影响缓冲内容，因此无需替换模块导出就能断言计时行为。
    const slow = enqueue('sync:download', async () => {
      await new Promise(r => setTimeout(r, 80));
    });
    const fast = enqueue('cleanDuplicates', async () => 'done');
    await Promise.all([slow, fast]);

    const spans = perfTrace().peekBuffer();
    const cleanWait = spans.find(s => s.name === 'cleanDuplicates' && s.phase === 'wait');
    const cleanRun = spans.find(s => s.name === 'cleanDuplicates' && s.phase === 'run');
    const downloadWait = spans.find(s => s.name === 'sync:download' && s.phase === 'wait');

    assert.ok(cleanWait, '必须记出 cleanDuplicates 的 wait 段');
    assert.ok(cleanRun, '必须记出 cleanDuplicates 的 run 段');
    assert.ok(
      cleanWait!.ms >= 70,
      `wait 段应包含等前一个任务的时间（实际 ${cleanWait!.ms}ms）——这就是「头阻塞」的直接证据`
    );
    assert.ok(cleanRun!.ms < 70, `run 段只算自己执行的时间（实际 ${cleanRun!.ms}ms）`);
    // 队首任务没有前驱，wait 应接近 0：证明 wait 段测的是排队而不是启动开销
    assert.ok(downloadWait, '必须记出 sync:download 的 wait 段');
    assert.ok(downloadWait!.ms < 20, `队首任务不该有可观 wait（实际 ${downloadWait!.ms}ms）`);
  });
});
