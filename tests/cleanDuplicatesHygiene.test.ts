// 清理重复标签（cleanDuplicates）墓碑卫生回归：
// 1) core 语义 —— applyCleanDuplicates 的去重范围只含活跃组。回收站墓碑组
//    （isDeleted=true，组内 tab 仍活跃）若参与 urlMap，会把活跃组里同 URL 的
//    tab 墓碑化、最坏情况把活跃组清空连带墓碑（回收站"吸空"活跃会话）。
// 2) UI 不变量 —— Redux 主状态 state.groups 只含活跃组+活跃 tab（loadGroups
//    建立的不变量）。cleanDuplicateTabs.fulfilled 曾把 SW 返回的 storage 全量
//    （含墓碑组/墓碑 tab）直接赋给 state.groups，TabCounter/渲染不过滤墓碑，
//    出现"223 会话/994 标签 → 清理后 230/1106"的反增（+7 组墓碑/+112 tab 墓碑）。
//
// 说明：直接 dispatch fulfilled action creator（不执行 thunk 体，无需 mock
// sendMutation），与 tests/deleteTabRace.test.ts 同模式。

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

before(async () => {
  register(LOADER_PATH);
});

const NOW = '2026-09-28T10:00:00.000Z';
const OLD = '2026-01-01T00:00:00.000Z';
const STAMP = { d: 'devTest', s: 1 };

function mkTab(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    url: `https://e.com/${id}`,
    title: id,
    favicon: '',
    createdAt: OLD,
    lastAccessed: OLD,
    pinned: false,
    isDeleted: false,
    ...over,
  };
}

function mkGroup(id: string, tabs: unknown[], over: Record<string, unknown> = {}) {
  return {
    id,
    name: `g-${id}`,
    tabs,
    createdAt: OLD,
    updatedAt: OLD,
    version: 1,
    isDeleted: false,
    isLocked: false,
    ...over,
  };
}

describe('applyCleanDuplicates：墓碑组不参与去重', () => {
  it('回收站组里的同 URL 更新 tab 不得把活跃组的 tab 墓碑化', async () => {
    const { applyCleanDuplicates } = await import('@/utils/mutationOps');
    // 活跃组 gActive：url X 的 tab，lastAccessed 较旧
    const activeTab = mkTab('activeTab', { url: 'https://dup.com', lastAccessed: OLD });
    const gActive = mkGroup('gActive', [activeTab]);
    // 回收站墓碑组 gTrash：同 URL 的 tab，lastAccessed 更新（若参与去重会挤掉 activeTab）
    const trashTab = mkTab('trashTab', { url: 'https://dup.com', lastAccessed: NOW });
    const gTrash = mkGroup('gTrash', [trashTab], { isDeleted: true, deletedAt: OLD });

    const { groups, removedTabsCount, removedGroupsCount } = applyCleanDuplicates(
      [gActive, gTrash],
      NOW,
      STAMP
    );

    assert.equal(removedTabsCount, 0);
    assert.equal(removedGroupsCount, 0);
    const outActive = groups.find(g => g.id === 'gActive')!;
    assert.equal(outActive.tabs.find(t => t.id === 'activeTab')!.isDeleted, false);
    // 墓碑组原样透传（保持墓碑），其 tab 也不被二次墓碑
    const outTrash = groups.find(g => g.id === 'gTrash')!;
    assert.equal(outTrash.isDeleted, true);
    assert.equal(outTrash.tabs.find(t => t.id === 'trashTab')!.isDeleted, false);
  });

  it('活跃组之间的去重不受影响（墓碑组存在时仍正常工作）', async () => {
    const { applyCleanDuplicates } = await import('@/utils/mutationOps');
    const old = mkTab('old', { url: 'https://dup.com', lastAccessed: OLD });
    const fresh = mkTab('fresh', { url: 'https://dup.com', lastAccessed: NOW });
    const g1 = mkGroup('g1', [old, fresh]);
    const gTrash = mkGroup('gTrash', [], { isDeleted: true, deletedAt: OLD });

    const { groups, removedTabsCount } = applyCleanDuplicates([g1, gTrash], NOW, STAMP);

    assert.equal(removedTabsCount, 1);
    const out1 = groups.find(g => g.id === 'g1')!;
    assert.equal(out1.tabs.find(t => t.id === 'old')!.isDeleted, true);
    assert.equal(out1.tabs.find(t => t.id === 'fresh')!.isDeleted, false);
  });
});

describe('cleanDuplicateTabs.fulfilled：不把墓碑灌入 Redux 主状态', () => {
  it('SW 返回 storage 全量（含墓碑组/墓碑 tab）时，state.groups 仍只含活跃视图', async () => {
    const { configureStore } = await import('@reduxjs/toolkit');
    const { default: tabReducer } = await import('@/store/slices/tabSlice');
    const { cleanDuplicateTabs } = await import('@/store/slices/tabSlice');

    const store = configureStore({ reducer: { tabs: tabReducer } });

    // 模拟 SW getGroups() 的 storage 全量：2 个活跃组（其中 1 个混 1 个墓碑 tab）
    // + 2 个回收站墓碑组（组内 tab 活跃）——对应线上 223/994 → 230/1106 的形态
    const storageSnapshot = [
      mkGroup('g1', [
        mkTab('g1-t1', { url: 'https://dup.com', lastAccessed: NOW }),
        mkTab('g1-t2', { url: 'https://dup.com', lastAccessed: OLD }),
        mkTab('g1-dead', { url: 'https://dead.com', isDeleted: true, deletedAt: OLD }),
      ]),
      mkGroup('g2', [mkTab('g2-t1', { url: 'https://unique.com' })]),
      mkGroup('g-dead-1', [mkTab('dead-1-t1', { url: 'https://trash1.com' })], {
        isDeleted: true,
        deletedAt: OLD,
      }),
      mkGroup('g-dead-2', [mkTab('dead-2-t1', { url: 'https://trash2.com' })], {
        isDeleted: true,
        deletedAt: OLD,
      }),
    ];

    store.dispatch(
      cleanDuplicateTabs.fulfilled(
        {
          removedTabsCount: 1,
          removedGroupsCount: 0,
          updatedGroups: storageSnapshot,
        },
        'req-1',
        undefined
      )
    );

    const state = store.getState().tabs;
    // 墓碑组不得进入主状态（否则 TabCounter 的 groups.length 反增）
    assert.deepEqual(
      state.groups.map(g => g.id).sort(),
      ['g1', 'g2'],
      '主状态不得包含墓碑组'
    );
    // 组内墓碑 tab 不得进入主状态（否则 tabs.length 反增/渲染泄漏）
    const g1 = state.groups.find(g => g.id === 'g1')!;
    assert.deepEqual(
      g1.tabs.map(t => t.id).sort(),
      ['g1-t1', 'g1-t2'],
      '主状态组内不得包含墓碑 tab'
    );
  });
});
