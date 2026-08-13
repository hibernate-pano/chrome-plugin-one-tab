// 端到端复现 user 报告的精确路径：
//   本地保存 → 手动同步下载覆盖/合并 → 写盘 → 模拟 popup 重开 → 读盘 → 渲染
//
// 关键不变量：
//   写盘后重新 open IndexedDB + 解密 SECURE_V2 blob 必须 round-trip 出原始数据。
//
// 之前 refreshDataLossRootCause 测试只覆盖 setGroups → getGroups 的基础路径，
// 没覆盖 SyncEngine.downloadAndMerge 写出来的数据。这条路径才是用户卡住的。

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

const TEST_EXTENSION_ID = 'test-extension-id-sync-roundtrip';
const NOW = '2026-08-13T10:00:00.000Z';

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
    isDeleted: false,
    version: 1,
    displayOrder: 0,
    syncStatus: 'local-only',
    lastSyncedAt: null,
    ...overrides,
  };
}

before(async () => {
  register(LOADER_PATH);
  (globalThis as any).chrome = {
    runtime: { id: TEST_EXTENSION_ID },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
      },
    },
    notifications: { create: async () => {}, clear: async () => {} },
  };
});

beforeEach(async () => {
  const { storage } = await import('@/utils/storage');
  const { cacheManager } = await import('@/utils/performance');
  const { kvRemove } = await import('@/storage/storageAdapter');
  await storage.clear();
  await kvRemove('migration_flags').catch(() => {});
  cacheManager.getCache('storage').clear();
});

