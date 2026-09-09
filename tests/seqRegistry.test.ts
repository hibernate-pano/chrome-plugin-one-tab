// 钉死本设备 seq 单调计数器（规格 §4.1）：
// - nextSeq 单调递增且持久化；重启后从持久化恢复
// - getDeviceSeq 修复：实体印记中本设备 max s 更高时取 max+100
// - bumpSeqIfLower 仅在 candidate 更高时更新
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

describe('seqRegistry: 本设备 seq 单调计数器', () => {
  it('nextSeq 单调递增且持久化', async () => {
    const { createSeqRegistry } = await import('@/utils/seqRegistry');
    const kv = new Map<string, unknown>();
    const deps = {
      kvGet: async <T>(k: string) => (kv.get(k) ?? null) as T | null,
      kvSet: async (k: string, v: unknown) => { kv.set(k, v); },
      getDeviceId: async () => 'devA',
      getGroups: async () => [],
    };
    const reg = createSeqRegistry(deps as any);
    assert.equal(await reg.getDeviceSeq(), 0);
    assert.equal(await reg.nextSeq(), 1);
    assert.equal(await reg.nextSeq(), 2);
    assert.equal(await reg.getDeviceSeq(), 2);
  });

  it('重启后从持久化恢复，不重复发号', async () => {
    const { createSeqRegistry } = await import('@/utils/seqRegistry');
    const kv = new Map<string, unknown>([['device_seq', 5]]);
    const deps = {
      kvGet: async <T>(k: string) => (kv.get(k) ?? null) as T | null,
      kvSet: async (k: string, v: unknown) => { kv.set(k, v); },
      getDeviceId: async () => 'devA',
      getGroups: async () => [],
    };
    const reg = createSeqRegistry(deps as any);
    assert.equal(await reg.getDeviceSeq(), 5);
    assert.equal(await reg.nextSeq(), 6);
  });

  it('getDeviceSeq 修复：实体印记中本设备 max s 更高时取 max+100', async () => {
    const { createSeqRegistry } = await import('@/utils/seqRegistry');
    const kv = new Map<string, unknown>([['device_seq', 10]]);
    const deps = {
      kvGet: async <T>(k: string) => (kv.get(k) ?? null) as T | null,
      kvSet: async (k: string, v: unknown) => { kv.set(k, v); },
      getDeviceId: async () => 'devA',
      getGroups: async () => [
        { id: 'g1', lastOp: { d: 'devA', s: 50 } } as any,
        { id: 'g2', lastOp: { d: 'devA', s: 30 } } as any,
        { id: 'g3', lastOp: { d: 'devB', s: 999 } } as any, // 其他设备不算
      ],
    };
    const reg = createSeqRegistry(deps as any);
    // 当前持久化 10 < 本设备实体印记 max 50 → 修复为 50 + 100 = 150
    assert.equal(await reg.getDeviceSeq(), 150);
    assert.equal(kv.get('device_seq'), 150);
  });

  it('bumpSeqIfLower 仅在 candidate 更高时更新', async () => {
    const { createSeqRegistry } = await import('@/utils/seqRegistry');
    const kv = new Map<string, unknown>([['device_seq', 100]]);
    const deps = {
      kvGet: async <T>(k: string) => (kv.get(k) ?? null) as T | null,
      kvSet: async (k: string, v: unknown) => { kv.set(k, v); },
      getDeviceId: async () => 'devA',
      getGroups: async () => [],
    };
    const reg = createSeqRegistry(deps as any);
    assert.equal(await reg.bumpSeqIfLower(50), 100); // 不更新
    assert.equal(await reg.bumpSeqIfLower(150), 150); // 更新
    assert.equal(await reg.getDeviceSeq(), 150);
  });

  it('getDeviceSeq 缓存：连续读取不重复读 storage', async () => {
    const { createSeqRegistry } = await import('@/utils/seqRegistry');
    let calls = 0;
    const kv = new Map<string, unknown>([['device_seq', 7]]);
    const deps = {
      kvGet: async <T>(k: string) => { calls += 1; return (kv.get(k) ?? null) as T | null; },
      kvSet: async (k: string, v: unknown) => { kv.set(k, v); },
      getDeviceId: async () => 'devA',
      getGroups: async () => [],
    };
    const reg = createSeqRegistry(deps as any);
    await reg.getDeviceSeq();
    await reg.getDeviceSeq();
    await reg.getDeviceSeq();
    // 后续 getDeviceSeq 命中 cache：getGroups/kvGet 至少不会因 getDeviceSeq 再调用一次以上
    // 由于 getGroups 也会被缓存内嵌调用一次，这里仅断言「重复 getDeviceSeq 不反复扫所有 groups」
    assert.ok(calls >= 1); // 至少一次
    const beforeCalls = calls;
    await reg.getDeviceSeq();
    assert.equal(calls, beforeCalls); // 没有新增读
  });
});