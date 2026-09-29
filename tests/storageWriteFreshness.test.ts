// 回归：读-改-写路径不得用陈旧缓存，否则抹掉别的上下文刚写入的数据。
//
// 真实隐患（2026-09-28 在 e2e 中实测到整组数据被抹掉，顺藤摸瓜确认的生产路径）：
// storage.getGroups() 有 30s 进程内缓存，但 groups 并非只有 SW 一个上下文会写——
// popup 的 runMigrations（migrateFaviconUrls，TabList 挂载时跑）会调 setGroups()
// 写 GROUPS key，而 SW 侧没有注册 onGroupsChanged，感知不到这次写入。
//
// 所有 mutation 都是「读-改-写」：拿陈旧快照改完再写回，期间由别的上下文写入的
// 数据被整段抹掉，且回报成功。触发窗口窄（升级后首次打开 popup 的那一瞬），
// 但后果是全部会话丢失——恰好发生在用户升级、最不该丢数据的时刻。
//
// 修复：写路径统一走 storage.getGroupsForWrite()（先 flush pending 防抖写、
// 再失效缓存、读真值）。本用例锁住该行为。

import { describe, it, before, beforeEach } from 'node:test';
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

// ── localStorage 桩（无 indexedDB 时 storageAdapter 回退到它）────────────
const lsData = new Map<string, string>();
// 桩先起成具名常量再挂到 globalThis：否则要回读 window.localStorage 就得再断一次
// （globalThis 被断言成 Record<string, unknown>，属性取出来是 unknown）。
const localStorageStub = {
  get length() { return lsData.size; },
  key: (i: number) => [...lsData.keys()][i] ?? null,
  getItem: (k: string) => (lsData.has(k) ? (lsData.get(k) as string) : null),
  setItem: (k: string, v: string) => { lsData.set(k, String(v)); },
  removeItem: (k: string) => { lsData.delete(k); },
  clear: () => lsData.clear(),
};
(globalThis as Record<string, unknown>).window = { localStorage: localStorageStub };
(globalThis as Record<string, unknown>).localStorage = localStorageStub;
(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined,
    },
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  },
};

const NOW = '2026-09-28T12:00:00.000Z';

let storage: typeof import('../src/utils/storage.ts').storage;
let invalidateGroupsCache: typeof import('../src/utils/storage.ts').invalidateGroupsCache;
let kvSet: typeof import('../src/storage/storageAdapter.ts').kvSet;

function group(id: string) {
  return {
    id, name: `g-${id}`,
    tabs: [{
      id: `${id}-t1`, url: `https://${id}.com`, title: id,
      createdAt: NOW, lastAccessed: NOW, pinned: false,
    }],
    createdAt: NOW, updatedAt: NOW, isLocked: false, version: 1,
  } as any;
}

before(async () => {
  register(LOADER_PATH, import.meta.url);
  ({ storage, invalidateGroupsCache } = await import('../src/utils/storage.ts'));
  ({ kvSet } = await import('../src/storage/storageAdapter.ts'));
});

beforeEach(() => {
  invalidateGroupsCache();
});

describe('storage.getGroupsForWrite：写路径必须读真值', () => {
  it('别的上下文（popup 迁移）写入后，getGroupsForWrite 能看到，getGroups 看不到', async () => {
    await kvSet('tab_groups', [group('a')]);

    // 模拟 SW 侧先读一次（填充 30s 缓存）
    const cachedFirst = await storage.getGroups();
    assert.deepEqual(cachedFirst.map(g => g.id), ['a']);

    // 模拟 popup 上下文写入（runMigrations 路径）：缓存感知不到
    await kvSet('tab_groups', [group('a'), group('from-popup')]);

    // 陈旧缓存仍返回旧值 —— 这正是隐患的来源
    const stale = await storage.getGroups();
    assert.deepEqual(stale.map(g => g.id), ['a'], 'getGroups 命中陈旧缓存（复现隐患前提）');

    // 写路径读到真值
    const fresh = await storage.getGroupsForWrite();
    assert.deepEqual(fresh.map(g => g.id), ['a', 'from-popup'], '写路径必须绕过缓存');
  });

  it('读-改-写场景：外部新数据不会被写回时抹掉', async () => {
    await kvSet('tab_groups', [group('a')]);
    await storage.getGroups(); // SW 缓存旧快照

    // popup 在此期间写入新会话
    await kvSet('tab_groups', [group('a'), group('from-popup')]);

    // SW 执行一次 mutation 的读-改-写（此处用 rename 语义模拟：读→改→写）
    const current = await storage.getGroupsForWrite();
    await storage.setGroupsImmediate([
      ...current,
      { ...group('new'), name: 'renamed' },
    ]);

    const after = await storage.getGroups();
    assert.deepEqual(
      after.map(g => g.id).sort(),
      ['a', 'from-popup', 'new'],
      'popup 写入的会话必须活下来（修复前会被陈旧快照整段抹掉）'
    );
  });

  it('先 flush 再读：同进程未落盘的防抖写不会被跳过', async () => {
    await kvSet('tab_groups', [group('a')]);

    // 防抖写（setGroups 走 500ms 防抖，此刻尚未落盘）
    await storage.setGroups([group('a'), group('pending')]);

    // 写路径新鲜读：必须包含 pending 那一条，否则紧接着的写会把它覆盖掉
    const fresh = await storage.getGroupsForWrite();
    assert.deepEqual(
      fresh.map(g => g.id),
      ['a', 'pending'],
      'pending 的防抖写必须已落盘并被读到'
    );
  });
});
