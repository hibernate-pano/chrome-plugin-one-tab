// 清理重复标签（cleanDuplicates）卫生回归（无墓碑模型，2026-09-29）：
// 1) core 语义 —— applyCleanDuplicates 同 URL 留最新，败者**物理移除**（无墓碑）；
//    被清空且未锁定的组整组物理移除。去重范围 = 全部组（物理模型下不存在墓碑组）。
// 2) UI 不变量 —— Redux 主状态 state.groups 只含活跃视图（loadGroups 建立的不变量）。
//    cleanDuplicateTabs.fulfilled 曾把 SW 返回的 storage 全量直接赋给 state.groups，
//    出现"223/994 → 230/1106"的反增。老版本设备仍可能写入墓碑形状数据，
//    toActiveGroupsView 防御层必须把它剥在主状态之外。
//
// 说明：直接 dispatch fulfilled action creator（不执行 thunk 体，无需 mock
// sendMutation），与 tests/deleteTabRace.test.ts 同模式。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
// 纯类型导入：编译期擦除，运行时零依赖，故不受「@/ 必须 register(loader) 后动态 import」的约束。
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

const NOW = '2026-09-28T10:00:00.000Z';
const OLD = '2026-01-01T00:00:00.000Z';
const STAMP = { d: 'devTest', s: 1 };

// over 收紧为 Partial<...>：用 Record<string, unknown> 会给结果带上索引签名，
// tabs 退化成 unknown[]，传给 applyCleanDuplicates 时判为不兼容（TS2322）。
function mkTab(id: string, over: Partial<Tab> = {}): Tab {
  return {
    id,
    url: `https://e.com/${id}`,
    title: id,
    favicon: '',
    createdAt: OLD,
    lastAccessed: OLD,
    pinned: false,
    ...over,
  };
}

function mkGroup(id: string, tabs: Tab[], over: Partial<TabGroup> = {}): TabGroup {
  return {
    id,
    name: `g-${id}`,
    tabs,
    createdAt: OLD,
    updatedAt: OLD,
    version: 1,
    isLocked: false,
    ...over,
  };
}

describe('applyCleanDuplicates：物理移除语义（无墓碑）', () => {
  it('同 URL 跨组去重：败者物理移除，胜者保留', async () => {
    const { applyCleanDuplicates } = await import('@/core/mutationOps');
    const older = mkTab('older', { url: 'https://dup.com', lastAccessed: OLD });
    const newer = mkTab('newer', { url: 'https://dup.com', lastAccessed: NOW });
    const g1 = mkGroup('g1', [older]);
    const g2 = mkGroup('g2', [newer]);

    const { groups, plan } = applyCleanDuplicates([g1, g2], NOW, STAMP);

    assert.equal(plan.removedTabsCount, 1);
    assert.equal(groups.some(g => g.id === 'g1'), false, '败者所在组被清空 → 整组物理移除');
    assert.equal(groups.find(g => g.id === 'g2')!.tabs.some(t => t.id === 'newer'), true);
    assert.deepEqual(plan.removedGroupIds, ['g1']);
  });

  it('被清空且未锁定的组整组物理移除，removedGroupIds 回报广播 id', async () => {
    const { applyCleanDuplicates } = await import('@/core/mutationOps');
    const stale = mkTab('stale2', { url: 'https://dup.com', lastAccessed: OLD });
    const fresh = mkTab('fresh', { url: 'https://dup.com', lastAccessed: NOW });
    const g1 = mkGroup('g1', [fresh]);
    const g2 = mkGroup('g2', [stale]);

    const { groups, plan } = applyCleanDuplicates([g1, g2], NOW, STAMP);

    assert.equal(plan.removedGroupsCount, 1);
    assert.equal(groups.some(g => g.id === 'g2'), false, '被清空的组被物理移除');
    assert.deepEqual(plan.removedGroupIds, ['g2']);
  });

  it('锁定组被清空后保留空壳（锁定豁免自动删除）', async () => {
    const { applyCleanDuplicates } = await import('@/core/mutationOps');
    const stale = mkTab('stale', { url: 'https://dup.com', lastAccessed: OLD });
    const fresh = mkTab('fresh', { url: 'https://dup.com', lastAccessed: NOW });
    const g1 = mkGroup('g1', [fresh]);
    const gLocked = mkGroup('gLocked', [stale], { isLocked: true });

    const { groups, plan } = applyCleanDuplicates([g1, gLocked], NOW, STAMP);

    assert.equal(plan.removedGroupsCount, 0);
    const out = groups.find(g => g.id === 'gLocked')!;
    assert.equal(out.tabs.length, 0);
    assert.equal(out.isLocked, true);
  });
});

describe('cleanDuplicateTabs.fulfilled：不把墓碑形状数据灌入 Redux 主状态', () => {
  /**
   * 契约变更（v1.22.9）：SW 不再回传 groups 全量，只回传删除计划 + now/stamp。
   * 原先那条「payload 里的墓碑被剥掉」的失效模式在结构上已不可能发生
   * （payload 里根本没有 groups）。但**同一条不变量**仍然必须成立：
   * 主状态永远只含活跃视图。现在它由两处保证：
   *   - 基线来自 pending 抓的快照（由 loadGroups 建立，已是活跃视图）；
   *   - 收尾再过一次 toActiveGroupsView（见 applyCleanPlanToActiveView）。
   * 本用例把第二处钉住：即便基线里混进了墓碑形状数据，也不许留在主状态里。
   */
  it('基线里混入墓碑形状数据时，收尾防御层仍把它剥掉', async () => {
    const { configureStore } = await import('@reduxjs/toolkit');
    const { default: tabReducer, setGroups } = await import('@/store/slices/tabSlice');
    const { cleanDuplicateTabs } = await import('@/store/slices/tabSlice');

    const store = configureStore({ reducer: { tabs: tabReducer } });

    // 模拟老版本设备写入的 storage 全量：2 个活跃组（其中 1 个混 1 个墓碑 tab）
    // + 2 个组级墓碑组（组内 tab 活跃）——对应线上 223/994 → 230/1106 的形态。
    // 直接用 setGroups 灌入，绕过 loadGroups 的过滤，以检验 fulfilled 自己的防御。
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
    store.dispatch(setGroups(storageSnapshot as never));

    // pending 抓快照并乐观应用；随后 fulfilled 用 SW 的权威计划从快照重推。
    store.dispatch(cleanDuplicateTabs.pending('req-1', undefined));
    store.dispatch(
      cleanDuplicateTabs.fulfilled(
        {
          plan: {
            removedTabsByGroup: [{ groupId: 'g1', tabIds: ['g1-t2'] }],
            removedGroupIds: [],
            removedTabsCount: 1,
            removedGroupsCount: 0,
          },
          now: NOW,
          stamp: STAMP,
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
      ['g1-t1'],
      '主状态组内不得包含墓碑 tab；计划里点名的 g1-t2 也已被移除'
    );
  });
});
