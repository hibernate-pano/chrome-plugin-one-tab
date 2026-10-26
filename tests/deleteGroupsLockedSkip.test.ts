// deleteGroups 的 fulfilled 语义：**执行时刻**被锁定跳过的会话磁盘上还在，
// 不得从 Redux 列表里消失。
//
// 【要防的缺陷】pending 把清单里所有 id 乐观移除；SW 在执行时发现其中一个已被
// 另一台设备锁定 ⇒ 跳过它（磁盘上它还在）。若 fulfilled 只按 meta.arg filter，
// 那一组会在列表里消失、下次 loadGroups 又回来 —— 正是本仓最忌讳的
// 「删了又回来」：用户会去重试，也会怀疑数据完整性。
//
// 断言口径（照 tests/groupDeleteVsTabDelete.test.ts 的 store 手法）：
// 直接 dispatch thunk 的 pending / fulfilled action，检查纯 reducer 结果。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Tab, TabGroup } from '@/types/tab';
import { TIMEOUT_REASON_PREFIX } from '@/core/mutationProtocol';

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

const NOW = '2026-10-26T10:00:00.000Z';

function mkTab(id: string): Tab {
  return { id, url: `https://e.com/${id}`, title: id, favicon: '', createdAt: NOW, lastAccessed: NOW, pinned: false };
}

function mkGroup(id: string, tabs: Tab[], overrides: Partial<TabGroup> = {}): TabGroup {
  return { id, name: `g-${id}`, tabs, createdAt: NOW, updatedAt: NOW, version: 1, isLocked: false, ...overrides };
}

async function makeStore(groups: TabGroup[]) {
  const { configureStore } = await import('@reduxjs/toolkit');
  const mod = await import('@/store/slices/tabSlice');
  const store = configureStore({ reducer: { tabs: mod.default } });
  store.dispatch(mod.setGroups(groups as never));
  return { store, mod };
}

const idsOf = (store: { getState: () => { tabs: { groups: { id: string }[] } } }) =>
  store.getState().tabs.groups.map(g => g.id);

describe('deleteGroups.fulfilled：执行时被锁定跳过的会话必须留在列表里', () => {
  it('三个 id 里有一个执行时已锁定 ⇒ 它还在，且位置与删除前一致', async () => {
    const { store, mod } = await makeStore([
      mkGroup('x', [mkTab('tx')]),
      mkGroup('g0', [mkTab('t0')]),
      mkGroup('g1', [mkTab('t1a'), mkTab('t1b')], { isLocked: true }),
      mkGroup('g2', [mkTab('t2')]),
      mkGroup('y', [mkTab('ty')]),
    ]);
    const groupIds = ['g0', 'g1', 'g2'];

    store.dispatch(mod.deleteGroups.pending('req-del', groupIds));
    assert.deepEqual(idsOf(store), ['x', 'y'], '前置：三个都先乐观移除');

    store.dispatch(
      mod.deleteGroups.fulfilled(
        { value: { count: 2, skippedLocked: 1, skippedLockedIds: ['g1'] } },
        'req-del',
        groupIds
      )
    );

    assert.deepEqual(
      idsOf(store),
      ['x', 'g1', 'y'],
      '执行时被锁定的 g1 磁盘上还在，必须回到删除前的位置（不是在末尾，也不是消失）'
    );
    assert.deepEqual(
      store.getState().tabs.groups.find(g => g.id === 'g1')!.tabs.map(t => t.id),
      ['t1a', 't1b'],
      '放回的是完整整组快照'
    );
  });

  it('被跳过的 id 从 deletedGroupBackups 里清掉（备份已消费，不能留给下一次回滚）', async () => {
    const { store, mod } = await makeStore([
      mkGroup('g0', [mkTab('t0')]),
      mkGroup('g1', [mkTab('t1')], { isLocked: true }),
      mkGroup('g2', [mkTab('t2')]),
    ]);
    const groupIds = ['g0', 'g1', 'g2'];

    store.dispatch(mod.deleteGroups.pending('req-del', groupIds));
    store.dispatch(
      mod.deleteGroups.fulfilled(
        { value: { count: 2, skippedLocked: 1, skippedLockedIds: ['g1'] } },
        'req-del',
        groupIds
      )
    );

    assert.deepEqual(
      store.getState().tabs.deletedGroupBackups ?? {},
      {},
      '成功回执后所有请求 id 的回滚基线都必须清掉，否则一次失败的标签删除会按陈旧备份把整组再插一遍'
    );
  });

  it('被跳过组的单标签删除备份保留：那次标签删除失败时还能把标签插回原位', async () => {
    const { store, mod } = await makeStore([
      mkGroup('g1', [mkTab('t1'), mkTab('t2')], { isLocked: true }),
    ]);

    // 用户在清理在途时先删掉了 g1 里的 t1（单标签删除还没落定）
    store.dispatch(mod.deleteTabAndSync.pending('req-tab', { groupId: 'g1', tabId: 't1' }));
    store.dispatch(mod.deleteGroups.pending('req-del', ['g1']));
    assert.equal(store.getState().tabs.groups.length, 0, '前置：g1 乐观移除');

    // SW 因锁定跳过 g1 ⇒ g1 回到列表（快照是 t1 乐观移除后的那份）
    store.dispatch(
      mod.deleteGroups.fulfilled(
        { value: { count: 0, skippedLocked: 1, skippedLockedIds: ['g1'] } },
        'req-del',
        ['g1']
      )
    );
    assert.deepEqual(idsOf(store), ['g1']);
    assert.ok(
      store.getState().tabs.optimisticBackups?.['g1:t1'],
      '组在磁盘上还在 ⇒ 它的标签备份仍要用于回滚'
    );

    // 那次标签删除失败：t1 必须插回原位，而不是随着备份一起被作废
    store.dispatch(
      mod.deleteTabAndSync.rejected({ message: '网络失败' } as never, 'req-tab', {
        groupId: 'g1',
        tabId: 't1',
      })
    );
    assert.deepEqual(
      store.getState().tabs.groups.find(g => g.id === 'g1')!.tabs.map(t => t.id),
      ['t1', 't2'],
      '被锁定跳过 ≠ 组被删掉：标签回滚仍必须生效'
    );
  });
});

