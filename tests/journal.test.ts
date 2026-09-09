// 钉死本地 journal write-ahead log（规格 §4.3）：
// - appendEntry 追加并保持 FIFO 上限（默认 1000）
// - appendEntry 写入前 seq 已先自增
// - read 返回持久化的 entries
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

describe('journal: write-ahead log（§4.3）', () => {
  it('appendEntry 追加并保持 FIFO 上限 1000', async () => {
    const { createJournal } = await import('@/utils/journal');
    const stored: string[] = [];
    const kv = new Map<string, unknown>();
    const deps = {
      kvGet: async <T>(k: string) => (kv.get(k) ?? null) as T | null,
      kvSet: async (k: string, v: unknown) => { kv.set(k, v); },
      getDeviceId: async () => 'devA',
      nextSeq: async () => { stored.push('seq'); return stored.length; },
    };
    const j = createJournal(deps as any);
    for (let i = 0; i < 1001; i++) {
      await j.appendEntry({ type: 'saveGroup', groupId: `g${i}` });
    }
    const log = await j.read();
    assert.equal(log.length, 1000);
    assert.equal(log[0].groupId, 'g1'); // 最早的被裁剪
    assert.equal(log[999].groupId, 'g1000');
  });

  it('appendEntry 写入前 seq 已先自增', async () => {
    const { createJournal } = await import('@/utils/journal');
    let currentSeq = 5;
    const deps = {
      kvGet: async <T>(k: string) => null,
      kvSet: async (k: string, v: unknown) => { /* noop */ },
      getDeviceId: async () => 'devA',
      nextSeq: async () => ++currentSeq,
    };
    const j = createJournal(deps as any);
    const e = await j.appendEntry({ type: 'removeTab', groupId: 'g1', tabId: 't1' });
    assert.equal(e.s, 6);
    assert.equal(currentSeq, 6);
  });

  it('read 返回持久化的 entries', async () => {
    const { createJournal } = await import('@/utils/journal');
    const kv = new Map<string, unknown>([['journal', [
      { d: 'devA', s: 1, ts: '2026-01-01T00:00:00.000Z', type: 'saveGroup', groupId: 'g1' },
      { d: 'devA', s: 2, ts: '2026-01-01T00:00:01.000Z', type: 'removeTab', groupId: 'g1', tabId: 't1' },
    ]]]);
    const deps = {
      kvGet: async <T>(k: string) => (kv.get(k) ?? null) as T | null,
      kvSet: async (k: string, v: unknown) => { kv.set(k, v); },
      getDeviceId: async () => 'devA',
      nextSeq: async () => 99,
    };
    const j = createJournal(deps as any);
    const log = await j.read();
    assert.equal(log.length, 2);
    assert.equal(log[1].type, 'removeTab');
  });

  it('appendEntry 携带 payload 与默认 ts', async () => {
    const { createJournal } = await import('@/utils/journal');
    let seq = 0;
    const deps = {
      kvGet: async <T>(k: string) => null,
      kvSet: async (k: string, v: unknown) => { /* noop */ },
      getDeviceId: async () => 'devB',
      nextSeq: async () => ++seq,
    };
    const j = createJournal(deps as any);
    const e = await j.appendEntry({ type: 'renameGroup', groupId: 'g1', payload: { name: '新名' } });
    assert.equal(e.s, 1);
    assert.equal(e.d, 'devB');
    assert.equal(e.type, 'renameGroup');
    assert.equal(e.groupId, 'g1');
    assert.deepEqual(e.payload, { name: '新名' });
    assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('markConfirmedUpTo 不物理裁剪——保留至 FIFO 上限淘汰', async () => {
    const { createJournal } = await import('@/utils/journal');
    const entries = [
      { d: 'devA', s: 1, ts: 't1', type: 'saveGroup' as const, groupId: 'g1' },
      { d: 'devA', s: 2, ts: 't2', type: 'saveGroup' as const, groupId: 'g2' },
      { d: 'devA', s: 3, ts: 't3', type: 'saveGroup' as const, groupId: 'g3' },
    ];
    const kv = new Map<string, unknown>([['journal', entries]]);
    const deps = {
      kvGet: async <T>(k: string) => (kv.get(k) ?? null) as T | null,
      kvSet: async (k: string, v: unknown) => { kv.set(k, v); },
      getDeviceId: async () => 'devA',
      nextSeq: async () => 99,
    };
    const j = createJournal(deps as any);
    const remaining = await j.markConfirmedUpTo(2);
    assert.equal(remaining, 1); // s=3 未确认
    const log = await j.read();
    assert.equal(log.length, 3); // 没有裁剪
  });
});