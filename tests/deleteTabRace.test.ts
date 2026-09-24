// 回环代际 guard + 乐观备份 key 化回归测试：
// 1) 代际 guard —— mutation 在途期 TabList 的 150ms 回环 load 读到旧快照时，
//    fulfilled 携带的发起时 epoch 落后于当前 mutationEpoch，必须被忽略（根除复活闪现）；
//    无在途 mutation 时的新回环（含外部/他端同步变更）必须正常应用，不饿死。
// 2) 备份 key 化 —— optimisticBackup 单槽位时快速连点不同 tab 会互相覆盖，
//    rejected 错位回滚；改为按 `${groupId}:${tabId}` key 化后 rejected 只回滚对应项。
//
// 说明：直接 dispatch 各 thunk 的 pending/fulfilled/rejected action creator
// （不执行 thunk 体，无需 mock sendMutation），只锁定 reducer 竞态语义。

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

function makeGroup(id: string, tabIds: string[]) {
  return {
    id,
    name: `group-${id}`,
    tabs: tabIds.map(makeTab),
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    version: 1,
  };
}

async function makeStore(seeds: ReturnType<typeof makeGroup>[] = []) {
  const { configureStore } = await import('@reduxjs/toolkit');
  const { default: tabReducer, setGroups } = await import('@/store/slices/tabSlice');
  const store = configureStore({ reducer: { tabs: tabReducer } });
  if (seeds.length > 0) store.dispatch(setGroups(seeds));
  return store;
}

async function slice() {
  return import('@/store/slices/tabSlice');
}

const tabIdsOf = (state: { groups: { id: string; tabs: { id: string }[] }[] }, groupId: string) =>
  state.groups.find(g => g.id === groupId)?.tabs.map(t => t.id) ?? null;

describe('回环代际 guard（mutationEpoch）', () => {
  it('在途旧回环被忽略：load 发起早于 deleteTab 乐观更新，旧快照不得覆盖乐观态', async () => {
    const { loadGroups, deleteTabAndSync } = await slice();
    const store = await makeStore([makeGroup('g', ['t1', 't2'])]);

    // TabList 防抖回环先发起（读到的将是旧快照）
    store.dispatch(loadGroups.pending('L-old', undefined));
    // 用户点击删除：乐观移除 t1，代际前进
    store.dispatch(deleteTabAndSync.pending('D1', { groupId: 'g', tabId: 't1' }));
    assert.deepEqual(tabIdsOf(store.getState().tabs, 'g'), ['t2'], '乐观更新应先移除 t1');

    // 旧回环带着含 t1 的快照回来 → 必须丢弃（否则 t1 复活闪现）
    store.dispatch(
      loadGroups.fulfilled([makeGroup('g', ['t1', 't2'])], 'L-old', undefined)
    );
    assert.deepEqual(tabIdsOf(store.getState().tabs, 'g'), ['t2'], '在途旧回环必须被忽略');
  });

  it('新回环生效：mutation 落定后发起的 load（含外部变更）正常应用，不饿死', async () => {
    const { loadGroups, deleteTabAndSync } = await slice();
    const store = await makeStore([makeGroup('g', ['t1', 't2'])]);

    store.dispatch(deleteTabAndSync.pending('D1', { groupId: 'g', tabId: 't1' }));
    store.dispatch(
      deleteTabAndSync.fulfilled({ group: makeGroup('g', ['t2']) }, 'D1', {
        groupId: 'g',
        tabId: 't1',
      })
    );
    // 他端同步写入新会话后触发的新回环（发起时代际与当前一致）必须应用
    store.dispatch(loadGroups.pending('L-new', undefined));
    store.dispatch(
      loadGroups.fulfilled([makeGroup('g', ['t2']), makeGroup('ext', ['x1'])], 'L-new', undefined)
    );
    const groups = store.getState().tabs.groups;
    assert.equal(groups.length, 2, '外部变更的新回环必须生效');
    assert.ok(groups.some(g => g.id === 'ext'), '他端写入的会话必须可见');
  });

  it('无在途 mutation 的普通刷新不受影响', async () => {
    const { loadGroups } = await slice();
    const store = await makeStore([makeGroup('g', ['t1'])]);
    store.dispatch(loadGroups.pending('L1', undefined));
    store.dispatch(loadGroups.fulfilled([makeGroup('g', ['t1', 't2'])], 'L1', undefined));
    assert.deepEqual(tabIdsOf(store.getState().tabs, 'g'), ['t1', 't2']);
  });

  it('loadDeletedGroups 同代际语义：在途旧回环忽略、新回环应用', async () => {
    const { loadDeletedGroups, deleteTabAndSync } = await slice();
    const store = await makeStore([makeGroup('g', ['t1'])]);

    store.dispatch(loadDeletedGroups.pending('DL-old', undefined));
    // 删掉最后一个 tab → 整组乐观进误删保护视图
    store.dispatch(deleteTabAndSync.pending('D1', { groupId: 'g', tabId: 't1' }));
    assert.equal(store.getState().tabs.deletedGroups.length, 1, '乐观删除应先产生墓碑');

    // 旧回环带着空墓碑列表回来 → 必须丢弃（否则恢复区闪失）
    store.dispatch(loadDeletedGroups.fulfilled([], 'DL-old', undefined));
    assert.equal(store.getState().tabs.deletedGroups.length, 1, '在途旧墓碑回环必须被忽略');

    // 删除落定（用例原意即“落定后”），新回环正常应用
    store.dispatch(
      deleteTabAndSync.fulfilled({ group: null }, 'D1', { groupId: 'g', tabId: 't1' })
    );
    store.dispatch(loadDeletedGroups.pending('DL-new', undefined));
    store.dispatch(loadDeletedGroups.fulfilled([], 'DL-new', undefined));
    assert.equal(store.getState().tabs.deletedGroups.length, 0, '新回环应正常应用');
  });
});

