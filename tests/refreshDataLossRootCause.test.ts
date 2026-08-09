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
  it('本地 groups 落盘后，刷新后 hydrateAll 能直接读回', async () => {
    const { storage } = await import('@/utils/storage');
    const { kvGet } = await import('@/storage/storageAdapter');

    await storage.setGroups([makeGroup('local-1'), makeGroup('local-2')]);
    const raw = await kvGet('tab_groups');

    // main 的 storage 以加密 blob 落盘（encryptLocalBlob），不再是明文数组。
    // 不变量改为：hydrateAll 能完整 round-trip 读回，而不是断言存储格式。
    assert.ok(raw !== undefined && raw !== null, 'setGroups 后本地应有落盘数据');
    const hydrated = await storage.hydrateAll();
    assert.equal(hydrated.groups.length, 2, '刷新后应读回 2 个会话');
  });

  it('setGroups 立即落盘，不依赖防抖窗口', async () => {
    const { storage } = await import('@/utils/storage');
    const { kvGet } = await import('@/storage/storageAdapter');

    await storage.setGroups([makeGroup('immediate-1')]);
    const raw = await kvGet('tab_groups');

    // setGroups 是同步写盘（persistEncryptedGroups），不是 debounce 后写。
    assert.ok(raw !== undefined && raw !== null, 'setGroups 后立即有落盘数据');
    const groups = await storage.getGroups();
    assert.equal(groups[0].id, 'immediate-1', '立即读取应拿到刚写入的会话');
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

  it('hydrateAll 读失败时返回空数组但不固化缓存，避免伪装成真空', async () => {
    const { storage } = await import('@/utils/storage');
    const { cacheManager } = await import('@/utils/performance');

    await corruptStoredGroups();
    const hydrated = await storage.hydrateAll();

    // HydrateResult 不再有 groupsReadFailed 字段（main 的接口），
    // 但「读失败不能被当成空数据缓存」的不变量仍在：
    assert.equal(hydrated.groups.length, 0, '失败时返回空数组只用于调用方判断，不直接展示');
    // 关键：失败的读取结果不能进入缓存 —— 下次 getGroupsOrThrow 仍会重新读盘并抛错。
    assert.equal(
      cacheManager.getCache('storage').get('groups'),
      undefined,
      '读失败不应被缓存为“空数据”'
    );
    await assert.rejects(
      storage.getGroupsOrThrow(),
      /读取本地会话失败/,
      '读失败状态应持续可被 getGroupsOrThrow 发现'
    );
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

  it('preserveUndecryptableGroups 保留原始 blob，不直接覆盖', async () => {
    const { storage } = await import('@/utils/storage');
    const { kvGet } = await import('@/storage/storageAdapter');

    await corruptStoredGroups();
    const preserved = await storage.preserveUndecryptableGroups();

    assert.equal(preserved, true, '存在原始 blob 时应备份成功');
    assert.equal(
      await kvGet('tab_groups_legacy_backup'),
      'corrupt-local-blob',
      '旧 blob 必须原样保留到备份 key'
    );
  });

  it('保存新会话时，旧数据读不出也必须能继续收纳当前标签', async () => {
    const { storage } = await import('@/utils/storage');
    const { kvGet } = await import('@/storage/storageAdapter');
    const { tabManager } = await import('@/background/TabManager');

    await corruptStoredGroups();

    (globalThis as any).chrome = {
      ...(globalThis as any).chrome,
      runtime: {
        id: 'test-ext-id',
        getURL: (path: string) => path,
        sendMessage: async () => ({}),
      },
      notifications: {
        create: async () => {},
      },
      tabs: {
        create: async () => ({}),
        remove: async () => {},
        query: async () => [],
      },
      storage: {
        local: {
          get: async () => ({}),
          set: async () => {},
          remove: async () => {},
        },
      },
    };

    await tabManager.saveAllTabs([
      {
        id: 1,
        url: 'https://example.com/new-tab',
        title: 'New Tab',
      } as any,
    ]);

    const groups = await storage.getGroupsOrThrow();
    assert.equal(groups.length, 1, '即使旧数据无法解密，也应保存当前标签为新会话');
    assert.equal(
      await kvGet('tab_groups_legacy_backup'),
      'corrupt-local-blob',
      '旧 blob 必须继续保留在备份 key'
    );
  });
});
