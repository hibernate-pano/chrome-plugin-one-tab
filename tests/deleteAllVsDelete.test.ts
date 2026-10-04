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
const LOADER_PATH = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')).href;
before(async () => { register(LOADER_PATH); });

const NOW = '2026-10-04T10:00:00.000Z';
const mkTab = (id: string): Tab => ({ id, url: `https://e.com/${id}`, title: id, favicon: '', createdAt: NOW, lastAccessed: NOW, pinned: false });
const mkGroup = (id: string): TabGroup => ({ id, name: id, tabs: [mkTab(`${id}-t1`)], createdAt: NOW, updatedAt: NOW, version: 1, isLocked: false });

async function makeStore(groups: TabGroup[]) {
  const { configureStore } = await import('@reduxjs/toolkit');
  const mod = await import('@/store/slices/tabSlice');
  const store = configureStore({ reducer: { tabs: mod.default } });
  store.dispatch(mod.setGroups(groups as never));
  return { store, mod };
}

describe('deleteAllGroups 与在途 deleteGroup 并发', () => {
  it('FIFO 顺序（单删先落定 → 全删）：最终列表为空，备份不泄漏', async () => {
    const { store, mod } = await makeStore([mkGroup('g1'), mkGroup('g2')]);
    store.dispatch(mod.deleteGroup.pending('d1', 'g1'));
    store.dispatch(mod.deleteGroup.fulfilled('g1', 'd1', 'g1'));
    store.dispatch(mod.deleteAllGroups.pending('da', undefined));
    store.dispatch(mod.deleteAllGroups.fulfilled({ count: 1 }, 'da', undefined));
    const st = store.getState().tabs;
    assert.deepEqual(st.groups, []);
    assert.deepEqual(st.deletedGroupBackups ?? {}, {}, '备份必须消费完，否则永久过滤掉磁盘上存在的组');
  });

  it('全删先落定，随后单删 rejected：不得复活那个组', async () => {
    const { store, mod } = await makeStore([mkGroup('g1'), mkGroup('g2')]);
    // 单删在途（磁盘未落定），全删成功 → 磁盘上一个组都没有了
    store.dispatch(mod.deleteGroup.pending('d1', 'g1'));
    store.dispatch(mod.deleteAllGroups.pending('da', undefined));
    store.dispatch(mod.deleteAllGroups.fulfilled({ count: 2 }, 'da', undefined));
    // 单删失败：它的备份还要求还原 g1，但 g1 在磁盘上已被全删干掉
    store.dispatch(mod.deleteGroup.rejected({ message: '失败' } as never, 'd1', 'g1'));
    const st = store.getState().tabs;
    assert.deepEqual(st.groups, [], '全删成功后不得有任何组复活');
    assert.deepEqual(st.deletedGroupBackups ?? {}, {});
  });

  it('在途单删的备份不得让 loadGroups 永久过滤掉磁盘上存在的组', async () => {
    // 风险：deletedGroupBackups 若泄漏，inFlightDeletedGroupIds 会把它算作「在途删除」，
    // 于是每次回环都把该组滤掉 —— 磁盘上明明有，UI 永远不显示。
    const groups = [mkGroup('g1'), mkGroup('g2')];
    const { store, mod } = await makeStore(groups);
    store.dispatch(mod.deleteGroup.pending('d1', 'g1'));
    // 单删落定（成功）
    store.dispatch(mod.deleteGroup.fulfilled('g1', 'd1', 'g1'));
    // 他端把 g1 又建回来了 → 回环带回 g1，此时备份已清，必须能显示
    store.dispatch(mod.loadGroups.pending('L', undefined));
    store.dispatch(mod.loadGroups.fulfilled(groups as never, 'L', undefined));
    assert.deepEqual(store.getState().tabs.groups.map(g => g.id).sort(), ['g1', 'g2']);
  });
});

describe('deleteAllGroups 之后的回环不得复活列表', () => {
  it('全删前发起的 loadGroups 回环（带全删前快照）必须被忽略', async () => {
    const groups = [mkGroup('g1'), mkGroup('g2')];
    const { store, mod } = await makeStore(groups);
    store.dispatch(mod.loadGroups.pending('L-old', undefined));   // 读到的是全删前的数据
    store.dispatch(mod.deleteAllGroups.pending('da', undefined));
    store.dispatch(mod.deleteAllGroups.fulfilled({ count: 2 }, 'da', undefined));
    store.dispatch(mod.loadGroups.fulfilled(groups as never, 'L-old', undefined));
    assert.deepEqual(store.getState().tabs.groups, [], '旧代际回环不得把整份列表带回来');
  });

  it('全删后新发起的回环照常生效（不饿死：他端新建的会话可见）', async () => {
    const { store, mod } = await makeStore([mkGroup('g1')]);
    store.dispatch(mod.deleteAllGroups.pending('da', undefined));
    store.dispatch(mod.deleteAllGroups.fulfilled({ count: 1 }, 'da', undefined));
    const fresh = [mkGroup('ext')];
    store.dispatch(mod.loadGroups.pending('L-new', undefined));   // 全删之后发起
    store.dispatch(mod.loadGroups.fulfilled(fresh as never, 'L-new', undefined));
    assert.deepEqual(store.getState().tabs.groups.map(g => g.id), ['ext'], '外部变更必须可见');
  });

  it('全删成功后，在途标签删除失败不得整组复活（标签级备份同样要作废）', async () => {
    const { store, mod } = await makeStore([mkGroup('g1'), mkGroup('g2')]);
    store.dispatch(mod.deleteTabAndSync.pending('t1', { groupId: 'g2', tabId: 'g2-t1' }));
    store.dispatch(mod.deleteAllGroups.pending('da', undefined));
    store.dispatch(mod.deleteAllGroups.fulfilled({ count: 2 }, 'da', undefined));
    store.dispatch(
      mod.deleteTabAndSync.rejected({ message: '网络失败' } as never, 't1', { groupId: 'g2', tabId: 'g2-t1' })
    );
    assert.deepEqual(store.getState().tabs.groups, [], '标签级备份的整组快照 unshift 不得复活 g2');
  });
});
