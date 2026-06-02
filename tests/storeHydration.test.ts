// 验证 createStore(preloadedState) 把 local 数据塞进初始 state，
// 以便 popup 首屏 render 就能显示数据，避免 EmptyState 闪一下。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

before(async () => {
  register(LOADER_PATH);
});

describe('createStore + preloadedState', () => {
  it('不传 preloadedState 时使用 initialTabState 默认值（groups=[]）', async () => {
    const { createStore } = await import('@/store');
    const store = createStore();
    const state = store.getState();
    assert.deepEqual(state.tabs.groups, []);
    assert.equal(state.tabs.lastLoadedAt, null);
    assert.equal(state.tabs.lastSyncStatus, null);
  });

  it('传入 preloadedState 时把 groups / lastLoadedAt / lastSyncStatus 注入初始 state', async () => {
    const { createStore } = await import('@/store');
    const now = '2026-06-02T08:00:00.000Z';
    const localGroups = [
      {
        id: 'g-1',
        name: 'Local',
        tabs: [],
        createdAt: now,
        updatedAt: now,
        isLocked: false,
        version: 1,
      },
    ];
    const store = createStore({
      tabs: { groups: localGroups, lastLoadedAt: now, lastSyncStatus: 'local' },
      settings: undefined,
    });
    const state = store.getState();
    assert.equal(state.tabs.groups.length, 1);
    assert.equal(state.tabs.groups[0].id, 'g-1');
    assert.equal(state.tabs.lastLoadedAt, now);
    assert.equal(state.tabs.lastSyncStatus, 'local');
  });
});
