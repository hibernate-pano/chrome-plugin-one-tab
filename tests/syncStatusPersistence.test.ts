// S1 §5: lastSyncStatus 持久化（last_sync_status key，IndexedDB）。
//
// 与 storageHydrate.test.ts 同一套基础设施约定：
// - fake-indexeddb + chrome polyfill + alias loader
// - 不用 deleteDatabase（可能被挂起事务死锁）——beforeEach 只清内存缓存；
//   由于 last_sync_status 是固定 key，额外调用 storage.clear() 重置落盘态，
//   保证每个 test 从干净状态开始。

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import 'fake-indexeddb/auto';

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

before(async () => {
  register(LOADER_PATH);
  (globalThis as any).chrome = {
    runtime: { id: 'test-extension-id-for-sync-status' },
  };
});

beforeEach(async () => {
  // 重置落盘态（固定 key 无法像 group id 那样隔离）
  const { storage } = await import('@/utils/storage');
  await storage.clear();
  // 清 cachedAsyncFn 内存缓存，保证下次读取真实走 IndexedDB
  const { invalidateGroupsCache } = await import('@/utils/storage');
  const { cacheManager } = await import('@/utils/performance');
  invalidateGroupsCache();
  cacheManager.getCache('storage').clear();
});

describe('storage.getLastSyncStatus', () => {
  it('从未同步过 → 默认 { lastSyncAt: null, lastSyncError: null }', async () => {
    const { storage } = await import('@/utils/storage');
    const status = await storage.getLastSyncStatus();
    assert.deepEqual(status, { lastSyncAt: null, lastSyncError: null });
  });

  it('set 全部字段 → get 往返一致', async () => {
    const { storage } = await import('@/utils/storage');
    await storage.setLastSyncStatus({
      lastSyncAt: '2026-08-05T10:00:00.000Z',
      lastSyncError: '同步失败，请稍后重试',
    });
    const status = await storage.getLastSyncStatus();
    assert.deepEqual(status, {
      lastSyncAt: '2026-08-05T10:00:00.000Z',
      lastSyncError: '同步失败，请稍后重试',
    });
  });

  it('partial merge：只写 lastSyncError → lastSyncAt 保留', async () => {
    const { storage } = await import('@/utils/storage');
    await storage.setLastSyncStatus({ lastSyncAt: '2026-08-05T10:00:00.000Z' });
    await storage.setLastSyncStatus({ lastSyncError: '网络连接失败，请检查网络设置' });
    const status = await storage.getLastSyncStatus();
    assert.equal(status.lastSyncAt, '2026-08-05T10:00:00.000Z', '失败不覆盖上次成功时间');
    assert.equal(status.lastSyncError, '网络连接失败，请检查网络设置');
  });

  it('partial merge：只写 lastSyncAt → lastSyncError 保留', async () => {
    const { storage } = await import('@/utils/storage');
    await storage.setLastSyncStatus({ lastSyncError: '同步失败，请稍后重试' });
    await storage.setLastSyncStatus({ lastSyncAt: '2026-08-05T11:00:00.000Z' });
    const status = await storage.getLastSyncStatus();
    assert.equal(status.lastSyncAt, '2026-08-05T11:00:00.000Z');
    assert.equal(status.lastSyncError, '同步失败，请稍后重试');
  });

  it('跨「重启」持久化：清内存缓存后重读仍保留', async () => {
    const { storage } = await import('@/utils/storage');
    await storage.setLastSyncStatus({
      lastSyncAt: '2026-08-05T12:00:00.000Z',
      lastSyncError: null,
    });

    // 模拟 popup 重开：内存缓存全部失效（storage 单例仍是同一模块实例，
    // 但 getLastSyncStatus 本身无内存缓存，每次都真实读盘）
    const { invalidateGroupsCache } = await import('@/utils/storage');
    const { cacheManager } = await import('@/utils/performance');
    invalidateGroupsCache();
    cacheManager.getCache('storage').clear();

    const status = await storage.getLastSyncStatus();
    assert.equal(status.lastSyncAt, '2026-08-05T12:00:00.000Z', '重开后上次同步时间仍可见');
  });

  it('storage.clear() 清掉 last_sync_status → 回默认值', async () => {
    const { storage } = await import('@/utils/storage');
    await storage.setLastSyncStatus({
      lastSyncAt: '2026-08-05T12:00:00.000Z',
      lastSyncError: '同步失败，请稍后重试',
    });
    await storage.clear();
    const status = await storage.getLastSyncStatus();
    assert.deepEqual(status, { lastSyncAt: null, lastSyncError: null });
  });
});