describe('乐观备份 key 化（groupId:tabId）', () => {
  it('快速连点不同 tab：rejected 只回滚对应项，不错位', async () => {
    const { deleteTabAndSync } = await slice();
    const store = await makeStore([makeGroup('g', ['t1', 't2', 't3'])]);

    store.dispatch(deleteTabAndSync.pending('D1', { groupId: 'g', tabId: 't1' }));
    store.dispatch(deleteTabAndSync.pending('D2', { groupId: 'g', tabId: 't2' }));
    assert.deepEqual(tabIdsOf(store.getState().tabs, 'g'), ['t3']);

    // t1 删除失败 → 只恢复 t1，t2 保持删除（旧单槽位会整组回滚到含 t1/t2/t3 的快照）
    store.dispatch(
      deleteTabAndSync.rejected(new Error('net'), 'D1', { groupId: 'g', tabId: 't1' })
    );
    assert.deepEqual(tabIdsOf(store.getState().tabs, 'g'), ['t1', 't3'], '只应回滚 t1');
    assert.ok(
      store.getState().tabs.optimisticBackups?.['g:t2'],
      't2 的备份槽位必须保留'
    );
    assert.ok(
      !store.getState().tabs.optimisticBackups?.['g:t1'],
      't1 的备份槽位必须清除'
    );
  });

  it('同代际在途回环不复活 tab：pending 之后发起的 load（快照同代际）过滤在途项', async () => {
    const { loadGroups, deleteTabAndSync } = await slice();
    const store = await makeStore([makeGroup('g', ['t1', 't2'])]);
    // 点击删 t1：pending 自增 epoch，乐观删除
    store.dispatch(deleteTabAndSync.pending('D1', { groupId: 'g', tabId: 't1' }));
    // load 在 pending 之后发起 → 快照 epoch 与当前相同 → isStaleLoad=false（残留窗口）
    store.dispatch(loadGroups.pending('L-after', undefined));
    // 它读到的是 SW 落盘前的旧 KV：payload 仍含 t1
    store.dispatch(
      loadGroups.fulfilled([makeGroup('g', ['t1', 't2'])], 'L-after', undefined)
    );
    assert.deepEqual(tabIdsOf(store.getState().tabs, 'g'), ['t2'], '在途被删的 t1 不得复活');
  });

  it('同代际在途回环不复活整组：唯一在途 tab 被删时组不进 active', async () => {
    const { loadGroups, deleteTabAndSync } = await slice();
    const store = await makeStore([makeGroup('g', ['t1'])]);
    store.dispatch(deleteTabAndSync.pending('D1', { groupId: 'g', tabId: 't1' }));
    assert.equal(store.getState().tabs.deletedGroups.length, 1, '整组乐观进误删保护视图');
    store.dispatch(loadGroups.pending('L-after', undefined));
    store.dispatch(loadGroups.fulfilled([makeGroup('g', ['t1'])], 'L-after', undefined));
    assert.equal(store.getState().tabs.groups.length, 0, '整组在途软删，active 不得复活');
    assert.equal(store.getState().tabs.deletedGroups.length, 1, '误删保护视图保留（pending 加入）');
  });

  it('同代际在途回环保留回收站中在途软删的组：旧 KV payload 不得将其清出', async () => {
    const { loadGroups, loadDeletedGroups, deleteTabAndSync } = await slice();
    const store = await makeStore([makeGroup('g', ['t1'])]);
    store.dispatch(deleteTabAndSync.pending('D1', { groupId: 'g', tabId: 't1' }));
    // 回收站回环在 pending 之后发起（同代际）：旧 KV 还没有 g 墓碑 → payload 为空
    store.dispatch(loadDeletedGroups.pending('DL-after', undefined));
    store.dispatch(loadDeletedGroups.fulfilled([], 'DL-after', undefined));
    assert.equal(
      store.getState().tabs.deletedGroups.length, 1,
      '在途整组软删不得被旧 payload 清出回收站'
    );
    // 删除落定后，后续回收站回环正常应用（不饿死）
    store.dispatch(
      deleteTabAndSync.fulfilled({ group: null }, 'D1', { groupId: 'g', tabId: 't1' })
    );
    store.dispatch(loadDeletedGroups.pending('DL-new', undefined));
    store.dispatch(loadDeletedGroups.fulfilled([], 'DL-new', undefined));
    assert.equal(store.getState().tabs.deletedGroups.length, 0, '落定后新回环正常应用');
  });

  it('无在途备份时回环原样应用（过滤器不误伤）', async () => {
    const { loadGroups } = await slice();
    const store = await makeStore([makeGroup('g', ['t1'])]);
    store.dispatch(loadGroups.pending('L-plain', undefined));
    store.dispatch(
      loadGroups.fulfilled([makeGroup('g2', ['t9'])], 'L-plain', undefined)
    );
    assert.deepEqual(store.getState().tabs.groups.map(g => g.id), ['g2']);
  });

  it('不同组的连点互不干扰', async () => {
    const { deleteTabAndSync } = await slice();
    const store = await makeStore([makeGroup('g1', ['a1']), makeGroup('g2', ['b1', 'b2'])]);

    store.dispatch(deleteTabAndSync.pending('D1', { groupId: 'g1', tabId: 'a1' }));
    store.dispatch(deleteTabAndSync.pending('D2', { groupId: 'g2', tabId: 'b1' }));
    // g1 被拿空 → 进误删保护视图
    assert.equal(tabIdsOf(store.getState().tabs, 'g1'), null);
    assert.deepEqual(tabIdsOf(store.getState().tabs, 'g2'), ['b2']);

    store.dispatch(
      deleteTabAndSync.rejected(new Error('net'), 'D2', { groupId: 'g2', tabId: 'b1' })
    );
    assert.deepEqual(tabIdsOf(store.getState().tabs, 'g2'), ['b1', 'b2'], 'g2 应完整回滚 b1');
    assert.equal(tabIdsOf(store.getState().tabs, 'g1'), null, 'g1 的乐观态不得被错位恢复');
  });

  it('拿空组的 rejected：整组从误删保护视图恢复，墓碑清除', async () => {
    const { deleteTabAndSync } = await slice();
    const store = await makeStore([makeGroup('g', ['t1'])]);

    store.dispatch(deleteTabAndSync.pending('D1', { groupId: 'g', tabId: 't1' }));
    assert.equal(store.getState().tabs.deletedGroups.length, 1);

    store.dispatch(
      deleteTabAndSync.rejected(new Error('net'), 'D1', { groupId: 'g', tabId: 't1' })
    );
    assert.deepEqual(tabIdsOf(store.getState().tabs, 'g'), ['t1'], '组应带着 t1 回到主列表');
    assert.equal(store.getState().tabs.deletedGroups.length, 0, '乐观墓碑必须清除');
  });

  it('fulfilled 只清对应项 + 重放同组在途删除（先到的服务端真值不得复活后删项）', async () => {
    const { deleteTabAndSync } = await slice();
    const store = await makeStore([makeGroup('g', ['t1', 't2'])]);

    store.dispatch(deleteTabAndSync.pending('D1', { groupId: 'g', tabId: 't1' }));
    store.dispatch(deleteTabAndSync.pending('D2', { groupId: 'g', tabId: 't2' }));
    // D1 的服务端回包（只删了 t1，还含 t2）先到 → 不得把 t2 复活回主列表
    // （组已被 D2 乐观拿空进误删保护视图，stale 回包不得复活它）
    store.dispatch(
      deleteTabAndSync.fulfilled({ group: makeGroup('g', ['t2']) }, 'D1', {
        groupId: 'g',
        tabId: 't1',
      })
    );
    const allLiveTabs = store.getState().tabs.groups.flatMap(g => g.tabs.map(t => t.id));
    assert.ok(!allLiveTabs.includes('t2'), 't2 仍在途，不得被回填复活');
    assert.equal(tabIdsOf(store.getState().tabs, 'g'), null, '组应保持乐观墓碑态，不被 stale 回包复活');
    assert.ok(
      store.getState().tabs.optimisticBackups?.['g:t2'],
      't2 的备份槽位必须保留到其自身落定'
    );
    // D2 落定（组空）→ 整组软删
    store.dispatch(
      deleteTabAndSync.fulfilled({ group: null }, 'D2', { groupId: 'g', tabId: 't2' })
    );
    assert.equal(tabIdsOf(store.getState().tabs, 'g'), null);
    assert.deepEqual(store.getState().tabs.optimisticBackups ?? {}, {}, '全部落定后备份应清空');
  });

  it('组仍在时 fulfilled 回填重放同组在途删除（先到真值不复活后删项）', async () => {
    const { deleteTabAndSync } = await slice();
    const store = await makeStore([makeGroup('g', ['t1', 't2', 't3'])]);

    store.dispatch(deleteTabAndSync.pending('D1', { groupId: 'g', tabId: 't1' }));
    store.dispatch(deleteTabAndSync.pending('D2', { groupId: 'g', tabId: 't2' }));
    assert.deepEqual(tabIdsOf(store.getState().tabs, 'g'), ['t3']);
    // D1 回包（只删了 t1，还含 t2/t3）先到 → 回填后重放 D2 的在途删除
    store.dispatch(
      deleteTabAndSync.fulfilled({ group: makeGroup('g', ['t2', 't3']) }, 'D1', {
        groupId: 'g',
        tabId: 't1',
      })
    );
    assert.deepEqual(tabIdsOf(store.getState().tabs, 'g'), ['t3'], 't2 仍在途，不得被回填复活');
    // D2 回包（删了 t1/t2，剩 t3）后到 → 正常回填
    store.dispatch(
      deleteTabAndSync.fulfilled({ group: makeGroup('g', ['t3']) }, 'D2', {
        groupId: 'g',
        tabId: 't2',
      })
    );
    assert.deepEqual(tabIdsOf(store.getState().tabs, 'g'), ['t3']);
    assert.deepEqual(store.getState().tabs.optimisticBackups ?? {}, {}, '全部落定后备份应清空');
  });
});

