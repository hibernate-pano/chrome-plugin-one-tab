// 回归（2026-10-04）：「清理重复标签点击后卡住」的根因是删除广播登记逐条做
// 读-改-写整队列，N 条 = 2N 次 IndexedDB 往返 + 2N 次整队列序列化（实测 2000 条
// 约 9 秒）。修复引入 addPendingDeleteIds 批量登记，本文件钉死其语义与逐条版一致：
//   1) 一次登记多条，全部进队列；
//   2) 去重（已在队列里的不重复），且不改变既有顺序；
//   3) 与逐条登记结果等价；
//   4) KV 写失败时**整批**进内存兜底并抛错，一条都不能被静默丢弃。
//
// 环境桩沿用 pendingDeleteIntentDurability.test.ts：无 indexedDB → KV 走 localStorage
// 驱动，对 'pending_delete_ids' 键注入写失败以复现内存兜底路径。

import { describe, it, before, beforeEach } from 'node:test';
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

const KV_DELETE = 'pending_delete_ids';
const failKeys = new Set<string>();
const lsData = new Map<string, string>();
// 统计 KV 往返次数：批量登记的意义就是把它从 O(N) 降到 O(1)。
let kvWriteCount = 0;

const localStorageStub = {
  get length() { return lsData.size; },
  key: (i: number) => [...lsData.keys()][i] ?? null,
  getItem: (k: string) => (lsData.has(k) ? (lsData.get(k) as string) : null),
  setItem: (k: string, v: string) => {
    if (failKeys.has(k)) throw new Error(`simulated write failure: ${k}`);
    if (k === KV_DELETE) kvWriteCount += 1;
    lsData.set(k, String(v));
  },
  removeItem: (k: string) => {
    if (failKeys.has(k)) throw new Error(`simulated write failure: ${k}`);
    lsData.delete(k);
  },
  clear: () => lsData.clear(),
};
(globalThis as Record<string, unknown>).window = { localStorage: localStorageStub };
(globalThis as Record<string, unknown>).localStorage = localStorageStub;
(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: { get: async () => ({}), set: async () => undefined, remove: async () => undefined },
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  },
};

let storage: typeof import('../src/utils/storage.ts').storage;

function sortedUnique(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

async function resetQueue(): Promise<void> {
  const current = await storage.getPendingDeleteIds();
  await storage.clearPendingDeleteIds(current);
}

before(async () => {
  register(LOADER_PATH, import.meta.url);
  ({ storage } = await import('../src/utils/storage.ts'));
  await storage.getPendingDeleteIds();
});

beforeEach(async () => {
  await resetQueue();
  kvWriteCount = 0;
});

describe('addPendingDeleteIds：批量登记与逐条等价', () => {
  it('一次登记多条，全部进队列', async () => {
    await storage.addPendingDeleteIds(['a', 'b', 'c']);
    assert.deepEqual(sortedUnique(await storage.getPendingDeleteIds()), ['a', 'b', 'c']);
  });

  it('去重：已在队列里的不重复添加，且保留既有顺序', async () => {
    await storage.addPendingDeleteId('a');
    await storage.addPendingDeleteIds(['a', 'b', 'a', 'c']);
    const ids = await storage.getPendingDeleteIds();
    assert.deepEqual(ids, ['a', 'b', 'c'], '去重后应保持 a 在前，且不重复');
  });

  it('空数组 / 全非法项 → 无写入', async () => {
    await storage.addPendingDeleteIds([]);
    assert.deepEqual(await storage.getPendingDeleteIds(), []);
    assert.equal(kvWriteCount, 0, '空输入不得产生 KV 写');
  });

  it('结果与逐条登记完全一致（等价性）', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `g-${i % 7}-${i}`);
    await storage.addPendingDeleteIds(ids);
    const batched = sortedUnique(await storage.getPendingDeleteIds());

    await resetQueue();
    for (const id of ids) await storage.addPendingDeleteId(id);
    const oneByOne = sortedUnique(await storage.getPendingDeleteIds());

    assert.deepEqual(batched, oneByOne);
  });

  it('批量登记只产生 O(1) 次 KV 写（不是 O(N)）——这正是卡顿的根因', async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `g-${i}`);
    await storage.addPendingDeleteIds(ids);
    assert.equal(kvWriteCount, 1, `批量登记 300 条应只写 1 次队列（实得 ${kvWriteCount}）`);
  });
});

describe('addPendingDeleteIds：写失败时整批保留（不得静默丢弃）', () => {
  it('KV 写失败 → 抛错，且整批 id 都在广播队列里（内存兜底）', async () => {
    failKeys.add(KV_DELETE);
    let rejected = false;
    try {
      await storage.addPendingDeleteIds(['x', 'y', 'z']);
    } catch {
      rejected = true;
    } finally {
      failKeys.delete(KV_DELETE);
    }
    assert.equal(rejected, true, '写失败必须抛错，不能谎报登记成功');
    assert.deepEqual(
      sortedUnique(await storage.getPendingDeleteIds()),
      ['x', 'y', 'z'],
      '整批 id 都要留在队列里（内存兜底），一条都不能丢',
    );
  });
});