// ── 并发批次 ──────────────────────────────────────────────────────────────
//
// 评审反例（列表 [A,B,C,D]，B 在别的设备上被锁）：
//   1) deleteGroups(['B','C']) pending → 列表 [A,D]
//   2) deleteGroups(['A'])     pending → 列表 [D]
//   3) 后一批先回包（A 真删）
//   4) 前一批回包（B 被跳过、C 真删）
// 若用备份里的数字下标反推位置，B 会被插到 D 之后 ⇒ [D,B]。
// 正确结果只应由「原顺序」决定：[B,D]。且回包先后反转也必须得到同一结果。
describe('并发批次：锁定跳过的插回位置与回包先后无关', () => {
  const seed = () => [
    mkGroup('A', [mkTab('ta')]),
    mkGroup('B', [mkTab('tb')], { isLocked: true }),
    mkGroup('C', [mkTab('tc')]),
    mkGroup('D', [mkTab('td')]),
  ];
  const fulfilledOf = (
    mod: Awaited<ReturnType<typeof makeStore>>['mod'],
    requestId: string,
    groupIds: string[],
    payload: { count: number; skippedLocked: number; skippedLockedIds: string[] }
  ) => mod.deleteGroups.fulfilled({ value: payload }, requestId, groupIds);

  it('后发起的一批先回包：最终仍是 [B,D]，B 在 D 之前', async () => {
    const { store, mod } = await makeStore(seed());

    store.dispatch(mod.deleteGroups.pending('req-1', ['B', 'C']));
    store.dispatch(mod.deleteGroups.pending('req-2', ['A']));
    assert.deepEqual(idsOf(store), ['D'], '前置：两批都乐观移除');

    // 后一批（A 真删）先回包
    store.dispatch(
      fulfilledOf(mod, 'req-2', ['A'], { count: 1, skippedLocked: 0, skippedLockedIds: [] })
    );
    // 前一批回包：B 执行时已锁定被跳过，C 真删
    store.dispatch(
      fulfilledOf(mod, 'req-1', ['B', 'C'], { count: 1, skippedLocked: 1, skippedLockedIds: ['B'] })
    );

    assert.deepEqual(idsOf(store), ['B', 'D'], 'B 必须回到 D 之前（回包顺序不得影响结果）');
  });

  it('回包顺序反过来：结果相同（[B,D]）', async () => {
    const { store, mod } = await makeStore(seed());

    store.dispatch(mod.deleteGroups.pending('req-1', ['B', 'C']));
    store.dispatch(mod.deleteGroups.pending('req-2', ['A']));

    // 先发起的一批先回包
    store.dispatch(
      fulfilledOf(mod, 'req-1', ['B', 'C'], { count: 1, skippedLocked: 1, skippedLockedIds: ['B'] })
    );
    // 注意：A 已被 req-2 的 pending 乐观移除，此刻列表只有 D + 插回的 B。
    assert.deepEqual(idsOf(store), ['B', 'D'], 'B 插回 D 之前');
    store.dispatch(
      fulfilledOf(mod, 'req-2', ['A'], { count: 1, skippedLocked: 0, skippedLockedIds: [] })
    );

    assert.deepEqual(idsOf(store), ['B', 'D'], 'A 随后落定，最终与另一种回包顺序逐字相同');
  });

  it('两批都落定后，顺序快照不泄漏', async () => {
    const { store, mod } = await makeStore(seed());
    store.dispatch(mod.deleteGroups.pending('req-1', ['B', 'C']));
    store.dispatch(mod.deleteGroups.pending('req-2', ['A']));
    store.dispatch(
      fulfilledOf(mod, 'req-2', ['A'], { count: 1, skippedLocked: 0, skippedLockedIds: [] })
    );
    store.dispatch(
      fulfilledOf(mod, 'req-1', ['B', 'C'], { count: 1, skippedLocked: 1, skippedLockedIds: ['B'] })
    );
    assert.deepEqual(store.getState().tabs.deleteGroupsOrder ?? {}, {}, '两批都结束时快照必须清空');
  });
});

