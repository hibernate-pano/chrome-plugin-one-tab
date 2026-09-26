// 存储读路径 fail-closed 回归测试。
//
// 背景（数据被整组截断的链路）：
//   indexedDbClient.getItem 的 `catch { return null }` 让「读失败」与「键不存在」同形
//   → storage.getGroups 把一次瞬时 IndexedDB 读错误变成 []
//   （且 cachedAsyncFn 会把 [] 缓存 30s，窗口内每次读都拿到 []）
//   → 所有写路径都是 getGroups() 的读-改-写：
//     mutationHandlers 的 applySaveGroup(groups=[], group) === [group]
//     即整组用户会话被替换成单个新会话，且仍回报 ok:true。
//
// 本文件锁死修复后的语义：
//   1) IndexedDB 读错误必须抛出（不得降级为 null / []）
//   2) open 被 blocked 时必须判失败（否则 promise 永不 settle，kvGet 永久挂起）
//   3) 键真的不存在时仍返回 null（不得过度纠正，把「空」也当错误）
//   4) 读失败时写路径整条失败：setGroups 一次都不许被调用，落盘数据保持原样
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

// ── 内存版 IndexedDB 桩 ────────────────────────────────────────────
// 只需满足 indexedDbClient 用到的那几个面：open / transaction /
// objectStore(get|put|delete) / request.onsuccess|onerror。
// failKeys 里的键：读它时 request 走 onerror（模拟一次真实读失败）。
type Backing = Map<string, unknown>;

function makeRequest(producer: () => unknown) {
  const req: Record<string, unknown> = { result: undefined, error: null };
  queueMicrotask(() => {
    try {
      req.result = producer();
      (req.onsuccess as ((e: unknown) => void) | null)?.({ target: req });
    } catch (error) {
      req.error = error ?? new Error('IndexedDB request failed');
      (req.onerror as ((e: unknown) => void) | null)?.({ target: req });
    }
  });
  return req;
}

function makeFakeIndexedDb(backing: Backing) {
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => undefined,
    close: () => undefined,
    transaction(_storeName: string, _mode: string) {
      const tx: Record<string, unknown> = { error: null };
      tx.objectStore = () => ({
        get(key: string) {
          return makeRequest(() => {
            if (failKeys.has(key)) throw new Error(`simulated read failure: ${key}`);
            return backing.get(key);
          });
        },
        put(record: { key: string; value: unknown }) {
          return makeRequest(() => {
            backing.set(record.key, record);
            return record.key;
          });
        },
        delete(key: string) {
          return makeRequest(() => {
            backing.delete(key);
            return undefined;
          });
        },
      });
      return tx;
    },
  };

  return {
    open() {
      const req: Record<string, unknown> = { result: db, error: null };
      queueMicrotask(() => {
        (req.onupgradeneeded as ((e: unknown) => void) | null)?.({ target: req });
        (req.onsuccess as ((e: unknown) => void) | null)?.({ target: req });
      });
      return req;
    },
  };
}

/** open 永远不 resolve/settle，只 fire onblocked —— 修复前的挂起场景。 */
function makeBlockedIndexedDb() {
  return {
    open() {
      const req: Record<string, unknown> = { result: undefined, error: null };
      queueMicrotask(() => {
        (req.onblocked as ((e: unknown) => void) | null)?.({ target: req });
      });
      return req;
    },
  };
}

const NOW = '2026-09-23T08:00:00.000Z';

function makeGroup(id: string) {
  return {
    id,
    name: `group-${id}`,
    tabs: [],
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    version: 1,
  };
}

// 读失败的键集合（运行时可变：桩在事务发生时读它，不在创建时捕获）。
let failKeys = new Set<string>();

const backing: Backing = new Map();

// 预置三条会话：任何写路径把 groups 读成 [] 再写回，都会把这三条抹掉。
const existing = [makeGroup('g-1'), makeGroup('g-2'), makeGroup('g-3')];
backing.set('tab_groups', { key: 'tab_groups', value: existing });
backing.set('storage_version', { key: 'storage_version', value: 5 });

(globalThis as Record<string, unknown>).window = {
  localStorage: {
    get length() {
      return 0;
    },
    key: () => null,
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
  },
};

const g = globalThis as Record<string, unknown>;

