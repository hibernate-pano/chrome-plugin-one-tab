// runtimeInfo + productEvents 测试
//
// runtimeInfo: chrome.runtime 访问器（带 chrome 不存在时的兜底）
// productEvents: 埋点写入存储

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import 'fake-indexeddb/auto';

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

beforeEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('tabvaultpro');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
  const { invalidateGroupsCache } = await import('@/utils/storage');
  const { cacheManager } = await import('@/utils/performance');
  invalidateGroupsCache();
  cacheManager.getCache('storage').clear();
});

describe('runtimeInfo: 正常 chrome 环境', () => {
  it('getRuntimeManifest 返回 manifest 对象', async () => {
    (globalThis as any).chrome = {
      runtime: {
        id: 'test-id',
        getManifest: () => ({ version: '1.13.5', name: 'TabStack' }),
      },
    };
    const { getRuntimeManifest } = await import('@/utils/runtimeInfo');
    const manifest = getRuntimeManifest();
    assert.ok(manifest);
    assert.equal(manifest!.version, '1.13.5');
    assert.equal(manifest!.name, 'TabStack');
  });

  it('getRuntimeVersion 返回 version 字符串', async () => {
    (globalThis as any).chrome = {
      runtime: {
        id: 'test-id',
        getManifest: () => ({ version: '2.0.0' }),
      },
    };
    const { getRuntimeVersion } = await import('@/utils/runtimeInfo');
    assert.equal(getRuntimeVersion(), '2.0.0');
  });

  it('getAppVersionLabel 返回带 v 前缀', async () => {
    (globalThis as any).chrome = {
      runtime: {
        id: 'test-id',
        getManifest: () => ({ version: '1.13.5' }),
      },
    };
    const { getAppVersionLabel } = await import('@/utils/runtimeInfo');
    assert.equal(getAppVersionLabel(), 'v1.13.5');
  });
});

describe('runtimeInfo: chrome 缺失时的兜底', () => {
  it('chrome 完全不存在 → getRuntimeManifest 返回 null', async () => {
    delete (globalThis as any).chrome;
    const { getRuntimeManifest } = await import('@/utils/runtimeInfo');
    assert.equal(getRuntimeManifest(), null);
  });

  it('chrome.runtime.getManifest 抛错 → 返回 null 不抛', async () => {
    (globalThis as any).chrome = {
      runtime: {
        id: 'test-id',
        getManifest: () => { throw new Error('Not available'); },
      },
    };
    const { getRuntimeManifest } = await import('@/utils/runtimeInfo');
    assert.equal(getRuntimeManifest(), null, 'chrome API 抛错时应兜底返回 null');
  });

  it('manifest 无 version → getRuntimeVersion 返回 0.0.0', async () => {
    (globalThis as any).chrome = {
      runtime: {
        id: 'test-id',
        getManifest: () => ({}),
      },
    };
    const { getRuntimeVersion } = await import('@/utils/runtimeInfo');
    assert.equal(getRuntimeVersion(), '0.0.0');
  });
});

describe('productEvents: trackProductEvent', () => {
  it('成功写入事件', async () => {
    (globalThis as any).chrome = {
      runtime: { id: 'test-id' },
    };
    const { trackProductEvent } = await import('@/utils/productEvents');
    const { storage } = await import('@/utils/storage');

    await trackProductEvent('session_saved', { count: 3 });
    const events = await storage.getProductEvents();
    assert.ok(events.length >= 1);
    const last = events[events.length - 1];
    assert.equal(last.name, 'session_saved');
    assert.deepEqual(last.payload, { count: 3 });
    assert.ok(last.createdAt, 'createdAt 应自动填充');
  });

  it('不传 payload 默认 {}', async () => {
    (globalThis as any).chrome = {
      runtime: { id: 'test-id' },
    };
    const { trackProductEvent } = await import('@/utils/productEvents');
    const { storage } = await import('@/utils/storage');

    await trackProductEvent('onboarding_completed');
    const events = await storage.getProductEvents();
    const last = events[events.length - 1];
    assert.equal(last.name, 'onboarding_completed');
    assert.deepEqual(last.payload, {});
  });

  it('storage 失败不应抛错（埋点是 best-effort）', async () => {
    (globalThis as any).chrome = {
      runtime: { id: 'test-id' },
    };
    const { trackProductEvent } = await import('@/utils/productEvents');
    // mock storage 让其抛错
    const storageMod = await import('@/utils/storage');
    const orig = storageMod.storage.appendProductEvent;
    storageMod.storage.appendProductEvent = async () => { throw new Error('storage broken'); };

    await assert.doesNotThrow(async () => {
      await trackProductEvent('search_performed');
    });

    // 恢复
    storageMod.storage.appendProductEvent = orig;
  });

  it('支持所有事件类型', async () => {
    (globalThis as any).chrome = {
      runtime: { id: 'test-id' },
    };
    const { trackProductEvent } = await import('@/utils/productEvents');

    const eventNames = [
      'onboarding_completed', 'onboarding_skipped',
      'session_saved', 'session_renamed', 'session_restored', 'session_restored_again',
      'search_performed', 'search_filtered',
      'session_favorited', 'session_note_saved',
      'sync_upload_started', 'sync_upload_completed',
      'sync_download_started', 'sync_download_completed',
      'onetab_import_completed',
    ] as const;

    for (const name of eventNames) {
      await assert.doesNotThrow(async () => {
        await trackProductEvent(name);
      }, `${name} 不应抛错`);
    }
  });
});
