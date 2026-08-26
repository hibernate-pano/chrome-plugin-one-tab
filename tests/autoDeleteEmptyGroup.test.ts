// 回归：拖拽把最后一个标签移出会话后，空会话必须「立即」关闭（消失），
// 不能依赖异步 deleteGroup dispatch 的时序。
//
// 历史回归：空组删除逻辑曾被移到 SortableTabGroup/isMarkedForDeletion 组件，
// 该组件已移除，只剩 moveTabAndSync rAF→setTimeout 的 100ms 异步 deleteGroup——
// 一旦落空，空组永久卡在 UI（“移走最后一个标签，空组不消失”）。
// 修复：moveTab reducer 跨组移走最后一枚 tab 时同步墓碑化（熄灭空组）。

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

const NOW = '2026-06-04T08:00:00.000Z';

function tab(id: string) {
  return { id, url: `https://${id}.com`, title: id, createdAt: NOW, lastAccessed: NOW, pinned: false };
}

function makeState(groups: Array<{ id: string; tabs: string[]; isLocked?: boolean }>) {
  const g = groups.map(x => ({
    id: x.id,
    name: `g-${x.id}`,
    tabs: x.tabs.map(tab),
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: !!x.isLocked,
    version: 1,
  }));
  return {
    groups: g,
    deletedGroups: [] as any[],
    activeGroupId: null as string | null,
    isLoading: false,
    error: null,
    searchQuery: '',
    syncStatus: 'idle' as const,
    lastSyncTime: null,
    lastLoadedAt: null,
    lastSyncStatus: null,
    backgroundSync: false,
    syncProgress: 0,
    syncOperation: 'none' as const,
  };
}

before(async () => {
  register(LOADER_PATH);
});

describe('autoDeleteEmptyGroup: 移走最后一个标签 → 空会话立即关闭', () => {
  it('跨组移走源组唯一标签 → 源空组立即从主列表消失并进入已删除区', async () => {
    const { default: reducer, moveTab } = await import('@/store/slices/tabSlice');
    const state = makeState([
      { id: 'A', tabs: ['t1'] }, // 唯一标签
      { id: 'B', tabs: ['t2'] },
    ]);

    const next = reducer(state, moveTab({
      sourceGroupId: 'A', sourceIndex: 0,
      targetGroupId: 'B', targetIndex: 0,
    }));

    assert.equal(
      next.groups.some(g => g.id === 'A'),
      false,
      '空的未锁定源组应立即从主列表移除（不再卡住）'
    );
    assert.equal(
      next.deletedGroups.some(g => g.id === 'A'),
      true,
      '被自动关闭的组进入已删除区（可恢复）'
    );
    assert.equal(next.groups.some(g => g.id === 'B'), true, '目标组保留');
    // 被移走的标签已在目标组
    assert.equal(next.groups.find(g => g.id === 'B')!.tabs.some(t => t.id === 't1'), true);
  });

  it('目标组已有该标签时不重复添加（去重）', async () => {
    const { default: reducer, moveTab } = await import('@/store/slices/tabSlice');
    const state = makeState([
      { id: 'A', tabs: ['t1'] },
      { id: 'B', tabs: ['t1', 't2'] },
    ]);

    const next = reducer(state, moveTab({
      sourceGroupId: 'A', sourceIndex: 0,
      targetGroupId: 'B', targetIndex: 0,
    }));

    assert.equal(next.groups.some(g => g.id === 'A'), false, '源空组关闭');
    const b = next.groups.find(g => g.id === 'B')!;
    assert.equal(b.tabs.filter(t => t.id === 't1').length, 1, '目标组不重复添加 t1');
  });

  it('锁定的空源组不自动关闭（保留）', async () => {
    const { default: reducer, moveTab } = await import('@/store/slices/tabSlice');
    const state = makeState([
      { id: 'A', tabs: ['t1'], isLocked: true },
      { id: 'B', tabs: ['t2'] },
    ]);

    const next = reducer(state, moveTab({
      sourceGroupId: 'A', sourceIndex: 0,
      targetGroupId: 'B', targetIndex: 0,
    }));

    assert.equal(
      next.groups.some(g => g.id === 'A' && g.tabs.length === 0),
      true,
      '锁定组变空后应保留（不自动删除）'
    );
  });

  it('同组内移动不会误删组', async () => {
    const { default: reducer, moveTab } = await import('@/store/slices/tabSlice');
    const state = makeState([{ id: 'A', tabs: ['t1', 't2'] }]);

    const next = reducer(state, moveTab({
      sourceGroupId: 'A', sourceIndex: 0,
      targetGroupId: 'A', targetIndex: 1,
    }));

    assert.equal(next.groups.some(g => g.id === 'A'), true, '同组移动不删组');
    assert.deepEqual(
      next.groups[0].tabs.map(t => t.id),
      ['t2', 't1'],
      '同组内顺序调整正确'
    );
  });
});