describe('存储读路径 fail-closed', () => {
  before(async () => {
    await register(LOADER_PATH);
  });

  // 必须先于任何一次成功 open：否则模块级 cachedDb 已持有句柄，
  // blocked 场景就再也触发不到。
  it('IndexedDB open 被 blocked 时判失败（修复前 promise 永不 settle）', async () => {
    g.indexedDB = makeBlockedIndexedDb();
    const { indexedDbDriver } = await import('@/storage-kv/indexedDbClient');

    const outcome = await Promise.race([
      indexedDbDriver.getItem('tab_groups').then(
        () => 'resolved',
        () => 'rejected'
      ),
      new Promise<string>(r => setTimeout(() => r('still-pending'), 100)),
    ]);

    assert.equal(outcome, 'rejected', 'blocked open 必须失败，不能永久挂起');
  });

  it('IndexedDB 读错误向上抛出，不得降级为 null', async () => {
    g.indexedDB = makeFakeIndexedDb(backing);
    const { indexedDbDriver } = await import('@/storage-kv/indexedDbClient');

    failKeys = new Set(['tab_groups']);
    let outcome: string;
    try {
      outcome = await indexedDbDriver.getItem('tab_groups').then(
        value => `resolved:${JSON.stringify(value)}`,
        () => 'rejected'
      );
    } finally {
      failKeys = new Set();
    }
    assert.equal(outcome, 'rejected', '读失败必须抛错（修复前返回 null）');

    // 不得过度纠正：键真的不存在时依旧正常返回空值（不是抛错）——
    // 「不存在」与「读失败」必须仍可区分。
    const missing = await indexedDbDriver.getItem('__absent_key__');
    assert.ok(missing == null, '键不存在应正常返回空值，不得变成抛错');
  });

  it('storage.getGroups 在读失败时抛出（不得返回空数组）', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    invalidateGroupsCache();

    // 预热一次成功读，确保缓存里有真实的三条会话
    assert.deepEqual((await storage.getGroups()).map(x => x.id), ['g-1', 'g-2', 'g-3']);

    invalidateGroupsCache();
    let outcome: string;
    try {
      failKeys = new Set(['tab_groups']);
      outcome = await storage.getGroups().then(
        groups => `resolved:${JSON.stringify(groups)}`,
        () => 'rejected'
      );
    } finally {
      failKeys = new Set();
    }

    assert.equal(outcome, 'rejected', 'getGroups 读失败必须抛出（修复前返回 []）');
  });

  it('读失败时保存路径整条失败：setGroups 一次都不调用，落盘数据保持原样', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    const { kvGet, kvSet } = await import('@/storage-kv/storageAdapter');
    const { createMutationHandlers } = await import('@/background/mutationHandlers');
    const { createJournal } = await import('@/utils/journal');
    const { createSeqRegistry } = await import('@/utils/seqRegistry');

    invalidateGroupsCache();

    let setGroupsCalls = 0;
    const journal = createJournal({
      kvGet,
      kvSet,
      getDeviceId: async () => 'device-test',
      nextSeq: async () => 1,
    });
    const seq = createSeqRegistry({ kvGet, kvSet, getGroups: () => storage.getGroups() });

    const handlers = createMutationHandlers({
      getGroups: () => storage.getGroups(),
      setGroups: async groups => {
        setGroupsCalls += 1;
        await storage.setGroupsImmediate(groups);
      },
      scheduleUpload: () => undefined,
      now: () => NOW,
      journal,
      seq,
    });

    let res: Awaited<ReturnType<typeof handlers.handle>>;
    try {
      failKeys = new Set(['tab_groups']);
      res = await handlers.handle({
        op: 'saveGroup',
        group: { ...makeGroup('g-new'), lastOp: { d: 'device-test', s: 1 } },
      } as Parameters<typeof handlers.handle>[0]);
    } finally {
      failKeys = new Set();
    }

    assert.equal(res.ok, false, '读失败时保存必须失败，不得回报 ok:true');
    assert.equal(setGroupsCalls, 0, '读失败时 setGroups 绝不允许被调用（否则整组被截断）');

    // 落盘数据仍是原来三条 —— 没有被替换成单个新会话
    const stored = (await kvGet<Array<{ id: string }>>('tab_groups')) ?? [];
    assert.deepEqual(stored.map(x => x.id), ['g-1', 'g-2', 'g-3'], '用户会话列表未被截断');
  });
});
