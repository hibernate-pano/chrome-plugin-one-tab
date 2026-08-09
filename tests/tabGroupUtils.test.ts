// tabGroupUtils 测试：标签组自动删除逻辑（核心 UX 规则）
//
// 「空标签组是否自动删除」是 TabStack 的 UX 决策点之一：
// - 锁定的空组保留（用户主动锁住，保留作为占位）
// - 未锁定的空组自动清理（避免 UI 显示空状态）
//
// 这些函数被 tabSlice.deleteGroup / removeTab 等深度使用，
// 任何回归都会导致「删了最后一个 tab 但空组留在 UI」或「锁住的组被误删」。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

const NOW = '2026-06-04T08:00:00.000Z';

function makeGroup(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'g-1',
    name: 'Test',
    tabs: [{ id: 't-1', url: 'https://x.com', title: 'X', createdAt: NOW, lastAccessed: NOW, pinned: false }],
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

describe('shouldAutoDeleteGroup', () => {
  it('空 + 未锁定 → 应自动删除', async () => {
    const { shouldAutoDeleteGroup } = await import('@/utils/tabGroupUtils');
    const g = makeGroup({ tabs: [] });
    assert.equal(shouldAutoDeleteGroup(g), true);
  });

  it('空 + 锁定 → 不应自动删除', async () => {
    const { shouldAutoDeleteGroup } = await import('@/utils/tabGroupUtils');
    const g = makeGroup({ tabs: [], isLocked: true });
    assert.equal(shouldAutoDeleteGroup(g), false, '锁定的空组保留作为占位');
  });

  it('非空 + 未锁定 → 不应自动删除', async () => {
    const { shouldAutoDeleteGroup } = await import('@/utils/tabGroupUtils');
    const g = makeGroup({ tabs: [{ id: 't-1' }] });
    assert.equal(shouldAutoDeleteGroup(g), false);
  });

  it('tabs 字段缺失 → 视为空', async () => {
    const { shouldAutoDeleteGroup } = await import('@/utils/tabGroupUtils');
    const g = makeGroup();
    delete g.tabs;
    assert.equal(shouldAutoDeleteGroup(g), true);
  });
});

describe('shouldAutoDeleteAfterTabRemoval', () => {
  it('删除最后一个 tab 后未锁定 → 应自动删除', async () => {
    const { shouldAutoDeleteAfterTabRemoval } = await import('@/utils/tabGroupUtils');
    const g = makeGroup({ tabs: [{ id: 't-1' }] });
    assert.equal(shouldAutoDeleteAfterTabRemoval(g, 't-1'), true);
  });

  it('删除最后一个 tab 后锁定 → 不应自动删除', async () => {
    const { shouldAutoDeleteAfterTabRemoval } = await import('@/utils/tabGroupUtils');
    const g = makeGroup({ tabs: [{ id: 't-1' }], isLocked: true });
    assert.equal(shouldAutoDeleteAfterTabRemoval(g, 't-1'), false);
  });

  it('删除后还有剩余 tab → 不应自动删除', async () => {
    const { shouldAutoDeleteAfterTabRemoval } = await import('@/utils/tabGroupUtils');
    const g = makeGroup({ tabs: [{ id: 't-1' }, { id: 't-2' }] });
    assert.equal(shouldAutoDeleteAfterTabRemoval(g, 't-1'), false);
  });

  it('删除不存在的 tab → 不应自动删除', async () => {
    const { shouldAutoDeleteAfterTabRemoval } = await import('@/utils/tabGroupUtils');
    const g = makeGroup({ tabs: [{ id: 't-1' }] });
    assert.equal(shouldAutoDeleteAfterTabRemoval(g, 't-nonexistent'), false);
  });
});

describe('shouldAutoDeleteAfterMultipleTabRemoval', () => {
  it('批量删除后空 + 未锁定 → 应自动删除', async () => {
    const { shouldAutoDeleteAfterMultipleTabRemoval } = await import('@/utils/tabGroupUtils');
    const g = makeGroup({ tabs: [{ id: 't-1' }, { id: 't-2' }] });
    assert.equal(shouldAutoDeleteAfterMultipleTabRemoval(g, ['t-1', 't-2']), true);
  });

  it('批量删除后还剩 → 不应自动删除', async () => {
    const { shouldAutoDeleteAfterMultipleTabRemoval } = await import('@/utils/tabGroupUtils');
    const g = makeGroup({ tabs: [{ id: 't-1' }, { id: 't-2' }, { id: 't-3' }] });
    assert.equal(shouldAutoDeleteAfterMultipleTabRemoval(g, ['t-1', 't-2']), false);
  });

  it('批量删除空数组 → 不应自动删除（保留组）', async () => {
    const { shouldAutoDeleteAfterMultipleTabRemoval } = await import('@/utils/tabGroupUtils');
    const g = makeGroup({ tabs: [{ id: 't-1' }] });
    assert.equal(shouldAutoDeleteAfterMultipleTabRemoval(g, []), false);
  });

  it('锁定组即使批量删空 → 不应自动删除', async () => {
    const { shouldAutoDeleteAfterMultipleTabRemoval } = await import('@/utils/tabGroupUtils');
    const g = makeGroup({ tabs: [{ id: 't-1' }], isLocked: true });
    assert.equal(shouldAutoDeleteAfterMultipleTabRemoval(g, ['t-1']), false);
  });
});

describe('filterAutoDeleteGroups', () => {
  it('过滤掉空的未锁定组，保留其他', async () => {
    const { filterAutoDeleteGroups } = await import('@/utils/tabGroupUtils');
    const groups = [
      makeGroup({ id: 'g-1', tabs: [] }),                              // 应删
      makeGroup({ id: 'g-2', tabs: [{ id: 't-1' }] }),                 // 保留
      makeGroup({ id: 'g-3', tabs: [], isLocked: true }),              // 保留（锁定）
      makeGroup({ id: 'g-4', tabs: [{ id: 't-1' }, { id: 't-2' }] }),  // 保留
    ];
    const filtered = filterAutoDeleteGroups(groups);
    assert.deepEqual(
      filtered.map(g => g.id),
      ['g-2', 'g-3', 'g-4'],
      '只过滤空的未锁定组'
    );
  });

  it('空数组返回空数组', async () => {
    const { filterAutoDeleteGroups } = await import('@/utils/tabGroupUtils');
    assert.deepEqual(filterAutoDeleteGroups([]), []);
  });
});

describe('getAutoDeleteGroups', () => {
  it('返回所有应自动删除的组', async () => {
    const { getAutoDeleteGroups } = await import('@/utils/tabGroupUtils');
    const groups = [
      makeGroup({ id: 'g-1', tabs: [] }),
      makeGroup({ id: 'g-2', tabs: [{ id: 't-1' }] }),
      makeGroup({ id: 'g-3', tabs: [] }),
    ];
    const autoDelete = getAutoDeleteGroups(groups);
    assert.deepEqual(
      autoDelete.map(g => g.id),
      ['g-1', 'g-3']
    );
  });
});

describe('getEmptyGroupsStats', () => {
  it('正确统计空组、锁定空组、可自动删除空组', async () => {
    const { getEmptyGroupsStats } = await import('@/utils/tabGroupUtils');
    const groups = [
      makeGroup({ id: 'g-1', tabs: [] }),                              // 空+未锁
      makeGroup({ id: 'g-2', tabs: [] }),                              // 空+未锁
      makeGroup({ id: 'g-3', tabs: [], isLocked: true }),              // 空+锁
      makeGroup({ id: 'g-4', tabs: [{ id: 't-1' }] }),                 // 非空
    ];
    const stats = getEmptyGroupsStats(groups);
    assert.deepEqual(stats, {
      totalGroups: 4,
      emptyGroups: 3,
      lockedEmptyGroups: 1,
      autoDeleteGroups: 2,
    });
  });

  it('没有空组时 emptyGroups=0', async () => {
    const { getEmptyGroupsStats } = await import('@/utils/tabGroupUtils');
    const groups = [
      makeGroup({ tabs: [{ id: 't-1' }] }),
      makeGroup({ tabs: [{ id: 't-2' }] }),
    ];
    const stats = getEmptyGroupsStats(groups);
    assert.equal(stats.emptyGroups, 0);
    assert.equal(stats.lockedEmptyGroups, 0);
    assert.equal(stats.autoDeleteGroups, 0);
  });
});
