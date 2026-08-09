// 钉死「刷新后数据丢失」根因一的正确行为：
//
// popup bootstrap 读本地数据塞 preloadedState 时，如果 storage.getGroups()
// 因为冷启动 race / 解密失败而静默返回 []，绝不能把 lastLoadedAt 固化成非空——
// 否则 TabList 的 `if (lastLoadedAt) return` 会永久跳过 loadGroups 重试，
// 用户看到 EmptyState，表现为「刷新后数据丢了」。
//
// 这个测试是纯函数测试，零依赖、不受 ESM module mock 串扰影响。

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

const NOW = '2026-06-04T10:00:00.000Z';

function makeGroup(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Group ${id}`,
    tabs: [
      {
        id: `${id}-t1`,
        url: `https://example.com/${id}`,
        title: 'tab',
        createdAt: NOW,
        lastAccessed: NOW,
        pinned: false,
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    version: 1,
    ...overrides,
  };
}

before(async () => {
  register(LOADER_PATH);
});

describe('hydrationDecision: 防止空读被固化（刷新后数据丢失根因）', () => {
  it('读到空数组 [] → 不固化 lastLoadedAt（让 TabList 重试 loadGroups）', async () => {
    const { decideTabsHydration } = await import('@/utils/hydrationDecision');
    const d = decideTabsHydration({ groups: [], now: NOW });

    assert.equal(d.treatAsLoaded, false, '空读不应被当作已加载');
    assert.equal(d.lastLoadedAt, null, 'lastLoadedAt 必须为 null，否则 TabList 永久跳过 loadGroups');
    assert.equal(d.lastSyncStatus, null);
    assert.deepEqual(d.activeGroups, []);
  });

  it('groups 为 null（getGroups 静默失败）→ 不固化', async () => {
    const { decideTabsHydration } = await import('@/utils/hydrationDecision');
    const d = decideTabsHydration({ groups: null, now: NOW });
    assert.equal(d.treatAsLoaded, false);
    assert.equal(d.lastLoadedAt, null);
  });

  it('全是软删组 → 视为空，不固化', async () => {
    const { decideTabsHydration } = await import('@/utils/hydrationDecision');
    const d = decideTabsHydration({
      groups: [makeGroup('a', { isDeleted: true }), makeGroup('b', { isDeleted: true })],
      now: NOW,
    });
    assert.equal(d.treatAsLoaded, false, '过滤软删后为空，等同空读');
    assert.equal(d.lastLoadedAt, null);
  });

  it('读到真实数据 → 固化 lastLoadedAt + lastSyncStatus=local（首屏直显）', async () => {
    const { decideTabsHydration } = await import('@/utils/hydrationDecision');
    const d = decideTabsHydration({
      groups: [makeGroup('a'), makeGroup('b', { isDeleted: true }), makeGroup('c')],
      now: NOW,
    });
    assert.equal(d.treatAsLoaded, true);
    assert.equal(d.lastLoadedAt, NOW);
    assert.equal(d.lastSyncStatus, 'local');
    assert.deepEqual(d.activeGroups.map(g => g.id), ['a', 'c'], '软删组应被过滤');
  });

  it('buildTabsPreloadedState：空读返回 null（不 hydrate tabs）', async () => {
    const { decideTabsHydration, buildTabsPreloadedState } = await import('@/utils/hydrationDecision');
    const d = decideTabsHydration({ groups: [], now: NOW });
    assert.equal(buildTabsPreloadedState(d), null);
  });

  it('buildTabsPreloadedState：有数据返回 3 字段对象', async () => {
    const { decideTabsHydration, buildTabsPreloadedState } = await import('@/utils/hydrationDecision');
    const d = decideTabsHydration({ groups: [makeGroup('a')], now: NOW });
    const p = buildTabsPreloadedState(d);
    assert.ok(p);
    assert.equal(p!.groups.length, 1);
    assert.equal(p!.lastLoadedAt, NOW);
    assert.equal(p!.lastSyncStatus, 'local');
  });
});