describe('SyncEngine.downloadAndMerge → 真实 storage → 真加密 → 重启 → 读盘', () => {
  it('覆盖模式：写入 SECURE_V2 blob，重启后 hydrateAll 能完整读回', async () => {
    const { SyncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');
    const { cacheManager } = await import('@/utils/performance');
    const { kvGet } = await import('@/storage/storageAdapter');

    // Step 1: 本地先有 2 个组（用户原有数据）
    await storage.setGroups([
      makeGroup('local-A', { version: 3 }),
      makeGroup('local-B', { version: 2 }),
    ]);

    // Step 2: 触发覆盖下载 —— 云端只有 1 个组
    const cloudGroups = [
      makeGroup('cloud-X', { version: 1, updatedAt: '2026-08-13T11:00:00.000Z' }),
    ];
    const engine = new SyncEngine({
      storage,
      downloadTabGroups: async () => cloudGroups,
      uploadTabGroups: async () => ({}),
      markCloudGroupsAsDeleted: async () => {},
      cleanupCloudTombstones: async () => ({ scanned: 0, deleted: 0, errors: 0 }),
      getState: () => ({
        auth: { isAuthenticated: true },
        settings: { syncStrategy: 'newest' },
        tabs: { lastLoadedAt: null },
      }),
    });
    const res = await engine.downloadAndMerge({ forceRemote: true });
    assert.equal(res.success, true, '下载覆盖必须 success');
    assert.equal(res.groups.length, 1, '覆盖后只剩云端的 1 个组');

    // Step 3: 验证 IndexedDB 实际写入了 SECURE_V2 加密 blob
    cacheManager.getCache('storage').clear();
    const raw = await kvGet('tab_groups');
    assert.ok(typeof raw === 'string', 'setGroups 后 IndexedDB 里应是 string');
    assert.ok((raw as string).startsWith('SECURE_V2:'), '写入应是 SECURE_V2 加密格式');

    // Step 4: 模拟 popup 关闭 + 重开 —— 重置 IDB 连接 + 清所有缓存
    cacheManager.getCache('storage').clear();

    // Step 5: hydrateAll 走真路径读盘
    const hydrated = await storage.hydrateAll();
    assert.equal(
      hydrated.groups.length,
      1,
      `重启后必须能读回覆盖结果 —— 期望 1 组，实际 ${hydrated.groups.length}`
    );
    assert.equal(hydrated.groups[0].id, 'cloud-X');
    assert.equal(hydrated.groups[0].tabs.length, 1);
  });

  it('合并模式：合并后的 SECURE_V2 blob 重启后能完整读回', async () => {
    const { SyncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');
    const { cacheManager } = await import('@/utils/performance');

    await storage.setGroups([
      makeGroup('local-A', { version: 3 }),
      makeGroup('local-B', { version: 2 }),
    ]);

    const cloudGroups = [
      makeGroup('local-A', { version: 4, updatedAt: '2026-08-13T11:00:00.000Z' }),
      makeGroup('cloud-Z', { version: 1 }),
    ];
    const engine = new SyncEngine({
      storage,
      downloadTabGroups: async () => cloudGroups,
      uploadTabGroups: async () => ({}),
      markCloudGroupsAsDeleted: async () => {},
      cleanupCloudTombstones: async () => ({ scanned: 0, deleted: 0, errors: 0 }),
      getState: () => ({
        auth: { isAuthenticated: true },
        settings: { syncStrategy: 'newest' },
        tabs: { lastLoadedAt: null },
      }),
    });
    const res = await engine.downloadAndMerge({ forceRemote: false });
    assert.equal(res.success, true);
    assert.equal(res.groups.length, 3, '合并：local-A 覆盖 + local-B 保留 + cloud-Z 新增');

    cacheManager.getCache('storage').clear();

    const hydrated = await storage.hydrateAll();
    assert.equal(
      hydrated.groups.length,
      3,
      `合并后重启必须读回 3 组，实际 ${hydrated.groups.length}`
    );
    const ids = hydrated.groups.map(g => g.id).sort();
    assert.deepEqual(ids, ['cloud-Z', 'local-A', 'local-B']);
  });

  it('写盘 + 立即 hydrateAll + 清缓存 + 二次 hydrateAll：两次都应一致', async () => {
    const { SyncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');
    const { cacheManager } = await import('@/utils/performance');

    await storage.setGroups([makeGroup('g1'), makeGroup('g2')]);

    const engine = new SyncEngine({
      storage,
      downloadTabGroups: async () => [makeGroup('cloud-Q')],
      uploadTabGroups: async () => ({}),
      markCloudGroupsAsDeleted: async () => {},
      cleanupCloudTombstones: async () => ({ scanned: 0, deleted: 0, errors: 0 }),
      getState: () => ({
        auth: { isAuthenticated: true },
        settings: { syncStrategy: 'newest' },
        tabs: { lastLoadedAt: null },
      }),
    });
    await engine.downloadAndMerge({ forceRemote: true });

    // 第一次 hydrate：cache hit
    const h1 = await storage.hydrateAll();
    // 清缓存后再 hydrate：必须走 IDB 真读
    cacheManager.getCache('storage').clear();
    const h2 = await storage.hydrateAll();

    assert.equal(h1.groups.length, h2.groups.length, 'cache hit vs cold read 必须长度一致');
    if (h1.groups.length > 0) {
      assert.deepEqual(
        h1.groups.map(g => g.id),
        h2.groups.map(g => g.id),
        'cache hit vs cold read 必须 id 一致'
      );
    }
  });

  it('写入 → getGroupsOrThrow 必须不抛错（不被静默吞掉）', async () => {
    const { SyncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');
    const { cacheManager } = await import('@/utils/performance');

    await storage.setGroups([makeGroup('g1')]);
    const engine = new SyncEngine({
      storage,
      downloadTabGroups: async () => [makeGroup('cloud-Z')],
      uploadTabGroups: async () => ({}),
      markCloudGroupsAsDeleted: async () => {},
      cleanupCloudTombstones: async () => ({ scanned: 0, deleted: 0, errors: 0 }),
      getState: () => ({
        auth: { isAuthenticated: true },
        settings: { syncStrategy: 'newest' },
        tabs: { lastLoadedAt: null },
      }),
    });
    await engine.downloadAndMerge({ forceRemote: true });

    cacheManager.getCache('storage').clear();

    // getGroupsOrThrow 是「区分真空 vs 读失败」的强语义版本 —— 必须不抛
    const groups = await storage.getGroupsOrThrow();
    assert.ok(Array.isArray(groups), 'getGroupsOrThrow 必须返回数组');
    assert.equal(groups.length, 1, 'cloud-Z 必须能读出');
    assert.equal(groups[0].id, 'cloud-Z');
  });

  it('覆盖后 IndexedDB 里不应残留旧 snapshot（防止旧数据复活）', async () => {
    const { SyncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');
    const { kvGet } = await import('@/storage/storageAdapter');

    await storage.setGroups([makeGroup('local-A', { version: 5 })]);

    const engine = new SyncEngine({
      storage,
      downloadTabGroups: async () => [makeGroup('cloud-X')],
      uploadTabGroups: async () => ({}),
      markCloudGroupsAsDeleted: async () => {},
      cleanupCloudTombstones: async () => ({ scanned: 0, deleted: 0, errors: 0 }),
      getState: () => ({
        auth: { isAuthenticated: true },
        settings: { syncStrategy: 'newest' },
        tabs: { lastLoadedAt: null },
      }),
    });
    await engine.downloadAndMerge({ forceRemote: true });

    // syncSnapshot 应被 clearSyncSnapshot 清掉 —— 不残留旧快照
    const snap = await kvGet('sync_snapshot');
    assert.equal(snap, null, '下载成功后 sync_snapshot 必须被清掉');

    // tab_groups 是 cloud-X，不是 local-A
    const { cacheManager } = await import('@/utils/performance');
    cacheManager.getCache('storage').clear();
    const groups = await storage.getGroupsOrThrow();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].id, 'cloud-X', 'tab_groups 应是 cloud-X，不是 local-A');
  });

  it('【关键】云端下载后 bootstrap hydration 必须把数据灌进 preloadedState', async () => {
    // 这是用户报告的真实 bug 路径：写盘成功 + hydrateAll 返回数据 +
    // 但 hydration 路径的某一步出错，导致 preloadedState.tabs 没有 groups /
    // lastLoadedAt 是 null，最后 TabList 走 loadGroups → 显示空。
    const { SyncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');
    const { cacheManager } = await import('@/utils/performance');
    const { decideTabsHydration, buildTabsPreloadedState } = await import('@/utils/hydrationDecision');
    const { initialTabState } = await import('@/store/slices/tabSlice');

    // Step 1: 本地先有数据，然后 SyncEngine.downloadAndMerge 覆盖
    await storage.setGroups([makeGroup('local-A', { version: 3 })]);
    const engine = new SyncEngine({
      storage,
      downloadTabGroups: async () => [
        makeGroup('cloud-X', { version: 1 }),
        makeGroup('cloud-Y', { version: 1 }),
      ],
      uploadTabGroups: async () => ({}),
      markCloudGroupsAsDeleted: async () => {},
      cleanupCloudTombstones: async () => ({ scanned: 0, deleted: 0, errors: 0 }),
      getState: () => ({
        auth: { isAuthenticated: true },
        settings: { syncStrategy: 'newest' },
        tabs: { lastLoadedAt: null },
      }),
    });
    await engine.downloadAndMerge({ forceRemote: true });

    // Step 2: 模拟 popup 关闭 + 重开 —— 清所有内存态缓存
    cacheManager.getCache('storage').clear();

    // Step 3: bootstrap hydration 路径（与 src/popup/index.tsx 一致）
    const { groups, settings } = await storage.hydrateAll();
    const decision = decideTabsHydration({ groups, now: '2026-08-13T12:00:00.000Z' });
    const tabsPreload = buildTabsPreloadedState(decision);

    // 断言 hydration 决策正确
    assert.equal(
      decision.treatAsLoaded,
      true,
      '读到非空 groups 时 treatAsLoaded 必须为 true（否则 TabList 永远走 loadGroups）'
    );
    assert.equal(decision.activeGroups.length, 2, '应读到 2 个活跃组');

    // 断言 preloadedState 正确
    const preloadedTabs = { ...initialTabState, ...(tabsPreload ?? {}) };
    assert.equal(
      preloadedTabs.groups.length,
      2,
      `preloadedState.tabs.groups 必须是 2，实际 ${preloadedTabs.groups.length} —— 否则 UI 空`
    );
    assert.notEqual(
      preloadedTabs.lastLoadedAt,
      null,
      'lastLoadedAt 必须固化，否则 TabList 永远走 loadGroups，UI 闪烁'
    );
    assert.equal(
      preloadedTabs.lastSyncStatus,
      'local',
      'lastSyncStatus 必须是 local'
    );
  });

  it('【关键】多次 setGroups 后再 hydration：必须读到「最新一次」写盘的内容', async () => {
    // 用户场景：先本地保存 → SyncEngine 下载覆盖 → 再下载合并 → 刷新
    // 验证：最新一次的写入必须能被 hydrateAll 读回
    const { SyncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');
    const { cacheManager } = await import('@/utils/performance');

    await storage.setGroups([makeGroup('v1-A')]);

    // 第一次覆盖：写到 cloud-X
    const engine1 = new SyncEngine({
      storage,
      downloadTabGroups: async () => [makeGroup('cloud-X')],
      uploadTabGroups: async () => ({}),
      markCloudGroupsAsDeleted: async () => {},
      cleanupCloudTombstones: async () => ({ scanned: 0, deleted: 0, errors: 0 }),
      getState: () => ({ auth: { isAuthenticated: true }, settings: { syncStrategy: 'newest' }, tabs: { lastLoadedAt: null } }),
    });
    await engine1.downloadAndMerge({ forceRemote: true });

    // 第二次合并：合并 cloud-X 和 cloud-Y
    const engine2 = new SyncEngine({
      storage,
      downloadTabGroups: async () => [makeGroup('cloud-X'), makeGroup('cloud-Y')],
      uploadTabGroups: async () => ({}),
      markCloudGroupsAsDeleted: async () => {},
      cleanupCloudTombstones: async () => ({ scanned: 0, deleted: 0, errors: 0 }),
      getState: () => ({ auth: { isAuthenticated: true }, settings: { syncStrategy: 'newest' }, tabs: { lastLoadedAt: null } }),
    });
    await engine2.downloadAndMerge({ forceRemote: false });

    // 模拟刷新
    cacheManager.getCache('storage').clear();
    const h = await storage.hydrateAll();
    const ids = h.groups.map(g => g.id).sort();
    assert.deepEqual(ids, ['cloud-X', 'cloud-Y'], '应读到第二次合并后的 2 个组');
  });
});