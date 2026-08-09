// S2 P1 Task 1.3: storage.hydrateAll() 单源化 bootstrap
//
// hydrateAll 在 S1/S2 共写合同中定义为单次 Promise.all 读取 groups + settings +
// lastLoadedAt；目的是让 popup bootstrap 路径只读一次 storage（之前是
// Promise.all([getGroups, getSettings])，但仍是「散读」），并显式声明
// 缓存命中语义（第二次调用应该 < 5ms，因为走 cachedAsyncFn 内存缓存）。
//
// 关键不变量：hydrateAll 不会改变 storage 的 IO 语义，只是包了一层
// Promise.all。getGroups / getSettings 仍然走各自的 cachedAsyncFn 缓存，
// 所以二次调用本质上从内存命中（解密 / IndexedDB getItem 都不再发生）。
//
// 注意：beforeEach 故意不调 indexedDB.deleteDatabase。原因：
//   storage.hydrateAll() = Promise.all([getGroups(), getSettings()])。
//   getSettings() 在 settings 不存在时**会**内部触发 setSettings 写盘
//   （修正 themeMode/themeStyle 默认值），走 500ms debounce 后再开一个
//   IndexedDB 事务。如果此时再 deleteDatabase，fake-indexeddb 的
//   deleteDatabase 会与该挂起事务互锁（onblocked 触发后程序死锁）。
//   解法：不清 IndexedDB，只清 cachedAsyncFn 的内存缓存。每个 test 用不
//   同的 group id 区分。test 4 的「second call is fast」依赖于此设计。

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import 'fake-indexeddb/auto';

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

const TEST_EXTENSION_ID = 'test-extension-id-for-hydrate-tests';
const NOW = '2026-08-05T00:00:00.000Z';

before(async () => {
  register(LOADER_PATH);
  (globalThis as any).chrome = {
    runtime: { id: TEST_EXTENSION_ID },
  };
});

beforeEach(async () => {
  // 清 cachedAsyncFn 持有的内存缓存（getGroups / getSettings 都用此缓存）
  // — 这样下一个 test 一定会从 IndexedDB 真实读盘，覆盖 hydrateAll 的
  // 「单次 IO 路径」。
  const { invalidateGroupsCache } = await import('@/utils/storage');
  const { cacheManager } = await import('@/utils/performance');
  invalidateGroupsCache();
  cacheManager.getCache('storage').clear();
});

describe('storage.hydrateAll', () => {
  it('空存储时返回默认：groups=[], settings=object, lastLoadedAt=null', async () => {
    const { storage } = await import('@/utils/storage');
    const r = await storage.hydrateAll();
    assert.deepEqual(r.groups, []);
    assert.equal(typeof r.settings, 'object');
    assert.equal(r.lastLoadedAt, null);
  });

  it('读取已存在的 groups', async () => {
    const { storage } = await import('@/utils/storage');
    await storage.setGroups([
      {
        id: 'g-hydrate-1',
        name: 'g-hydrate-1',
        tabs: [],
        isFavorite: false,
        isLocked: false,
        isDeleted: false,
        createdAt: NOW,
        updatedAt: NOW,
        displayOrder: 0,
      } as any,
    ]);
    const r = await storage.hydrateAll();
    assert.equal(r.groups.length, 1);
    assert.equal(r.groups[0].id, 'g-hydrate-1');
  });

  it('读取已存在的 settings', async () => {
    const { storage } = await import('@/utils/storage');
    await storage.setSettings({ themeMode: 'dark', themeStyle: 'aurora' } as any);
    const r = await storage.hydrateAll();
    assert.equal(r.settings.themeMode, 'dark');
    assert.equal(r.settings.themeStyle, 'aurora');
  });

  it('第二次调用命中 cachedAsyncFn 内存缓存（< 50ms）', async () => {
    const { storage } = await import('@/utils/storage');
    // 第一次：真实读盘（IndexedDB getItem + 可能的解密）
    await storage.hydrateAll();
    // 第二次：两个 cachedAsyncFn 全部命中，Promise.all 本身也只是个 microtask
    const t0 = Date.now();
    await storage.hydrateAll();
    const elapsed = Date.now() - t0;
    assert.ok(
      elapsed < 50,
      `hydrateAll second call should be cache-fast, was ${elapsed}ms`
    );
  });
});
