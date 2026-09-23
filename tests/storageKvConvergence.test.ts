// S2 存储 KV 收敛锁定测试（行为零变化证明）。
//
// 覆盖：
// - 键常量单源：STORAGE_KEYS 全量字面值锁定 + STORAGE_VERSION + MIGRATION_KEYS 同源引用
// - 原位置转发同一性：@/storage/* 与 @/storage-kv/* 导出同一函数引用
// - 门面 re-export 同一性：@/utils/storage 的 STORAGE_KEYS 与共享单源同一引用
// - sharedStringStorage 三环境语义（扩展 chrome.storage / 网页 localStorage / 双无降级）
// - 双路径语义保留：防抖 setGroups（last-write-wins 合并）vs 直写 setGroupsImmediate
// - supabase 模块在改线后仍可正常初始化（client 占位创建不抛错）
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

// ── 最小浏览器存储环境 ──────────────────────────────────────────────
// storageAdapter 在无 indexedDB 时回退 window.localStorage，用 Map 模拟。
// chrome.storage.local 另用 Map 模拟，支撑 sharedStringStorage 扩展路径。
const lsData = new Map<string, string>();
const chromeData = new Map<string, unknown>();

function makeLocalStorageLike(backing: Map<string, string>) {
  return {
    get length() {
      return backing.size;
    },
    key: (i: number) => Array.from(backing.keys())[i] ?? null,
    getItem: (k: string) => (backing.has(k) ? (backing.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      backing.set(k, String(v));
    },
    removeItem: (k: string) => {
      backing.delete(k);
    },
    clear: () => backing.clear(),
  };
}

const webLsBacking = new Map<string, string>();

(globalThis as Record<string, unknown>).window = {
  localStorage: makeLocalStorageLike(lsData),
};
(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get: async (keys?: string | string[] | Record<string, unknown>) => {
        if (typeof keys === 'string') return { [keys]: chromeData.get(keys) };
        if (Array.isArray(keys)) {
          return Object.fromEntries(keys.map(k => [k, chromeData.get(k)]));
        }
        return Object.fromEntries(chromeData.entries());
      },
      set: async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) chromeData.set(k, v);
      },
      remove: async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) chromeData.delete(k);
      },
    },
  },
  runtime: { getManifest: () => ({ version: 'test' }) },
};
// 网页回退路径用裸 localStorage（supabase session 层语义）
(globalThis as Record<string, unknown>).localStorage = makeLocalStorageLike(webLsBacking);

before(async () => {
  register(LOADER_PATH);
});

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

