/**
 * PERF-04：存储初始化的 **single-flight**（2026-10-24 审计）。
 *
 * ── 这条防的具体事故 ────────────────────────────────────────────────────
 *
 * `ensureInitialized` 修复前长这样：
 *
 *     if (initialized) return;
 *     backend = pickBackend();
 *     driver = …;
 *     if (backend === 'indexeddb') { await migrate…; await migrate…; }
 *     initialized = true;          // ← 两个 await **之后**才置位
 *
 * ⇒ 同一次启动里并发发起的 4 个调用都看到 `initialized === false`
 * ⇒ 各自从头跑一遍整表迁移（`chrome.storage.local.get(25 键)` ×4、
 * `migration_flags` 读 ×8、稳态 popup realm 共 14 个 IndexedDB 事务）。
 * Service Worker 是独立 realm、另有 1 份 ⇒ 升级路径上 **≥5 份并发整表迁移**。
 *
 * ── 怎么量 ──────────────────────────────────────────────────────────────
 *
 * 「迁移跑了几轮」在外部唯一可观察的着落点是 **`chrome.storage.local.get`
 * 被调用了几次**（每轮迁移读一次源）。
 * ⇒ 并发发起 8 次初始化，断言它只被调用 **1** 次（修复前是 8 次）。
 *
 * ⚠️ 必须用**真正可用的** IndexedDB 桩（内存版）：桩若一读就失败，
 * 迁移会在第一次读时就抛，`chrome.storage.local.get` 根本到不了 ⇒
 * 计数恒为 0 ⇒ 这条断言变成「0 === 1 恒假」或「0 === 0 恒真」。
 * 见 tests/storageFailClosed.test.ts 的同一套桩（本仓既有的做法）。
 *
 * ⚠️ 每个用例需要一份**全新的模块实例**（`initialized` 是模块级状态）⇒
 * 用带查询串的动态 import 拿独立实例（Node 的模块标识含查询串）。
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/** 内存版 IndexedDB（只满足 indexedDbClient 用到的那几个面）。 */
type Backing = Map<string, unknown>;

let failNextGet = false;

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
    transaction() {
      const tx: Record<string, unknown> = { error: null };
      tx.objectStore = () => ({
        get(key: string) {
          return makeRequest(() => {
            if (failNextGet) throw new Error('simulated IndexedDB read failure');
            return backing.get(key);
          });
        },
        put(record: { key: string; value: unknown }) {
          return makeRequest(() => {
            backing.set(record.key, record);
            return undefined;
          });
        },
        delete(key: string) {
          return makeRequest(() => {
            backing.delete(key);
            return undefined;
          });
        },
      });
      tx.abort = () => undefined;
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

// ── 环境桩 ──────────────────────────────────────────────────────────────
const idbBacking: Backing = new Map();
const chromeBacking = new Map<string, unknown>([
  ['tab_groups', [{ id: 'g1', name: '来自 chrome.storage 的旧会话', tabs: [] }]],
]);
let chromeGetCalls = 0;

function installEnvironment(): void {
  const g = globalThis as Record<string, unknown>;
  g['indexedDB'] = makeFakeIndexedDb(idbBacking);
  g['chrome'] = {
    storage: {
      local: {
        get: async (keys: string[] | string) => {
          chromeGetCalls += 1;
          const wanted = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const key of wanted) {
            if (chromeBacking.has(key)) out[key] = chromeBacking.get(key);
          }
          return out;
        },
        set: async () => undefined,
        remove: async (keys: string[] | string) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) chromeBacking.delete(key);
        },
      },
    },
  };
}

describe('PERF-04：并发初始化只跑一次迁移', () => {
  before(() => {
    installEnvironment();
  });

  beforeEach(() => {
    chromeGetCalls = 0;
    failNextGet = false;
  });

  it('8 个并发调用共享同一次初始化（迁移只跑 1 次）', async () => {
    // @ts-expect-error 查询串是 Node 的「独立模块实例」手法（TS 不认这种说明符）
    const adapter = await import('../../src/storage-kv/storageAdapter.ts?single-flight=1');

    const backends = await Promise.all(
      Array.from({ length: 8 }, () => adapter.initStorage())
    );

    assert.equal(
      chromeGetCalls,
      1,
      '并发初始化必须只跑一次迁移 —— 修复前 8 个并发调用各跑一遍（读写放大 8 倍）'
    );
    assert.deepEqual(
      backends,
      Array(8).fill('indexeddb'),
      '每个调用者都要拿到同一个后端选择'
    );
    // 顺带确认迁移**真的跑完了**（否则「只跑一次」可能是「一次都没跑」）。
    const migrated = await adapter.kvGet('tab_groups');
    assert.deepEqual(
      migrated,
      [{ id: 'g1', name: '来自 chrome.storage 的旧会话', tabs: [] }],
      '迁移的结果必须真的落在 KV 里'
    );
  });

  it('初始化失败后下一次调用会重试（失败的 promise 不许被永久缓存）', async () => {
    // @ts-expect-error 查询串是 Node 的「独立模块实例」手法（TS 不认这种说明符）
    const adapter = await import('../../src/storage-kv/storageAdapter.ts?retry=1');

    // 第一次：IndexedDB 读失败 ⇒ 初始化必须**失败**（不是静默跳过）。
    failNextGet = true;
    await assert.rejects(
      () => adapter.initStorage(),
      '初始化读失败时必须拒绝，不能把失败当成功'
    );

    // 第二次：故障恢复 ⇒ 必须**重新初始化**（若把失败的 promise 缓存住，
    // 这里会立刻重放同一个拒绝 ⇒ 这个 realm 永久坏掉）。
    failNextGet = false;
    await adapter.initStorage();
    const migrated = await adapter.kvGet('tab_groups');
    assert.ok(migrated, '初始化失败后重试必须真的跑完迁移（而不是重放旧失败）');
  });
});
