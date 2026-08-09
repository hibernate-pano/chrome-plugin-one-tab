import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import 'fake-indexeddb/auto';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub',
  DEV: false,
  MODE: 'test',
};

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

const NOW = '2026-08-09T08:00:00.000Z';

function makeGroup(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Group ${id}`,
    tabs: [
      {
        id: `${id}-t1`,
        url: `https://example.com/${id}`,
        title: id,
        createdAt: NOW,
        lastAccessed: NOW,
        pinned: false,
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    isFavorite: false,
    isDeleted: false,
    version: 1,
    displayOrder: 0,
    ...overrides,
  };
}

async function clearStorageState() {
  const { storage } = await import('@/utils/storage');
  const { cacheManager } = await import('@/utils/performance');
  await storage.clear();
  cacheManager.getCache('storage').clear();
}

async function corruptStoredGroups() {
  const { cacheManager } = await import('@/utils/performance');
  const { kvSet } = await import('@/storage/storageAdapter');
  cacheManager.getCache('storage').clear();
  await kvSet('tab_groups', 'corrupt-local-blob');
  cacheManager.getCache('storage').clear();
}

before(async () => {
  register(LOADER_PATH);
  (globalThis as any).chrome = { runtime: { id: 'test-ext-id' } };
});

beforeEach(clearStorageState);

describe('刷新数据丢失根因：读失败不能被当成空数据', () => {
  it('本地 groups 以明文数组落盘，刷新后 hydrateAll 能直接读回', async () => {
    const { storage } = await import('@/utils/storage');
    const { kvGet } = await import('@/storage/storageAdapter');

    await storage.setGroups([makeGroup('local-1'), makeGroup('local-2')]);
    const raw = await kvGet('tab_groups');

    assert.equal(Array.isArray(raw), true, '本地 groups 应为可直读的明文数组');
    const hydrated = await storage.hydrateAll();
    assert.equal(hydrated.groups.length, 2, '刷新后应读回 2 个会话');
    assert.notEqual(hydrated.groupsReadFailed, true, '正常读盘不应标记为失败');
  });

  it('setGroups 立即落盘，不依赖防抖窗口', async () => {
    const { storage } = await import('@/utils/storage');
    const { kvGet } = await import('@/storage/storageAdapter');

    await storage.setGroups([makeGroup('immediate-1')]);
    const raw = await kvGet('tab_groups');

    assert.equal(Array.isArray(raw), true);
    assert.equal((raw as Array<{ id: string }>)[0].id, 'immediate-1');
  });

  it('getGroupsOrThrow 能区分“确实为空”和“读取失败”', async () => {
    const { storage } = await import('@/utils/storage');

    assert.deepEqual(await storage.getGroupsOrThrow(), [], '确实为空应返回空数组');

    await corruptStoredGroups();
    await assert.rejects(
      storage.getGroupsOrThrow(),
      /读取本地会话失败/,
      '损坏数据不能被吞成空数组'
    );
  });

  it('hydrateAll 读失败时返回 groupsReadFailed，而不是伪装成真空', async () => {
    const { storage } = await import('@/utils/storage');

    await corruptStoredGroups();
    const hydrated = await storage.hydrateAll();

    assert.equal(hydrated.groupsReadFailed, true, '读失败必须显式标记');
    assert.equal(hydrated.groups.length, 0, '失败时返回空数组只用于调用方判断，不直接展示');
  });

  it('loadGroups 读失败必须 reject，不能固化 lastLoadedAt', async () => {
    const { storage } = await import('@/utils/storage');
    const { createStore } = await import('@/store');
    const { initialTabState, loadGroups } = await import('@/store/slices/tabSlice');

    await corruptStoredGroups();

    const store = createStore({
      tabs: { ...initialTabState },
    });

    const result = await store.dispatch(loadGroups() as any);
    const state = store.getState().tabs;

    assert.equal(result.type, 'tabs/loadGroups/rejected', '读失败必须 reject');
    assert.equal(state.lastLoadedAt, null, '读失败不能标记为已加载');
    assert.ok(state.error, '应暴露可重试错误');
  });

  it('loadGroups 成功后设置 lastLoadedAt，TabList 可跳过重复加载', async () => {
    const { storage } = await import('@/utils/storage');
    const { createStore } = await import('@/store');
    const { initialTabState, loadGroups } = await import('@/store/slices/tabSlice');

    await storage.setGroups([makeGroup('loaded-1')]);
    const store = createStore({
      tabs: { ...initialTabState },
    });

    const result = await store.dispatch(loadGroups() as any);
    const state = store.getState().tabs;

    assert.equal(result.type, 'tabs/loadGroups/fulfilled');
    assert.equal(state.groups.length, 1);
    assert.notEqual(state.lastLoadedAt, null, '成功后应固化已加载状态');
  });
});