// ── rejected：超时 vs 明确失败 ────────────────────────────────────────────
describe('deleteGroups.rejected：超时保留乐观移除，明确失败才还原', () => {
  it('超时 ⇒ 不插回（SW 侧可能已删完），只如实报错', async () => {
    const { store, mod } = await makeStore([
      mkGroup('x', [mkTab('tx')]),
      mkGroup('g1', [mkTab('t1')]),
      mkGroup('y', [mkTab('ty')]),
    ]);
    store.dispatch(mod.deleteGroups.pending('req-del', ['g1']));
    assert.deepEqual(idsOf(store), ['x', 'y'], '前置：乐观移除');

    store.dispatch(
      mod.deleteGroups.rejected(
        new Error(`${TIMEOUT_REASON_PREFIX}（超过 30 秒无响应）：deleteGroups`),
        'req-del',
        ['g1']
      )
    );

    assert.deepEqual(idsOf(store), ['x', 'y'], '超时不等于删除没发生：不得把会话插回列表');
    assert.ok(store.getState().tabs.error?.startsWith(TIMEOUT_REASON_PREFIX));
    assert.match(store.getState().tabs.error ?? '', /可能仍在继续/, '必须说清后台可能仍在继续');
    assert.deepEqual(store.getState().tabs.deletedGroupBackups ?? {}, {}, '备份已消费');
    assert.deepEqual(store.getState().tabs.deleteGroupsOrder ?? {}, {}, '顺序快照已清空');
  });

  it('明确失败 ⇒ 按备份插回原位（磁盘没变）', async () => {
    const { store, mod } = await makeStore([
      mkGroup('x', [mkTab('tx')]),
      mkGroup('g1', [mkTab('t1')]),
      mkGroup('y', [mkTab('ty')]),
    ]);
    store.dispatch(mod.deleteGroups.pending('req-del', ['g1']));

    store.dispatch(mod.deleteGroups.rejected(new Error('删除失败'), 'req-del', ['g1']));

    assert.deepEqual(idsOf(store), ['x', 'g1', 'y'], '明确失败磁盘没变，必须回到原位置');
    assert.equal(store.getState().tabs.error, '删除失败');
    assert.deepEqual(store.getState().tabs.deletedGroupBackups ?? {}, {}, '备份已消费');
    assert.deepEqual(store.getState().tabs.deleteGroupsOrder ?? {}, {}, '顺序快照已清空');
  });
});
