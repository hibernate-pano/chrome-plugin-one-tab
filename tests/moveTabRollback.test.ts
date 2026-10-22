// P3 · moveTab 写失败 UI 必须回滚（纯 reducer + thunk 行为，无 chrome / 无 SW）。
//
// 背景：moveTabAndSync 先乐观 dispatch(moveTab(...))（列表顺序立即变），
// 存储写走 sendMutation（SW 忙/被回收 → 30s 超时 → rejected）。原先 rejected
// 是空实现：报错但顺序已变，磁盘仍是旧顺序，下次 loadGroups 回环把列表打回
// （写失败 + UI 不回滚 + 静默分叉三连）。
//
// 锁三件事（照抄同文件 deleteTabAndSync.rejected 的写法 :693-717）：
//  1) 明确失败 → 用写入前快照整体换回（磁盘确实没变，换回即收敛）；
//  2) 超时 → 同样换回 + 统一超时文案（与 delete 三条路径同一判据 isTimeoutFailure）；
//  3) 交叉：快照里有、当前已被并发 deleteGroup 拿掉的组不恢复 —— 否则「删了又回来」。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbHciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};
const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

before(async () => {
  register(LOADER_PATH);
});

const NOW = '2026-10-01T00:00:00.000Z';

function tab(id: string) {
  return {
    id, url: `https://example.com/${id}`, title: `tab ${id}`, favicon: '',
    createdAt: NOW, lastAccessed: NOW, pinned: false,
  };
}

function makeGroup(id: string, tabIds: string[], overrides: Record<string, unknown> = {}) {
  return {
    id, name: `group-${id}`, tabs: tabIds.map(tab),
    createdAt: NOW, updatedAt: NOW, isLocked: false, version: 1,
    ...overrides,
  };
}

async function makeStore(seeds: ReturnType<typeof makeGroup>[] = []) {
  const { configureStore } = await import('@reduxjs/toolkit');
  const { default: tabReducer, setGroups } = await import('@/store/slices/tabSlice');
  const store = configureStore({ reducer: { tabs: tabReducer } });
  if (seeds.length > 0) store.dispatch(setGroups(seeds as never));
  return store;
}

const slice = () => import('@/store/slices/tabSlice');
const idsOf = (store: { getState: () => { tabs: { groups: { id: string; tabs: { id: string }[] }[] } } }, id: string) =>
  store.getState().tabs.groups.find(g => g.id === id)?.tabs.map(t => t.id);