describe('S2 键常量单源', () => {
  it('STORAGE_KEYS 字面值与搬迁前逐字一致', async () => {
    const { STORAGE_KEYS, STORAGE_VERSION } = await import('@/storage-kv/keys');
    assert.deepEqual({ ...STORAGE_KEYS }, {
      VERSION: 'storage_version',
      GROUPS: 'tab_groups',
      SETTINGS: 'user_settings',
      DELETED_GROUPS: 'deleted_tab_groups',
      DELETED_TABS: 'deleted_tabs',
      LAST_SYNC_TIME: 'last_sync_time',
      SYNC_SNAPSHOT: 'sync_snapshot',
      PRODUCT_EVENTS: 'product_events',
      MIGRATION_FLAGS: 'migration_flags',
      PENDING_UPLOAD: 'pending_upload',
      LAST_UPLOAD_TIME: 'last_upload_time',
      PENDING_PURGE_IDS: 'pending_purge_ids',
      DEVICE_SEQ: 'device_seq',
      JOURNAL: 'journal',
      LAST_SYNCED_SEQ: 'last_synced_seq',
      OP_STAMP_MIGRATED: 'op_stamp_migrated',
    });
    assert.equal(STORAGE_VERSION, 5);
  });

  it('MIGRATION_KEYS 与 STORAGE_KEYS/LEGACY_KEYS 同源（值相等且引用同一单源）', async () => {
    const { STORAGE_KEYS, MIGRATION_KEYS, LEGACY_KEYS } = await import('@/storage-kv/keys');
    assert.deepEqual({ ...MIGRATION_KEYS }, {
      deviceId: 'tabvaultpro_device_id',
      legacyDeviceId: 'deviceId',
      tabGroupPrefix: 'tabGroup_',
      tabGroups: 'tab_groups',
      legacyTabGroups: 'tabGroups',
      userSettings: 'user_settings',
      deletedGroups: 'deleted_tab_groups',
      deletedTabs: 'deleted_tabs',
      lastSyncTime: 'last_sync_time',
      migrationFlags: 'migration_flags',
    });
    // 同源引用（非各自手写字符串）
    assert.equal(MIGRATION_KEYS.tabGroups, STORAGE_KEYS.GROUPS);
    assert.equal(MIGRATION_KEYS.userSettings, STORAGE_KEYS.SETTINGS);
    assert.equal(MIGRATION_KEYS.deletedGroups, STORAGE_KEYS.DELETED_GROUPS);
    assert.equal(MIGRATION_KEYS.deletedTabs, STORAGE_KEYS.DELETED_TABS);
    assert.equal(MIGRATION_KEYS.lastSyncTime, STORAGE_KEYS.LAST_SYNC_TIME);
    assert.equal(MIGRATION_KEYS.migrationFlags, STORAGE_KEYS.MIGRATION_FLAGS);
    assert.equal(MIGRATION_KEYS.deviceId, LEGACY_KEYS.DEVICE_ID);
    assert.equal(MIGRATION_KEYS.legacyDeviceId, LEGACY_KEYS.LEGACY_DEVICE_ID);
    assert.equal(MIGRATION_KEYS.legacyTabGroups, LEGACY_KEYS.LEGACY_TAB_GROUPS);
    assert.equal(MIGRATION_KEYS.tabGroupPrefix, LEGACY_KEYS.TAB_GROUP_PREFIX);
  });

  it('@/utils/storage 门面 re-export 的 STORAGE_KEYS 与单源同一引用', async () => {
    const facade = await import('@/utils/storage');
    const shared = await import('@/storage-kv/keys');
    assert.equal(facade.STORAGE_KEYS, shared.STORAGE_KEYS);
    assert.equal(facade.STORAGE_VERSION, shared.STORAGE_VERSION);
  });
});

describe('S2 原位置转发同一性（调用方 import 不动）', () => {
  it('storageAdapter 旧路径与新路径导出同一函数', async () => {
    const oldMod = await import('@/storage/storageAdapter');
    const newMod = await import('@/storage-kv/storageAdapter');
    for (const name of ['kvGet', 'kvSet', 'kvRemove', 'initStorage', 'getActiveBackend'] as const) {
      assert.equal(oldMod[name], newMod[name], `${name} 应为同一引用`);
    }
  });

  it('drivers 旧路径与新路径导出同一对象', async () => {
    const oldIdb = await import('@/storage/indexedDbClient');
    const newIdb = await import('@/storage-kv/indexedDbClient');
    assert.equal(oldIdb.indexedDbDriver, newIdb.indexedDbDriver);
    assert.equal(oldIdb.isIndexedDbAvailable, newIdb.isIndexedDbAvailable);
    const oldLs = await import('@/storage/localStorageFallback');
    const newLs = await import('@/storage-kv/localStorageFallback');
    assert.equal(oldLs.localStorageDriver, newLs.localStorageDriver);
    assert.equal(oldLs.isLocalStorageAvailable, newLs.isLocalStorageAvailable);
  });

  it('经由旧路径的 kv 读写落盘可用（localStorage 后端）', async () => {
    const { kvSet, kvGet, kvRemove, getActiveBackend } = await import('@/storage/storageAdapter');
    await kvSet('s2_probe', { a: 1 });
    assert.deepEqual(await kvGet('s2_probe'), { a: 1 });
    await kvRemove('s2_probe');
    assert.equal(await kvGet('s2_probe'), null);
    assert.equal(getActiveBackend(), 'localStorage');
  });
});

