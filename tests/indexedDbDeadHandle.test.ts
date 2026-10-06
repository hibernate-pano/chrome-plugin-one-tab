// IndexedDB 死句柄看门狗回归（2026-10-06）。
//
// 【要钉死的失效模式】MV3 的 Service Worker 空闲约 30s 被 Chrome 回收，
// 浏览器单方面关闭 IndexedDB 连接，但 JS 变量仍指向那条死句柄。
// 在死句柄上 `db.transaction()` **既不 resolve 也不 reject** → 调用方 Promise
// 永久挂起。
//
// 为什么它能解释用户看到的全部症状：
//   - popup 侧的 30s 协议超时只是「不等了」，SW 里的任务仍在挂起；
//   - 单写者队列 mutationQueue 的 running 标志由 await 驱动，挂起 ⇒ 永为 true
//     ⇒ 之后所有语义命令与同步任务都排在它后面，整条链路死锁；
//   - 于是「清理重复标签」「删除」「移动」一律「点不动」，约 30s 后报超时，
//     与线上日志 `removeTab.wait 34939ms` 的量级完全吻合。
//
// 修复不是「让挂起恢复」（死句柄无法被唤醒），而是「到点判失败 + 丢弃句柄 +
// 下次重新 open」：一次操作失败可以重试，永久挂起不能。
//
// 本文件钉死四件事：
//   1) 请求永不回调 → 到点抛错（fail-closed，绝不静默返回 null/[]）
//   2) 抛错后句柄被丢弃：下一次调用能重新 open 并成功（可恢复，不是死路）
//   3) 正常事务不受看门狗影响，且不留存活定时器
//   4) settle 只认第一次：请求成功后到达的 onabort 不得二次 reject
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

const g = globalThis as Record<string, unknown>;

/**
 * 可配置的 IndexedDB 桩。
 *
 * hangKeys：读它时 request **永不 settle**（既不 onsuccess 也不 onerror）——
 * 精确复现死句柄：db.transaction() 建立成功，但事件永不到来。
 * deadFirstHandle：第一次 open 返回一条「已死」的句柄（transaction() 直接抛），
 * 模拟浏览器单方面关闭后的第一次调用。
 */
let hangKeys = new Set<string>();
let openCount = 0;
let deadFirstHandle = false;
const backing = new Map<string, unknown>();

function makeRequest(producer: () => unknown, hang = false) {
  const req: Record<string, unknown> = { result: undefined, error: null };
  if (hang) return req; // 永不 settle
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

function makeFakeIndexedDb() {
  return {
    open() {
      openCount += 1;
      const isFirst = openCount === 1;
      const dead = deadFirstHandle && isFirst;
      const db = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => undefined,
        close: () => undefined,
        transaction() {
          // 浏览器单方面关闭连接后再建事务：真实实现抛 InvalidStateError。
          if (dead) throw new Error('The database connection is closing');
          const tx: Record<string, unknown> = { error: null };
          tx.abort = () => {
            // 真实实现在 abort 后触发 onabort；桩里同样触发，
            // 用于验证 settle 门不会让二次回调造成二次 reject。
            queueMicrotask(() => {
              (tx.onabort as ((e: unknown) => void) | null)?.({ target: tx });
            });
          };
          tx.objectStore = () => ({
            get(key: string) {
              return makeRequest(() => backing.get(key), hangKeys.has(key));
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
      const req: Record<string, unknown> = { result: db, error: null };
      queueMicrotask(() => {
        (req.onupgradeneeded as ((e: unknown) => void) | null)?.({ target: req });
        (req.onsuccess as ((e: unknown) => void) | null)?.({ target: req });
      });
      return req;
    },
  };
}

g.indexedDB = makeFakeIndexedDb();
g.window = {
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

describe('IndexedDB 死句柄看门狗：挂起必须变成可重试的失败', () => {
  before(async () => {
    await register(LOADER_PATH);
  });

  beforeEach(() => {
    hangKeys = new Set();
    deadFirstHandle = false;
    openCount = 0;
  });

  it('请求永不回调时按上限抛错，而不是永久挂起', async () => {
    const { indexedDbDriver } = await import('@/storage-kv/indexedDbClient');
    hangKeys = new Set(['tab_groups']);

    const started = Date.now();
    const outcome = await indexedDbDriver.getItem('tab_groups').then(
      (v: unknown) => ({ kind: 'resolved' as const, v }),
      (e: unknown) => ({ kind: 'rejected' as const, e })
    );
    const elapsed = Date.now() - started;

    assert.equal(outcome.kind, 'rejected', '死句柄上的请求不得永久挂起（那会锁死单写者队列）');
    assert.match(String((outcome as { e: Error }).e.message), /超时|无响应/);
    // fail-closed 的关键：绝不能把挂起/失败降级成 null（「键不存在」）——
    // 那会让 storage.getGroups 把一次故障读成 []，下一次写就把整组会话抹掉。
    assert.equal('v' in outcome, false, '失败分支不得带出 value（不得降级为 null/[]）');
    assert.ok(elapsed >= 4_000, `应在上限附近才失败（实际 ${elapsed}ms），不能立刻假失败`);
  });

  it('失败后句柄被丢弃：下一次调用能重新 open 并成功（不是死路）', async () => {
    const { indexedDbDriver } = await import('@/storage-kv/indexedDbClient');
    backing.set('tab_groups', { key: 'tab_groups', value: [{ id: 'g-1' }] });

    // 第一条句柄是死的：transaction() 直接抛（浏览器已单方面关闭）
    deadFirstHandle = true;
    await indexedDbDriver
      .getItem('tab_groups')
      .then(() => undefined, () => undefined);
    assert.equal(openCount, 1, '第一次应只 open 一次并在事务处失败');

    // 第二次：看门狗已丢弃坏句柄 → 重新 open → 正常读到数据
    const v = await indexedDbDriver.getItem('tab_groups');
    assert.equal(openCount, 2, '坏句柄必须被丢弃并重新 open');
    assert.deepEqual(v, [{ id: 'g-1' }], '重新 open 后应能正常读到数据（故障可自愈）');
  });

  it('正常事务照常工作，不受看门狗影响', async () => {
    const { indexedDbDriver } = await import('@/storage-kv/indexedDbClient');
    backing.set('tab_groups', { key: 'tab_groups', value: [{ id: 'g-ok' }] });

    const v = await indexedDbDriver.getItem('tab_groups');
    assert.deepEqual(v, [{ id: 'g-ok' }]);
    await indexedDbDriver.setItem('user_settings', { themeMode: 'dark' });
    assert.deepEqual(await indexedDbDriver.getItem('user_settings'), { themeMode: 'dark' });
  });

  it('键不存在仍返回 null（看门狗不得把「空」误判成错误）', async () => {
    const { indexedDbDriver } = await import('@/storage-kv/indexedDbClient');
    // 桩里 get 返回 undefined（真实 IndexedDB 对不存在的键也是 undefined），
    // 驱动的 getItem 原样透传。关键断言是「不抛错」——看门狗不得把「空」
    // 误判成故障，那会让每次读空键都失败。
    const v = await indexedDbDriver.getItem('__absent__');
    assert.equal(v ?? null, null, '键不存在不得抛错（fail-closed 只针对真故障）');
  });
});
