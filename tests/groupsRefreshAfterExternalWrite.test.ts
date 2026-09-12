// 跨上下文写入后的 UI 刷新回归测试。
//
// 背景（真实 bug）：popup 首屏 loadGroups() 会把 groups 读进进程内 30s 缓存
// （storage.getGroups 走 cachedAsyncFn）。SW 侧同步下载合并只写 IndexedDB，
// 不会触发 chrome.storage.onChanged（groups 已迁移到 IndexedDB kv），
// 于是同步完成后 popup 的 dispatch(loadGroups()) 命中旧缓存 →
// 云端已下载的会话在列表里"看不见"（页头显示 0 会话 / 0 标签）。
//
// 不变量：loadGroups / loadDeletedGroups 属于显式加载，读前必须失效缓存，
// 永远读存储真值。

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
const lsData = new Map<string, string>();
(globalThis as Record<string, unknown>).window = {
  localStorage: {
    get length() {
      return lsData.size;
    },
    key: (i: number) => Array.from(lsData.keys())[i] ?? null,
    getItem: (k: string) => (lsData.has(k) ? (lsData.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      lsData.set(k, String(v));
    },
    removeItem: (k: string) => {
      lsData.delete(k);
    },
  },
};
(globalThis as Record<string, unknown>).chrome = {
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
  runtime: { getManifest: () => ({ version: 'test' }) },
};

before(async () => {
  register(LOADER_PATH);
});

const NOW = '2026-09-12T00:00:00.000Z';

function makeTab(id: string) {
  return {
    id,
    url: `https://example.com/${id}`,
    title: `tab ${id}`,
    favicon: '',
    createdAt: NOW,
    lastAccessed: NOW,
    pinned: false,
  };
}

function makeGroup(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `group-${id}`,
    tabs: [makeTab(`${id}-t1`)],
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    version: 1,
    ...overrides,
  };
}

describe('跨上下文写入后 UI 显式加载', () => {
  it('loadGroups 读到另一上下文（SW 同步）写入的活跃会话，而不是 30s 旧缓存', async () => {
    const { configureStore } = await import('@reduxjs/toolkit');
    const { default: tabReducer, loadGroups } = await import('@/store/slices/tabSlice');
    const { kvSet } = await import('@/storage/storageAdapter');

    const store = configureStore({ reducer: { tabs: tabReducer } });

    const first = await store.dispatch(loadGroups()).unwrap();
    assert.deepEqual(first, [], '首屏（无数据）应为空列表');

    // 模拟 SW 下载合并：直接落盘，不经过本进程的 storage 缓存
    await kvSet('tab_groups', [makeGroup('g-active')]);

    const second = await store.dispatch(loadGroups()).unwrap();
    assert.equal(second.length, 1, '同步完成后显式刷新必须读到新落盘的会话');
    assert.equal(second[0].id, 'g-active');
  });

  it('loadDeletedGroups 读到另一上下文写入的墓碑组，而不是 30s 旧缓存', async () => {
    const { configureStore } = await import('@reduxjs/toolkit');
    const { default: tabReducer, loadDeletedGroups } = await import('@/store/slices/tabSlice');
    const { kvSet } = await import('@/storage/storageAdapter');

    const store = configureStore({ reducer: { tabs: tabReducer } });

    const first = await store.dispatch(loadDeletedGroups()).unwrap();
    assert.deepEqual(first, [], '首屏（无墓碑）应为空列表');

    await kvSet('tab_groups', [makeGroup('g-deleted', { isDeleted: true })]);

    const second = await store.dispatch(loadDeletedGroups()).unwrap();
    assert.equal(second.length, 1, '误删保护视图必须读到新写入的墓碑组');
    assert.equal(second[0].id, 'g-deleted');
  });
});
