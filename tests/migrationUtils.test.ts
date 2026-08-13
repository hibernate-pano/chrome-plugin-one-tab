// migrationUtils 测试：钉死数据迁移逻辑。
//
// 数据迁移错误是最隐蔽的 bug 之一：升级用户看到「我 5 年的会话没了」。
// 这些迁移函数在应用启动时静默运行，需要 100% 可信。
//
// 测试基础设施：复用 storageLayer.test.ts 的 fake-indexeddb + chrome polyfill。

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

const TEST_EXTENSION_ID = 'test-extension-id-for-migration-tests';
const NOW = '2026-06-04T08:00:00.000Z';

function makeGroup(tabs: any[] = [], overrides: Record<string, unknown> = {}) {
  return {
    id: 'g-1',
    name: 'Test',
    tabs,
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    version: 1,
    ...overrides,
  };
}

function makeTab(overrides: Record<string, unknown> = {}) {
  return {
    id: 't-1',
    url: 'https://example.com',
    title: 'Example',
    favicon: '',
    createdAt: NOW,
    lastAccessed: NOW,
    pinned: false,
    ...overrides,
  };
}

before(async () => {
  register(LOADER_PATH);
  (globalThis as any).chrome = {
    runtime: { id: TEST_EXTENSION_ID },
  };
});

