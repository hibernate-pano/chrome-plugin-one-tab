// 复现：显式删除会话 与 在途的单标签删除失败 相互干扰，导致已删会话复活。
//
// 这是「加 deleteGroup 乐观更新」之前就必须修掉的既有缺陷：
//   1. 用户删掉会话里的一个标签（deleteTabAndSync 在途，建了备份 + 抓了整组快照）；
//   2. 用户紧接着删掉整个会话（deleteGroup 把组移除）；
//   3. 那个标签删除失败（网络抖动 / SW 无响应）→ deleteTabAndSync.rejected；
//   4. rejected 发现组不在，走「按快照恢复整组」分支 → unshift 把整组连同标签
//      全部塞回列表。
// 结果：用户明确删掉的会话原地复活，而且 v1.22.0 起没有回收站，
// 用户看到的就是「删了又回来」。
//
// deleteTabAndSync.rejected 的注释里枚举过「组不在」的两种成因（本项拿空了组 /
// 他项删除整组移除），漏了第三种：整组被显式删除。显式删除是用户的**当前意图**，
// 优先级必须高于一次失败标签删除的回滚。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Tab, TabGroup } from '@/types/tab';

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

const NOW = '2026-10-04T10:00:00.000Z';

function mkTab(id: string): Tab {
  return { id, url: `https://e.com/${id}`, title: id, favicon: '', createdAt: NOW, lastAccessed: NOW, pinned: false };
}

function mkGroup(id: string, tabs: Tab[]): TabGroup {
  return { id, name: `g-${id}`, tabs, createdAt: NOW, updatedAt: NOW, version: 1, isLocked: false };
}

async function makeStore(groups: TabGroup[]) {
  const { configureStore } = await import('@reduxjs/toolkit');
  const mod = await import('@/store/slices/tabSlice');
  const store = configureStore({ reducer: { tabs: mod.default } });
  store.dispatch(mod.setGroups(groups as never));
  return { store, mod };
}

describe('显式删除会话后，在途标签删除失败不得复活该会话', () => {
  it('deleteGroup 之后 deleteTabAndSync.rejected：组不回来', async () => {
    const { store, mod } = await makeStore([
      mkGroup('g1', [mkTab('t1'), mkTab('t2')]),
      mkGroup('g2', [mkTab('other')]),
    ]);

    // 1) 用户删掉 g1 里的 t1（在途，建备份 + 抓快照）
    store.dispatch(mod.deleteTabAndSync.pending('req-tab', { groupId: 'g1', tabId: 't1' }));
    assert.equal(
      store.getState().tabs.groups.find(g => g.id === 'g1')!.tabs.some(t => t.id === 't1'),
      false,
      '前置条件：t1 已乐观移除'
    );

    // 2) 用户紧接着删掉整个 g1
    store.dispatch(mod.deleteGroup.pending('req-del', 'g1'));
    store.dispatch(mod.deleteGroup.fulfilled({ value: 'g1' }, 'req-del', 'g1'));
    assert.equal(
      store.getState().tabs.groups.some(g => g.id === 'g1'),
      false,
      '前置条件：g1 已被显式删除'
    );

    // 3) 那次标签删除失败
    store.dispatch(
      mod.deleteTabAndSync.rejected({ message: '网络失败' } as never, 'req-tab', {
        groupId: 'g1',
        tabId: 't1',
      })
    );

    const groups = store.getState().tabs.groups;
    assert.deepEqual(
      groups.map(g => g.id),
      ['g2'],
      'g1 是用户显式删掉的，绝不能被一次失败的标签删除复活'
    );
  });

  it('deleteGroup 乐观移除后，同一时刻的 loadGroups 旧回环也不得复活它', async () => {
    const groups = [mkGroup('g1', [mkTab('t1')]), mkGroup('g2', [mkTab('t2')])];
    const { store, mod } = await makeStore(groups);

    // 回环先发起（读到的是删除前的快照），删除让代际前进，回环再回来
    store.dispatch(mod.loadGroups.pending('req-load', undefined));
    store.dispatch(mod.deleteGroup.pending('req-del', 'g1'));
    store.dispatch(mod.loadGroups.fulfilled(groups as never, 'req-load', undefined));

    assert.deepEqual(
      store.getState().tabs.groups.map(g => g.id),
      ['g2'],
      '旧代际回环必须被忽略'
    );
  });

  it('deleteGroup 失败时整组还原（乐观结果不能留成假象）', async () => {
    const { store, mod } = await makeStore([mkGroup('g1', [mkTab('t1'), mkTab('t2')])]);
    store.dispatch(mod.deleteGroup.pending('req-del', 'g1'));
    assert.equal(store.getState().tabs.groups.length, 0, '前置条件：乐观已移除');

    store.dispatch(
      mod.deleteGroup.rejected({ message: '删除失败' } as never, 'req-del', 'g1')
    );
    const state = store.getState().tabs;
    assert.deepEqual(state.groups.map(g => g.id), ['g1'], '磁盘没删，UI 必须还原');
    assert.deepEqual(
      state.groups[0].tabs.map(t => t.id),
      ['t1', 't2'],
      '还原必须带回完整的标签列表'
    );
    assert.equal(state.error, '删除失败');
  });

  it('没有显式删除意图时，原有恢复语义保持不变（本项拿空组 → 按快照恢复）', async () => {
    // 回归保护：这条路径是 deleteTabAndSync.rejected 原本要处理的正确场景，
    // 修「复活」时不能把它一起弄坏。
    const { store, mod } = await makeStore([mkGroup('g1', [mkTab('t1')])]);
    // 删掉组里唯一的标签 → 乐观整组移除（applyRemoveTab 语义）
    store.dispatch(mod.deleteTabAndSync.pending('req-tab', { groupId: 'g1', tabId: 't1' }));
    assert.equal(store.getState().tabs.groups.length, 0, '前置条件：组被拿空后整组移除');

    store.dispatch(
      mod.deleteTabAndSync.rejected({ message: '网络失败' } as never, 'req-tab', {
        groupId: 'g1',
        tabId: 't1',
      })
    );
    assert.deepEqual(
      store.getState().tabs.groups.map(g => g.id),
      ['g1'],
      '没有显式删除意图时，失败回滚仍应把组恢复回来'
    );
  });
});