describe('rejected 恢复分支反转修复 + pending 幽灵占位', () => {
  it('同组拿空后其中一处 rejected：只恢复自身，在途同组项不可见', async () => {
    const { deleteTabAndSync } = await slice();
    const store = await makeStore([makeGroup('g', ['t1', 't2'])]);

    store.dispatch(deleteTabAndSync.pending('D1', { groupId: 'g', tabId: 't1' }));
    store.dispatch(deleteTabAndSync.pending('D2', { groupId: 'g', tabId: 't2' }));
    assert.equal(tabIdsOf(store.getState().tabs, 'g'), null, '两处 pending 应拿空组');

    // D1 失败回滚：应恢复 [t1]，仍在途的 t2 不得被复活
    store.dispatch(
      deleteTabAndSync.rejected(new Error('net'), 'D1', { groupId: 'g', tabId: 't1' })
    );
    assert.deepEqual(tabIdsOf(store.getState().tabs, 'g'), ['t1'], 'D1 rejected 应只恢复 t1');
    const allLive = store.getState().tabs.groups.flatMap(g => g.tabs.map(t => t.id));
    assert.ok(!allLive.includes('t2'), '在途的 t2 不得被 rejected 复活');
    assert.ok(
      store.getState().tabs.optimisticBackups?.['g:t2'],
      't2 的备份槽位必须保留'
    );
  });

  it('pending 目标不存在：不建幽灵占位、不 bump epoch', async () => {
    const { deleteTabAndSync } = await slice();
    const store = await makeStore([makeGroup('g', ['t1'])]);
    const epochBefore = store.getState().tabs.mutationEpoch;

    store.dispatch(deleteTabAndSync.pending('D-ghost', { groupId: 'g', tabId: 'missing' }));
    assert.deepEqual(tabIdsOf(store.getState().tabs, 'g'), ['t1'], '列表不得变化');
    assert.equal(
      store.getState().tabs.mutationEpoch,
      epochBefore,
      'epoch 不得前进'
    );
    assert.ok(
      !store.getState().tabs.optimisticBackups?.['g:missing'],
      '不得创建幽灵备份槽位'
    );
  });
});