describe('P3 moveTab 写失败：乐观顺序必须收回', () => {
  it('明确失败 → 顺序回到写入前快照（磁盘没变，换回即收敛）', async () => {
    const { moveTab, moveTabAndSync } = await slice();
    const store = await makeStore([makeGroup('g1', ['a', 'b', 'c']), makeGroup('g2', ['e', 'f'])]);

    // 乐观移动照常发生（thunk 内部就是先 dispatch 它）：b 从 g1 搬到 g2
    store.dispatch(moveTab({ sourceGroupId: 'g1', sourceIndex: 1, targetGroupId: 'g2', targetIndex: 0 }));
    assert.deepEqual(idsOf(store, 'g1'), ['a', 'c']);
    assert.deepEqual(idsOf(store, 'g2'), ['b', 'e', 'f']);

    // 模拟 thunk 在写入前抓的快照 + sendMutation 明确失败走 rejectWithValue
    const snapshot = [makeGroup('g1', ['a', 'b', 'c']), makeGroup('g2', ['e', 'f'])];
    store.dispatch(
      moveTabAndSync.rejected(
        new Error('SW 拒绝写入'),
        'R1',
        { sourceGroupId: 'g1', sourceIndex: 1, targetGroupId: 'g2', targetIndex: 0 },
        { snapshot: snapshot as never }
      )
    );

    assert.deepEqual(idsOf(store, 'g1'), ['a', 'b', 'c'], 'g1 顺序必须回到写入前');
    assert.deepEqual(idsOf(store, 'g2'), ['e', 'f'], 'g2 顺序必须回到写入前');
    assert.equal(store.getState().tabs.errorSource, 'action', '写路径失败必须标 action 来源');
    assert.ok(store.getState().tabs.error, '必须留错误信号（供 TabGroup 的 catch 出声）');
  });

  it('超时 → 同样换回 + 统一超时文案（与 delete 三条路径同一判据）', async () => {
    const { moveTab, moveTabAndSync } = await slice();
    const store = await makeStore([makeGroup('g1', ['a', 'b'])]);

    store.dispatch(moveTab({ sourceGroupId: 'g1', sourceIndex: 0, targetGroupId: 'g1', targetIndex: 1 }));
    assert.deepEqual(idsOf(store, 'g1'), ['b', 'a']);

    const snapshot = [makeGroup('g1', ['a', 'b'])];
    store.dispatch(
      moveTabAndSync.rejected(
        new Error('操作超时（超过 30 秒无响应）：moveTab'),
        'R2',
        { sourceGroupId: 'g1', sourceIndex: 0, targetGroupId: 'g1', targetIndex: 1 },
        { snapshot: snapshot as never }
      )
    );

    assert.deepEqual(idsOf(store, 'g1'), ['a', 'b'], '超时同样回滚：下次 loadGroups 回环读真值自动收敛');
    assert.match(
      store.getState().tabs.error ?? '',
      /后台可能仍在继续/,
      '超时文案必须说清「可能仍在继续」，而不是谎报失败'
    );
  });

  it('交叉：快照里有、当前已被并发 deleteGroup 拿掉的组不恢复（防「删了又回来」）', async () => {
    const { moveTab, moveTabAndSync, deleteGroup } = await slice();
    const store = await makeStore([
      makeGroup('g1', ['a', 'b', 'c']),
      makeGroup('g2', ['e', 'f']),
      makeGroup('gone', ['z']),
    ]);

    // 写入前快照（含 gone 组）
    const snapshot = [
      makeGroup('g1', ['a', 'b', 'c']),
      makeGroup('g2', ['e', 'f']),
      makeGroup('gone', ['z']),
    ];
    // 乐观移动先发生
    store.dispatch(moveTab({ sourceGroupId: 'g1', sourceIndex: 1, targetGroupId: 'g2', targetIndex: 0 }));
    // 并发：用户在移动在途时删掉了 gone 组（整组移除已生效）
    store.dispatch(deleteGroup.pending('D1', 'gone'));
    assert.equal(
      store.getState().tabs.groups.some(g => g.id === 'gone'),
      false,
      '前置条件：gone 组已被乐观删除拿掉'
    );

    // 移动写失败 → 回滚
    store.dispatch(
      moveTabAndSync.rejected(
        new Error('SW 拒绝写入'),
        'R3',
        { sourceGroupId: 'g1', sourceIndex: 1, targetGroupId: 'g2', targetIndex: 0 },
        { snapshot: snapshot as never }
      )
    );

    assert.deepEqual(idsOf(store, 'g1'), ['a', 'b', 'c'], '移动两端组的顺序照旧恢复');
    assert.deepEqual(idsOf(store, 'g2'), ['e', 'f']);
    assert.equal(
      store.getState().tabs.groups.some(g => g.id === 'gone'),
      false,
      'gone 组不得被这次回滚带回来：它的删除意图在途（若组删除随后也失败，那次 rejected 会按自己的备份带回，不丢）'
    );
  });

  it('成功路径不受影响：fulfilled 不碰顺序、不写 error', async () => {
    const { moveTab, moveTabAndSync } = await slice();
    const store = await makeStore([makeGroup('g1', ['a', 'b'])]);

    store.dispatch(moveTab({ sourceGroupId: 'g1', sourceIndex: 0, targetGroupId: 'g1', targetIndex: 1 }));
    store.dispatch(
      moveTabAndSync.fulfilled(
        {
          value: {
            sourceGroupId: 'g1',
            sourceIndex: 0,
            targetGroupId: 'g1',
            targetIndex: 1,
            removedGroupId: null,
            // 2026-10-23 DS-43-11：thunk 的 payload 多了源会话名字（搬空源组时要报名字）。
            // 这条用例只关心顺序与 error，名字取 null 即可（类型要对得上）。
            sourceGroupName: null,
          },
        },
        'F1',
        { sourceGroupId: 'g1', sourceIndex: 0, targetGroupId: 'g1', targetIndex: 1 }
      )
    );

    assert.deepEqual(idsOf(store, 'g1'), ['b', 'a'], '成功后保持乐观结果');
    assert.equal(store.getState().tabs.error, null);
  });

  it('TabGroup 的移动失败出口仍在（回滚是静默的，出声靠组件 catch）', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath: f2p } = await import('node:url');
    const { dirname: dn, resolve: rs } = await import('node:path');
    const here = dn(f2p(import.meta.url));
    const src = readFileSync(rs(here, '../src/components/tabs/TabGroup.tsx'), 'utf8');
    assert.match(src, /moveTabAndSync\(\{/, 'TabGroup 仍经 moveTabAndSync 派发移动');
    assert.match(src, /移动标签失败/, '移动失败仍向用户出声（回滚本身不提示，提示靠这里）');
  });

  // ── 2026-10-11 P1：交叉不止组级，tab 级同样会被复活 ──────────────────────
  // 修复前只按「组 id」过滤（liveIds），组内 tab 的在途删除不在过滤范围内，
  // 于是下面这条实测成立的复活：g2 从 ["b","f"] 被换回 ["e","f"]。
  it('P1：在途被删除的 tab 不得被回滚复活（「删了又回来」的 tab 粒度）', async () => {
    const { moveTab, moveTabAndSync, deleteTabAndSync } = await slice();
    const store = await makeStore([makeGroup('g1', ['a', 'b']), makeGroup('g2', ['e', 'f'])]);

    const snapshot = [makeGroup('g1', ['a', 'b']), makeGroup('g2', ['e', 'f'])];
    // 乐观移动：b 从 g1 搬到 g2 的 0
    store.dispatch(moveTab({ sourceGroupId: 'g1', sourceIndex: 1, targetGroupId: 'g2', targetIndex: 0 }));
    assert.deepEqual(idsOf(store, 'g2'), ['b', 'e', 'f']);

    // 交叉：移动在途时用户删掉了 g2 里的 e（deleteTab 已乐观移除并登记备份）
    store.dispatch(deleteTabAndSync.pending('D1', { groupId: 'g2', tabId: 'e' }));
    assert.deepEqual(idsOf(store, 'g2'), ['b', 'f'], '前置条件：e 已被乐观删除');

    // 移动写失败 → 回滚
    store.dispatch(
      moveTabAndSync.rejected(
        new Error('SW 拒绝写入'),
        'R4',
        { sourceGroupId: 'g1', sourceIndex: 1, targetGroupId: 'g2', targetIndex: 0 },
        { snapshot: snapshot as never }
      )
    );

    assert.equal(
      idsOf(store, 'g2')?.includes('e'),
      false,
      '在途删除的 tab 被回滚复活 —— 无回收站/无撤销下这就是数据复活'
    );
    assert.deepEqual(idsOf(store, 'g1'), ['a', 'b'], 'g1 顺序照旧恢复');
  });

  it('P1：回滚不得误删「锁定的空组」（合法的「清空后留着」状态）', async () => {
    const { moveTab, moveTabAndSync, deleteTabAndSync } = await slice();
    // locked + 0 tabs 是用户显式清空最后一个标签后留下的合法状态
    //（applyRemoveTab 走锁定豁免就会留下这种组），不是空壳垃圾。
    const store = await makeStore([
      makeGroup('g1', ['a', 'b']),
      makeGroup('locked', [], { isLocked: true }),
    ]);
    const liveIds = () => store.getState().tabs.groups.map(g => g.id);

    const snapshot = [makeGroup('g1', ['a', 'b']), makeGroup('locked', [], { isLocked: true })];
    store.dispatch(moveTab({ sourceGroupId: 'g1', sourceIndex: 1, targetGroupId: 'g1', targetIndex: 0 }));
    store.dispatch(deleteTabAndSync.pending('D1', { groupId: 'g1', tabId: 'a' }));
    store.dispatch(
      moveTabAndSync.rejected(
        new Error('SW 拒绝写入'),
        'R5',
        { sourceGroupId: 'g1', sourceIndex: 1, targetGroupId: 'g1', targetIndex: 0 },
        { snapshot: snapshot as never }
      )
    );

    assert.ok(
      liveIds().includes('locked'),
      '锁定的空组被回滚误删：它没有任何在途删除，stripInFlightDeletions 的「剥空后整组丢弃」分支不应命中它'
    );
  });
});