describe('备份作废时机：只在 fulfilled（磁盘确认）作废，不在 pending（乐观意图）作废', () => {
  it('组删除成功后，在途标签删除的备份被作废（不再有复活载体）', async () => {
    const { store, mod } = await makeStore([mkGroup('g1', [mkTab('t1'), mkTab('t2')])]);
    store.dispatch(mod.deleteTabAndSync.pending('req-tab', { groupId: 'g1', tabId: 't1' }));
    store.dispatch(mod.deleteGroup.pending('req-del', 'g1'));
    store.dispatch(mod.deleteGroup.fulfilled({ value: 'g1' }, 'req-del', 'g1'));
    assert.deepEqual(
      store.getState().tabs.optimisticBackups ?? {},
      {},
      '磁盘上组已不存在，备份已无从回滚，必须作废'
    );
  });

  it('组删除仅 pending（未落盘）时备份保留：给 rejected 还原留出插回标签的依据', async () => {
    const { store, mod } = await makeStore([mkGroup('g1', [mkTab('t1'), mkTab('t2')])]);
    store.dispatch(mod.deleteTabAndSync.pending('req-tab', { groupId: 'g1', tabId: 't1' }));
    store.dispatch(mod.deleteGroup.pending('req-del', 'g1'));
    assert.ok(
      store.getState().tabs.optimisticBackups?.['g1:t1'],
      'pending 只是乐观意图，磁盘还没删，备份必须留着'
    );
  });

  it('组删除失败还原后，在途标签删除再失败：标签插回原位，不漏一个', async () => {
    // 这是「只在 fulfilled 作废」换来的正确性：组删除失败 → 整组还原 →
    // 标签备份仍在 → 标签删除失败时走「组仍在」分支把 t1 插回。
    // 若在 pending 就作废备份，这里会漏掉 t1（UI 少显示，而磁盘上它还在）。
    const { store, mod } = await makeStore([mkGroup('g1', [mkTab('t1'), mkTab('t2')])]);

    store.dispatch(mod.deleteTabAndSync.pending('req-tab', { groupId: 'g1', tabId: 't1' }));
    store.dispatch(mod.deleteGroup.pending('req-del', 'g1'));
    // 组删除失败 → 整组还原
    store.dispatch(mod.deleteGroup.rejected({ message: '删除失败' } as never, 'req-del', 'g1'));
    assert.deepEqual(
      store.getState().tabs.groups.map(g => g.id),
      ['g1'],
      '前置条件：组已还原'
    );

    // 标签删除也失败 → t1 必须回到列表（磁盘上它从未被删掉）
    store.dispatch(
      mod.deleteTabAndSync.rejected({ message: '网络失败' } as never, 'req-tab', {
        groupId: 'g1',
        tabId: 't1',
      })
    );
    assert.deepEqual(
      store.getState().tabs.groups.find(g => g.id === 'g1')!.tabs.map(t => t.id),
      ['t1', 't2'],
      '两个删除都失败 ⇒ 数据必须完整回来，不能漏 t1'
    );
  });

  it('组删除失败还原时按原下标插回（列表顺序不跳变）', async () => {
    const { store, mod } = await makeStore([
      mkGroup('g0', [mkTab('a')]),
      mkGroup('g1', [mkTab('b')]),
      mkGroup('g2', [mkTab('c')]),
    ]);
    store.dispatch(mod.deleteGroup.pending('req-del', 'g1'));
    store.dispatch(mod.deleteGroup.rejected({ message: '失败' } as never, 'req-del', 'g1'));
    assert.deepEqual(
      store.getState().tabs.groups.map(g => g.id),
      ['g0', 'g1', 'g2'],
      '还原后必须回到原位置，而不是被追加到末尾'
    );
  });

  it('并发删除不同会话：各自的备份互不干扰', async () => {
    const { store, mod } = await makeStore([
      mkGroup('g1', [mkTab('a')]),
      mkGroup('g2', [mkTab('b')]),
    ]);
    store.dispatch(mod.deleteGroup.pending('req-1', 'g1'));
    store.dispatch(mod.deleteGroup.pending('req-2', 'g2'));
    assert.equal(store.getState().tabs.groups.length, 0, '两组都乐观移除');

    // g1 成功、g2 失败 → 只有 g2 回来
    store.dispatch(mod.deleteGroup.fulfilled({ value: 'g1' }, 'req-1', 'g1'));
    store.dispatch(mod.deleteGroup.rejected({ message: '失败' } as never, 'req-2', 'g2'));
    assert.deepEqual(store.getState().tabs.groups.map(g => g.id), ['g2']);
    assert.deepEqual(
      store.getState().tabs.deletedGroupBackups ?? {},
      {},
      '两个备份都已消费完毕'
    );
  });
});

