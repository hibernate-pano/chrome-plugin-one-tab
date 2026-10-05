// 钉死本地「命令轨迹」模块（2026-10-05 从 WAL 降级重写后）。
//
// ── 这次改了什么 ──────────────────────────────────────────────────────
// 原实现自称 write-ahead log，文件头写着「SW 启动时若发现状态落后于 journal，
// 重放规则与合并规则同一条——阶段二 Task 9 实现重放入口」。核实结果：
//   - read() 在 src/ 内零调用方（只有本模块自己）；
//   - markConfirmedUpTo() 同样零调用方；
//   - 单写者队列 + 每步直写落盘已经保证不留「需要重放」的中间态。
// 也就是说那个「WAL」**从未恢复过任何东西**，却每次点击都要全量读写
// 1000 条数组（体检实测：这是单次 mutation 固定 I/O 链的一环）。
//
// 现在它只做一件事：**命令分布统计**（诊断导出读 type 与 seq）。
// 所以：上限从 1000 降到 200（分布看最近 200 条足够），并删掉
// markConfirmedUpTo —— 留着它就是「看起来有个确认机制其实没人调」。
//
// 文件样板与 tests/mutationOps.test.ts 一致：@/ 别名需在 register(loader) 之后动态 import。
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

/** 造一份可控的 deps（kv 是内存 Map，seq 从 1 单调增） */
function makeDeps(initial?: unknown) {
  const kv = new Map<string, unknown>();
  if (initial !== undefined) kv.set('journal', initial);
  let seq = 0;
  return {
    kv,
    deps: {
      kvGet: async <T>(k: string) => (kv.get(k) ?? null) as T | null,
      kvSet: async (k: string, v: unknown) => {
        kv.set(k, v);
      },
      getDeviceId: async () => 'devA',
      nextSeq: async () => ++seq,
    },
  };
}

describe('journal: 命令轨迹（不再是 WAL）', () => {
  it('appendEntry 追加并保持环形上限 200（不是 1000）', async () => {
    const { createJournal } = await import('@/utils/journal');
    const { deps } = makeDeps();
    const j = createJournal(deps as never);
    for (let i = 0; i < 201; i++) {
      await j.appendEntry({ type: 'saveGroup', groupId: `g${i}` });
    }
    const log = await j.read();
    // 201 条写入、上限 200 ⇒ 最早的 g0 被挤掉，留 g1..g200
    assert.equal(log.length, 200, '环形缓冲必须把长度钉在上限，否则序列化成本随时间增长');
    assert.equal(log[0].groupId, 'g1');
    assert.equal(log[199].groupId, 'g200');
  });

  it('appendEntry 取的是 seqRegistry 递增后的号', async () => {
    const { createJournal } = await import('@/utils/journal');
    const kv = new Map<string, unknown>();
    let currentSeq = 5;
    const deps = {
      kvGet: async <_T>(_k: string) => null,
      kvSet: async (_k: string, _v: unknown) => { /* noop */ },
      getDeviceId: async () => 'devA',
      nextSeq: async () => ++currentSeq,
    };
    const j = createJournal(deps as never);
    const e = await j.appendEntry({ type: 'removeTab', groupId: 'g1', tabId: 't1' });
    assert.equal(e.s, 6);
    assert.equal(currentSeq, 6);
  });

  it('read 返回持久化的 entries（诊断导出靠它统计命令分布）', async () => {
    const { createJournal } = await import('@/utils/journal');
    const { deps } = makeDeps([
      { d: 'devA', s: 1, ts: '2026-01-01T00:00:00.000Z', type: 'saveGroup', groupId: 'g1' },
      { d: 'devA', s: 2, ts: '2026-01-01T00:00:01.000Z', type: 'removeTab', groupId: 'g1', tabId: 't1' },
    ]);
    const j = createJournal(deps as never);
    const log = await j.read();
    assert.equal(log.length, 2);
    assert.equal(log[1].type, 'removeTab');
  });

  it('appendEntry 携带 payload 与默认 ts', async () => {
    const { createJournal } = await import('@/utils/journal');
    const { deps } = makeDeps();
    const j = createJournal(deps as never);
    const e = await j.appendEntry({ type: 'renameGroup', groupId: 'g1', payload: { name: '新名' } });
    assert.equal(e.s, 1);
    assert.equal(e.d, 'devA');
    assert.equal(e.type, 'renameGroup');
    assert.equal(e.groupId, 'g1');
    assert.deepEqual(e.payload, { name: '新名' });
    assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('markConfirmedUpTo 已删除——它零调用方，留着等于假装有确认机制', async () => {
    const { createJournal } = await import('@/utils/journal');
    const { deps } = makeDeps();
    const j = createJournal(deps as never) as unknown as Record<string, unknown>;
    assert.equal(
      j.markConfirmedUpTo,
      undefined,
      'markConfirmedUpTo 从未有调用方（云端确认判定由 lastSyncedSeq 单独维护），已删除'
    );
    assert.equal(
      j.append,
      undefined,
      '不应新增 append 之类的别名方法——需要就是 appendEntry'
    );
  });

  it('磁盘上遗留的 1000 条旧数据会被自动收敛到 200（不必写迁移）', async () => {
    const { createJournal } = await import('@/utils/journal');
    // 模拟老版本留下的 1000 条
    const legacy = Array.from({ length: 1000 }, (_, i) => ({
      d: 'devA',
      s: i + 1,
      ts: '2026-01-01T00:00:00.000Z',
      type: 'saveGroup' as const,
      groupId: `legacy-${i}`,
    }));
    const { deps } = makeDeps(legacy);
    const j = createJournal(deps as never);
    // 一次 append 就顺带收敛（旧数据在第一次写入时被裁到上限）
    await j.appendEntry({ type: 'saveGroup', groupId: 'new' });
    const log = await j.read();
    assert.equal(log.length, 200, '旧数据必须被自动收敛，不需要写数据迁移');
    assert.equal(log[199].groupId, 'new');
  });
});