describe('S2 sharedStringStorage 三环境语义（与旧 supabaseSharedStorage 逐字一致）', () => {
  it('扩展环境：走 chrome.storage.local，不碰 localStorage', async () => {
    const { sharedStringStorage } = await import('@/storage-kv/stringStore');
    await sharedStringStorage.setItem('sb-x-auth-token', 'tok-1');
    assert.equal(chromeData.get('sb-x-auth-token'), 'tok-1');
    assert.equal(webLsBacking.has('sb-x-auth-token'), false);
    assert.equal(await sharedStringStorage.getItem('sb-x-auth-token'), 'tok-1');
    await sharedStringStorage.removeItem('sb-x-auth-token');
    assert.equal(await sharedStringStorage.getItem('sb-x-auth-token'), null);
  });

  it('网页环境（无 chrome）：回退裸 localStorage', async () => {
    const g = globalThis as Record<string, unknown>;
    const savedChrome = g.chrome;
    delete g.chrome;
    try {
      const { sharedStringStorage } = await import('@/storage-kv/stringStore');
      const { hasExtensionStorage } = await import('@/storage-kv/env');
      assert.equal(hasExtensionStorage(), false, '无 chrome 时共享 env 判定为非扩展环境');
      await sharedStringStorage.setItem('sb-y-auth-token', 'tok-2');
      assert.equal(webLsBacking.get('sb-y-auth-token'), 'tok-2');
      assert.equal(await sharedStringStorage.getItem('sb-y-auth-token'), 'tok-2');
      await sharedStringStorage.removeItem('sb-y-auth-token');
      assert.equal(await sharedStringStorage.getItem('sb-y-auth-token'), null);
    } finally {
      g.chrome = savedChrome;
    }
  });

  it('双无环境（SW 无 window.localStorage 且无 chrome）：读 null、写不抛', async () => {
    const g = globalThis as Record<string, unknown>;
    const savedChrome = g.chrome;
    const savedLs = g.localStorage;
    delete g.chrome;
    delete g.localStorage;
    try {
      const { sharedStringStorage } = await import('@/storage-kv/stringStore');
      const { hasWebStorage } = await import('@/storage-kv/env');
      assert.equal(hasWebStorage(), false);
      assert.equal(await sharedStringStorage.getItem('sb-z-auth-token'), null);
      await sharedStringStorage.setItem('sb-z-auth-token', 'tok-3');
      await sharedStringStorage.removeItem('sb-z-auth-token');
    } finally {
      g.chrome = savedChrome;
      g.localStorage = savedLs;
    }
  });
});

describe('S2 双路径语义保留（防抖 setGroups vs 直写 setGroupsImmediate）', () => {
  it('直写路径：await 返回即落盘，无需等 500ms 防抖窗口', async () => {
    const { storage } = await import('@/utils/storage');
    const { kvGet } = await import('@/storage/storageAdapter');
    await storage.setGroupsImmediate([makeGroup('g-direct')]);
    const raw = await kvGet<unknown[]>('tab_groups');
    assert.ok(Array.isArray(raw), '直写后 kv 应立即可读');
    assert.deepEqual((raw as Array<{ id: string }>).map(g => g.id), ['g-direct']);
  });

  it('防抖路径：窗口期内多次调用合并为一次落盘（last-write-wins），各调用方均可 await', async () => {
    const { storage } = await import('@/utils/storage');
    const { kvGet } = await import('@/storage/storageAdapter');
    const p1 = storage.setGroups([makeGroup('g-deb-1')]);
    const p2 = storage.setGroups([makeGroup('g-deb-2')]);
    await Promise.all([p1, p2]);
    const raw = (await kvGet<Array<{ id: string }>>('tab_groups')) ?? [];
    assert.deepEqual(raw.map(g => g.id), ['g-deb-2'], '最终落盘必须为最后一次写入');
    // 门面缓存亦同步为最终值（后续 getGroups 读一致）
    const groups = await storage.getGroups();
    assert.deepEqual(groups.map(g => (g as { id: string }).id), ['g-deb-2']);
  });

  it('新鲜读：getGroupsFresh 绕过 30s 缓存读到旁路写入', async () => {
    const { storage } = await import('@/utils/storage');
    const { kvSet } = await import('@/storage/storageAdapter');
    await storage.setGroupsImmediate([makeGroup('g-cached')]);
    await storage.getGroups(); // 预热 30s 缓存
    await kvSet('tab_groups', [makeGroup('g-fresh')]); // 模拟 SW 旁路写入
    const fresh = await storage.getGroupsFresh();
    assert.deepEqual(fresh.map(g => (g as { id: string }).id), ['g-fresh']);
  });
});

describe('S2 supabase 改线冒烟', () => {
  it('supabase 模块在共享存储改线后仍可初始化', async () => {
    const mod = await import('@/utils/supabase');
    assert.ok(mod.supabase, 'supabase client 应成功创建');
    assert.equal(typeof mod.isSupabaseConfigured, 'function');
    assert.equal(typeof mod.supportsOpStamp, 'function');
    assert.equal(typeof mod.supportsCloudTombstone, 'function');
  });
});
