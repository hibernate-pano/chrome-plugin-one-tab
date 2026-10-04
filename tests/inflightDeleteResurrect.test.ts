import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Tab, TabGroup } from '@/types/tab';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false, MODE: 'test',
};
const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;
before(async () => { register(LOADER_PATH); });

const NOW = '2026-10-04T10:00:00.000Z';
const mkTab = (id: string): Tab => ({ id, url: `https://e.com/${id}`, title: id, favicon: '', createdAt: NOW, lastAccessed: NOW, pinned: false });
const mkGroup = (id: string, tabs: Tab[]): TabGroup => ({ id, name: `g-${id}`, tabs, createdAt: NOW, updatedAt: NOW, version: 1, isLocked: false });

async function makeStore(groups: TabGroup[]) {
  const { configureStore } = await import('@reduxjs/toolkit');
  const mod = await import('@/store/slices/tabSlice');
  const store = configureStore({ reducer: { tabs: mod.default } });
  store.dispatch(mod.setGroups(groups as never));
  return { store, mod };
}

describe('在途的组级删除不得被清理的重推复活', () => {
  it('cleanDuplicates.pending 抓快照后 deleteGroup，fulfilled 重推不得带回该组', async () => {
    const groups = [
      mkGroup('g1', [mkTab('t1')]),
      mkGroup('doomed', [mkTab('d1')]),
    ];
    const { store, mod } = await makeStore(groups);

    // 1) 清理先发起（快照含 doomed）
    store.dispatch(mod.cleanDuplicateTabs.pending('req-clean', undefined));
    // 2) 用户紧接着删掉 doomed（在途，未落盘）
    store.dispatch(mod.deleteGroup.pending('req-del', 'doomed'));
    assert.deepEqual(store.getState().tabs.groups.map(g => g.id), ['g1'], '前置条件：doomed 已乐观移除');

    // 3) 清理回包：用快照重推。快照里有 doomed，若不剥在途删除就会复活
    store.dispatch(
      mod.cleanDuplicateTabs.fulfilled(
        { plan: { removedTabsByGroup: [], removedGroupIds: [], removedTabsCount: 0, removedGroupsCount: 0 }, now: NOW, stamp: { d: 'devSW', s: 1 } } as never,
        'req-clean',
        undefined
      )
    );
    assert.deepEqual(
      store.getState().tabs.groups.map(g => g.id),
      ['g1'],
      'doomed 是用户在途显式删除的，清理的重推不得把它复活'
    );
  });

  it('cleanDuplicates.rejected 还原时同样不得带回在途删除的组', async () => {
    const groups = [mkGroup('g1', [mkTab('t1')]), mkGroup('doomed', [mkTab('d1')])];
    const { store, mod } = await makeStore(groups);
    store.dispatch(mod.cleanDuplicateTabs.pending('req-clean', undefined));
    store.dispatch(mod.deleteGroup.pending('req-del', 'doomed'));
    store.dispatch(mod.cleanDuplicateTabs.rejected({ message: 'x' } as never, 'req-clean', undefined));
    assert.deepEqual(
      store.getState().tabs.groups.map(g => g.id),
      ['g1'],
      '还原清理不等于撤销用户对另一个组的删除'
    );
  });

  it('loadGroups 回环不得复活在途删除的组（同代际窗口）', async () => {
    const groups = [mkGroup('g1', [mkTab('t1')]), mkGroup('doomed', [mkTab('d1')])];
    const { store, mod } = await makeStore(groups);
    // 删除在途（磁盘还没删）；此后发起的 load 代际与当前相同，回环带的是磁盘旧值
    store.dispatch(mod.deleteGroup.pending('req-del', 'doomed'));
    store.dispatch(mod.loadGroups.pending('req-load', undefined));
    store.dispatch(mod.loadGroups.fulfilled(groups as never, 'req-load', undefined));
    assert.deepEqual(
      store.getState().tabs.groups.map(g => g.id),
      ['g1'],
      '在途删除的组不得被回环复活'
    );
  });

  it('组删除已落定（fulfilled）后，正常回环照常工作（不饿死外部变更）', async () => {
    const groups = [mkGroup('g1', [mkTab('t1')]), mkGroup('doomed', [mkTab('d1')])];
    const { store, mod } = await makeStore(groups);
    store.dispatch(mod.deleteGroup.pending('req-del', 'doomed'));
    store.dispatch(mod.deleteGroup.fulfilled('doomed', 'req-del', 'doomed'));
    // 他端新增了一个会话，回环带回来（doomed 确实已删）
    store.dispatch(mod.loadGroups.pending('req-load', undefined));
    store.dispatch(
      mod.loadGroups.fulfilled(
        [mkGroup('g1', [mkTab('t1')]), mkGroup('ext', [mkTab('e1')])] as never,
        'req-load',
        undefined
      )
    );
    assert.deepEqual(store.getState().tabs.groups.map(g => g.id).sort(), ['ext', 'g1'], '外部变更必须可见');
  });
});