describe('复活窗口：组删除仅乐观移除（未落定）时，标签删除失败不得把组带回来', () => {
  it('deleteGroup.pending 在途 + deleteTabAndSync.rejected：组不复活', async () => {
    // 时序：
    //   1. 用户删 g1 里的 t1（在途，备份 + 整组快照）
    //   2. 用户删整个 g1（乐观移除；deleteGroup 尚未落定，t1 的备份仍在）
    //   3. t1 的删除失败 → deleteTabAndSync.rejected 发现「组不在」，
    //      按快照 unshift 恢复整组 → g1 复活（磁盘上它其实已被删/正在删）
    // 这是 v1.22.9 给 deleteGroup 加乐观更新后**新引入**的窗口：
    // 修复前组删除只在 fulfilled 才移除，那时备份已被作废（见 deleteGroup.fulfilled）。
    const { store, mod } = await makeStore([
      mkGroup('g1', [mkTab('t1'), mkTab('t2')]),
      mkGroup('g2', [mkTab('other')]),
    ]);

    store.dispatch(mod.deleteTabAndSync.pending('req-tab', { groupId: 'g1', tabId: 't1' }));
    store.dispatch(mod.deleteGroup.pending('req-del', 'g1'));
    assert.deepEqual(
      store.getState().tabs.groups.map(g => g.id),
      ['g2'],
      '前置条件：g1 已乐观移除'
    );

    store.dispatch(
      mod.deleteTabAndSync.rejected({ message: '网络失败' } as never, 'req-tab', {
        groupId: 'g1',
        tabId: 't1',
      })
    );

    assert.deepEqual(
      store.getState().tabs.groups.map(g => g.id),
      ['g2'],
      'g1 正处于「用户已删除、等待落定」状态，不得被一次失败的标签删除复活'
    );
  });

  it('组删除失败还原后，那次标签删除失败仍能正确插回（不丢标签）', async () => {
    // 对照：组删除**失败**时，标签备份必须还在并被正确使用。
    const { store, mod } = await makeStore([mkGroup('g1', [mkTab('t1'), mkTab('t2')])]);

    store.dispatch(mod.deleteTabAndSync.pending('req-tab', { groupId: 'g1', tabId: 't1' }));
    store.dispatch(mod.deleteGroup.pending('req-del', 'g1'));
    // 组删除失败 → 整组还原（含 t1，因为磁盘上什么都没删）
    store.dispatch(mod.deleteGroup.rejected({ message: '删除失败' } as never, 'req-del', 'g1'));
    // 标签删除也失败 → t1 必须回来
    store.dispatch(
      mod.deleteTabAndSync.rejected({ message: '网络失败' } as never, 'req-tab', {
        groupId: 'g1',
        tabId: 't1',
      })
    );

    assert.deepEqual(
      store.getState().tabs.groups.find(g => g.id === 'g1')?.tabs.map(t => t.id),
      ['t1', 't2'],
      '两个删除都失败 ⇒ 数据完整回来'
    );
  });
});