beforeEach(async () => {
  // 重置 IndexedDB + 缓存
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

describe('shouldRunMigration', () => {
  it('未设置 flag → 需要运行', async () => {
    const { shouldRunMigration } = await import('@/utils/migrationUtils');
    const result = await shouldRunMigration('test_migration_key');
    assert.equal(result, true);
  });

  it('已设置 flag=true → 不需要运行', async () => {
    const { shouldRunMigration } = await import('@/utils/migrationUtils');
    const { storage } = await import('@/utils/storage');
    await storage.setMigrationFlag('done_migration', true);
    const result = await shouldRunMigration('done_migration');
    assert.equal(result, false);
  });

  it('已设置 flag=false → 需要运行', async () => {
    const { shouldRunMigration } = await import('@/utils/migrationUtils');
    const { storage } = await import('@/utils/storage');
    await storage.setMigrationFlag('partial_migration', false);
    const result = await shouldRunMigration('partial_migration');
    assert.equal(result, true);
  });
});

describe('migrateFaviconUrls', () => {
  it('空数据 → 标记完成，无数据变动', async () => {
    const { migrateFaviconUrls } = await import('@/utils/migrationUtils');
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');

    await migrateFaviconUrls();

    // migration flag 应被设置
    const flags = await storage.getMigrationFlags();
    assert.equal(flags.favicon_urls_v2, true, '迁移完成后应标记 flag');

    // 数据无变化
    invalidateGroupsCache();
    const groups = await storage.getGroups();
    assert.deepEqual(groups, []);
  });

  it('有 favicon 但已合规 → 不写入，只设 flag', async () => {
    const { migrateFaviconUrls } = await import('@/utils/migrationUtils');
    const { storage, invalidateGroupsCache, cacheManager } = await import('@/utils/storage');

    const validFavicon = 'data:image/png;base64,iVBORw0KGgo...';
    const groups = [makeGroup([makeTab({ favicon: validFavicon })])];
    await storage.setGroups(groups);

    // 记录 setGroups 时间戳
    const beforeTime = Date.now();
    await migrateFaviconUrls();
    const afterTime = Date.now();

    invalidateGroupsCache();
    const result = await storage.getGroups();
    assert.equal(result.length, 1);
    // setGroups 内部会刷 updatedAt，无法直接验证「未写入」
    // 但至少 favicon 应保留
    assert.equal(result[0].tabs[0].favicon, validFavicon);
  });

  it('清除无效 favicon（javascript: 协议）', async () => {
    const { migrateFaviconUrls } = await import('@/utils/migrationUtils');
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');

    const dangerousFavicon = 'javascript:alert(1)';
    const groups = [makeGroup([makeTab({ favicon: dangerousFavicon })])];
    await storage.setGroups(groups);

    await migrateFaviconUrls();
    invalidateGroupsCache();

    const result = await storage.getGroups();
    assert.equal(result[0].tabs[0].favicon, '', '危险 URL 应被清空');
  });

  it('清除无效 favicon（vbscript: 协议）', async () => {
    const { migrateFaviconUrls } = await import('@/utils/migrationUtils');
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');

    const dangerousFavicon = 'vbscript:msgbox(1)';
    const groups = [makeGroup([makeTab({ favicon: dangerousFavicon })])];
    await storage.setGroups(groups);

    await migrateFaviconUrls();
    invalidateGroupsCache();

    const result = await storage.getGroups();
    assert.equal(result[0].tabs[0].favicon, '', 'vbscript URL 应被清空');
  });

  it('保留合法 https favicon', async () => {
    const { migrateFaviconUrls } = await import('@/utils/migrationUtils');
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');

    const safeFavicon = 'https://example.com/favicon.ico';
    const groups = [makeGroup([makeTab({ favicon: safeFavicon })])];
    await storage.setGroups(groups);

    await migrateFaviconUrls();
    invalidateGroupsCache();

    const result = await storage.getGroups();
    assert.equal(result[0].tabs[0].favicon, safeFavicon);
  });

  it('保留合法 data:image favicon', async () => {
    const { migrateFaviconUrls } = await import('@/utils/migrationUtils');
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');

    const dataFavicon = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';
    const groups = [makeGroup([makeTab({ favicon: dataFavicon })])];
    await storage.setGroups(groups);

    await migrateFaviconUrls();
    invalidateGroupsCache();

    const result = await storage.getGroups();
    assert.equal(result[0].tabs[0].favicon, dataFavicon);
  });

  it('迁移多个组 + 多个 tab', async () => {
    const { migrateFaviconUrls } = await import('@/utils/migrationUtils');
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');

    const groups = [
      makeGroup(
        [makeTab({ id: 't-1', favicon: 'javascript:bad' }),
         makeTab({ id: 't-2', favicon: 'https://safe.com/f.ico' })],
        { id: 'g-1' }
      ),
      makeGroup(
        [makeTab({ id: 't-3', favicon: '' })],
        { id: 'g-2' }
      ),
    ];
    await storage.setGroups(groups);

    await migrateFaviconUrls();
    invalidateGroupsCache();

    const result = await storage.getGroups();
    assert.equal(result[0].tabs[0].favicon, '', 't-1 应被清空');
    assert.equal(result[0].tabs[1].favicon, 'https://safe.com/f.ico', 't-2 应保留');
    assert.equal(result[1].tabs[0].favicon, '', 't-3 应保留为空');
  });

  it('迁移完成设置 flag', async () => {
    const { migrateFaviconUrls } = await import('@/utils/migrationUtils');
    const { storage } = await import('@/utils/storage');

    await migrateFaviconUrls();
    const flags = await storage.getMigrationFlags();
    // v1.15.3 起改用 v2 key（旧 v1 不再是「已迁移」凭证，避免旧用户升级后漏掉清理）
    assert.equal(flags.favicon_urls_v2, true);
  });
});

describe('removeRecentRestoreHistory', () => {
  it('设置 flag', async () => {
    const { removeRecentRestoreHistory } = await import('@/utils/migrationUtils');
    const { storage } = await import('@/utils/storage');

    await removeRecentRestoreHistory();

    const flags = await storage.getMigrationFlags();
    assert.equal(flags.recent_restore_history_removed_v1, true);
  });
});

describe('runMigrations: 端到端', () => {
  it('首次运行：所有迁移都跑', async () => {
    const { runMigrations } = await import('@/utils/migrationUtils');
    const { storage } = await import('@/utils/storage');

    // 初始无 flag（v2 key 是新增的，旧用户即使有 v1 也算首次）
    const initialFlags = await storage.getMigrationFlags();
    assert.equal(initialFlags.favicon_urls_v2, undefined);

    await runMigrations();

    // 所有 flag 应被设置
    const finalFlags = await storage.getMigrationFlags();
    assert.equal(finalFlags.favicon_urls_v2, true);
    assert.equal(finalFlags.recent_restore_history_removed_v1, true);
  });

  it('v2 已完成 → 不重复跑', async () => {
    const { runMigrations } = await import('@/utils/migrationUtils');
    const { storage } = await import('@/utils/storage');

    // 先预置 v2 flag（v2 是当前权威凭证）
    await storage.setMigrationFlag('favicon_urls_v2', true);
    await storage.setMigrationFlag('recent_restore_history_removed_v1', true);

    // 写入一个会被「迁移」的数据（javascript: favicon）
    const groups = [makeGroup([makeTab({ favicon: 'javascript:bad' })])];
    await storage.setGroups(groups);

    // 跑迁移（应该跳过）
    await runMigrations();

    const { invalidateGroupsCache } = await import('@/utils/storage');
    invalidateGroupsCache();
    const result = await storage.getGroups();

    // 验证 favicon 没被清除（说明迁移被跳过）
    assert.equal(result[0].tabs[0].favicon, 'javascript:bad', 'v2 已完成时迁移不应再跑');
  });

  it('v1 已完成但 v2 未设 → 必须重跑（v1.15.0/v1.15.1/v1.15.2 升级路径）', async () => {
    const { runMigrations } = await import('@/utils/migrationUtils');
    const { storage } = await import('@/utils/storage');

    // 模拟「v1.15.x 升 v1.15.3」：只有旧 v1 flag
    await storage.setMigrationFlag('favicon_urls_v1', true);

    // 旧版本曾写入 IndexedDB 的 favicon —— 现在已被新白名单排除
    const groups = [
      makeGroup([makeTab({ id: 't-http', favicon: 'http://insecure.example/f.ico' })], { id: 'g-http' }),
      makeGroup([makeTab({ id: 't-ext', favicon: 'chrome-extension://other-ext/icon.png' })], { id: 'g-ext' }),
      makeGroup([makeTab({ id: 't-search', favicon: 'chrome-search://local-ntp/favicon.ico' })], { id: 'g-search' }),
    ];
    await storage.setGroups(groups);

    await runMigrations();

    const { invalidateGroupsCache } = await import('@/utils/storage');
    invalidateGroupsCache();
    const result = await storage.getGroups();
    const tabs = result.flatMap(g => g.tabs);
    const faviconById = Object.fromEntries(tabs.map(t => [t.id, t.favicon]));
    assert.equal(faviconById['t-http'], '', 'http:// 必须被清理');
    assert.equal(faviconById['t-ext'], '', 'chrome-extension:// 必须被清理');
    assert.equal(faviconById['t-search'], '', 'chrome-search:// 必须被清理');

    // v2 flag 现在被写入了
    const flags = await storage.getMigrationFlags();
    assert.equal(flags.favicon_urls_v2, true);
    assert.equal(flags.favicon_urls_v1, true, '旧 v1 flag 也保留——可追溯历史');
  });

  it('部分迁移完成 → 只跑未完成的', async () => {
    const { runMigrations } = await import('@/utils/migrationUtils');
    const { storage } = await import('@/utils/storage');

    // 只预置 favicon 的 v2 flag
    await storage.setMigrationFlag('favicon_urls_v2', true);

    await runMigrations();

    const flags = await storage.getMigrationFlags();
    assert.equal(flags.favicon_urls_v2, true, '已完成的仍为 true');
    assert.equal(flags.recent_restore_history_removed_v1, true, '未完成的被补上');
  });
});

describe('数据完整性不变量', () => {
  it('迁移不改变非 favicon 字段', async () => {
    const { migrateFaviconUrls } = await import('@/utils/migrationUtils');
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');

    const originalTab = makeTab({
      id: 't-original',
      url: 'https://specific.url/path',
      title: 'Specific Title',
      favicon: 'javascript:bad',
      pinned: true,
    });
    await storage.setGroups([makeGroup([originalTab], { id: 'g-original', name: 'Specific Name' })]);

    await migrateFaviconUrls();
    invalidateGroupsCache();

    const result = await storage.getGroups();
    const migratedTab = result[0].tabs[0];
    assert.equal(migratedTab.id, 't-original', 'id 不变');
    assert.equal(migratedTab.url, 'https://specific.url/path', 'url 不变');
    assert.equal(migratedTab.title, 'Specific Title', 'title 不变');
    assert.equal(migratedTab.pinned, true, 'pinned 不变');
    assert.equal(migratedTab.favicon, '', '只有 favicon 被改');
    assert.equal(result[0].id, 'g-original', 'group id 不变');
    assert.equal(result[0].name, 'Specific Name', 'group name 不变');
  });

  it('空 favicon 不被强制写入 data URL', async () => {
    const { migrateFaviconUrls } = await import('@/utils/migrationUtils');
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');

    await storage.setGroups([makeGroup([makeTab({ favicon: '' })])]);
    await migrateFaviconUrls();
    invalidateGroupsCache();

    const result = await storage.getGroups();
    assert.equal(result[0].tabs[0].favicon, '', '空 favicon 应保持为空');
  });
});
