// 清理重复标签的「乐观更新 + 权威收敛」回归（v1.22.9 契约）。
//
// 修复前：UI 反馈完全依赖 SW 回传的 updatedGroups 全量 —— 用户点下去之后，
// 要等「排队 → 读全量 → 计算 → 写全量 → 跨进程克隆几 MB 回来 → 全量重算 → 全量重渲染」
// 整条链跑完，列表才动一下。而磁盘其实早就改完了。
// 修复后：pending 阶段用同一个纯函数在本地算计划并立即应用；fulfilled 用 SW 回传的
// 权威计划从快照重推收敛。
//
// 这份测试钉的是**新机制特有的失效模式**，而不是去重规则本身（那在
// tests/cleanDuplicatesHygiene.test.ts / tests/mutationOps.test.ts）：
// 1) pending 必须立刻见效（不能仍等 fulfilled）；
// 2) fulfilled 必须从快照重推 —— 本地计划若与 SW 不一致（popup 状态陈旧），
//    叠加乐观结果是**补不回来**的，只有重推才无条件等于磁盘真值；
// 3) rejected 必须整段还原（乐观结果不能留成假象）；
// 4) 在途的并发单标签删除不能被重推复活；
// 5) 代际必须前进，否则一次在途 loadGroups 回环会把刚清掉的重复标签整批复活。
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
const OLD = '2026-01-01T00:00:00.000Z';
const STAMP = { d: 'devSW', s: 42 };

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

/** 建一个带初始 groups 的 store（用 setGroups 灌入，不经 loadGroups 的过滤）。 */
async function makeStore(groups: TabGroup[]) {
  const { configureStore } = await import('@reduxjs/toolkit');
  const mod = await import('@/store/slices/tabSlice');
  const store = configureStore({ reducer: { tabs: mod.default } });
  store.dispatch(mod.setGroups(groups as never));
  return { store, mod };
}

/**
 * 造一份 SW 风格的 fulfilled payload。
 *
 * 形状是 `{ value: { plan, now, stamp }, broadcastWarn? }`（见 DeleteOpResult）：
 * 清理会物理移除整组，所以广播登记失败必须能随载荷一起传到 UI（2026-10-06 修）。
 */
function swResult(plan: Record<string, unknown>) {
  return { value: { plan, now: NOW, stamp: STAMP } };
}

describe('cleanDuplicateTabs.pending：立即见效，不等 SW', () => {
  it('乐观应用后重复标签当场消失（无需 fulfilled）', async () => {
    const groups = [
      mkGroup('g1', [
        mkTab('newer', { url: 'https://dup.com', lastAccessed: NOW }),
        mkTab('older', { url: 'https://dup.com', lastAccessed: OLD }),
      ]),
    ];
    const { store, mod } = await makeStore(groups);
    store.dispatch(mod.cleanDuplicateTabs.pending('req-1', undefined));

    const g1 = store.getState().tabs.groups.find(g => g.id === 'g1')!;
    assert.deepEqual(
      g1.tabs.map(t => t.id),
      ['newer'],
      'pending 阶段就该看到结果，这是「点完立刻 OK」的前提'
    );
  });

  it('被清空且未锁定的组在 pending 阶段就整组消失', async () => {
    const groups = [
      mkGroup('keep', [mkTab('k1', { url: 'https://dup.com', lastAccessed: NOW })]),
      mkGroup('gone', [mkTab('g1', { url: 'https://dup.com', lastAccessed: OLD })]),
    ];
    const { store, mod } = await makeStore(groups);
    store.dispatch(mod.cleanDuplicateTabs.pending('req-1', undefined));
    assert.deepEqual(
      store.getState().tabs.groups.map(g => g.id),
      ['keep']
    );
  });

  it('锁定组被清空后不在主状态留空卡（活跃视图不变量）', async () => {
    const groups = [
      mkGroup('keep', [mkTab('k1', { url: 'https://dup.com', lastAccessed: NOW })]),
      mkGroup('locked', [mkTab('l1', { url: 'https://dup.com', lastAccessed: OLD })], { isLocked: true }),
    ];
    const { store, mod } = await makeStore(groups);
    store.dispatch(mod.cleanDuplicateTabs.pending('req-1', undefined));
    const ids = store.getState().tabs.groups.map(g => g.id);
    assert.deepEqual(ids, ['keep'], '锁定空壳在磁盘上保留，但主状态只含活跃视图');
  });

  it('pending 不置 isLoading（列表不该整页转圈）', async () => {
    const { store, mod } = await makeStore([mkGroup('g1', [mkTab('t1')])]);
    store.dispatch(mod.cleanDuplicateTabs.pending('req-1', undefined));
    assert.equal(store.getState().tabs.isLoading, false);
  });

  it('pending 抓下清理前快照，供 fulfilled 重推 / rejected 还原', async () => {
    const groups = [
      mkGroup('g1', [
        mkTab('newer', { url: 'https://dup.com', lastAccessed: NOW }),
        mkTab('older', { url: 'https://dup.com', lastAccessed: OLD }),
      ]),
    ];
    const { store, mod } = await makeStore(groups);
    store.dispatch(mod.cleanDuplicateTabs.pending('req-1', undefined));
    const snap = store.getState().tabs.cleanDuplicatesSnapshot;
    assert.ok(snap, '必须抓快照');
    assert.deepEqual(
      snap!.find(g => g.id === 'g1')!.tabs.map(t => t.id),
      ['newer', 'older'],
      '快照是清理前的样子（含将被删的那条）'
    );
  });

  it('pending 前进代际：此后到达的旧 loadGroups 回环不得复活已清标签', async () => {
    const groups = [
      mkGroup('g1', [
        mkTab('newer', { url: 'https://dup.com', lastAccessed: NOW }),
        mkTab('older', { url: 'https://dup.com', lastAccessed: OLD }),
      ]),
    ];
    const { store, mod } = await makeStore(groups);
    // 顺序即语义：loadGroups 必须**先**发起（pending 注册 guard，记下发起时的代际），
    // 清理再让代际前进；最后旧回环带着清理前的快照回来 —— 此时它已落后于当前代际，
    // 必须被忽略。若清理在 load 之前发起，这个用例就测不到「旧回环」这件事了。
    store.dispatch(mod.loadGroups.pending('req-stale', undefined));

    const epochBefore = store.getState().tabs.mutationEpoch ?? 0;
    store.dispatch(mod.cleanDuplicateTabs.pending('req-1', undefined));
    const epochAfter = store.getState().tabs.mutationEpoch ?? 0;
    assert.ok(epochAfter > epochBefore, '代际必须前进');

    store.dispatch(mod.loadGroups.fulfilled(groups as never, 'req-stale', undefined));
    const g1 = store.getState().tabs.groups.find(g => g.id === 'g1')!;
    assert.deepEqual(
      g1.tabs.map(t => t.id),
      ['newer'],
      '旧代际回环必须被忽略，否则刚清掉的重复标签会整批回来'
    );
  });
});

describe('cleanDuplicateTabs.fulfilled：用 SW 权威计划从快照重推', () => {
  it('本地乐观结果与 SW 计划一致时，收敛后仍是清理后的样子', async () => {
    const groups = [
      mkGroup('g1', [
        mkTab('newer', { url: 'https://dup.com', lastAccessed: NOW }),
        mkTab('older', { url: 'https://dup.com', lastAccessed: OLD }),
      ]),
    ];
    const { store, mod } = await makeStore(groups);
    store.dispatch(mod.cleanDuplicateTabs.pending('req-1', undefined));
    store.dispatch(
      mod.cleanDuplicateTabs.fulfilled(
        swResult({
          removedTabsByGroup: [{ groupId: 'g1', tabIds: ['older'] }],
          removedGroupIds: [],
          removedTabsCount: 1,
          removedGroupsCount: 0,
        }) as never,
        'req-1',
        undefined
      )
    );
    const g1 = store.getState().tabs.groups.find(g => g.id === 'g1')!;
    assert.deepEqual(g1.tabs.map(t => t.id), ['newer']);
    assert.equal(store.getState().tabs.cleanDuplicatesSnapshot, null, '快照用完即清');
  });

  it('收敛结果带上 SW 的 now/stamp（本地视图与磁盘在 LWW 依据上不分叉）', async () => {
    const groups = [
      mkGroup('g1', [
        mkTab('newer', { url: 'https://dup.com', lastAccessed: NOW }),
        mkTab('older', { url: 'https://dup.com', lastAccessed: OLD }),
      ]),
    ];
    const { store, mod } = await makeStore(groups);
    store.dispatch(mod.cleanDuplicateTabs.pending('req-1', undefined));
    store.dispatch(
      mod.cleanDuplicateTabs.fulfilled(
        swResult({
          removedTabsByGroup: [{ groupId: 'g1', tabIds: ['older'] }],
          removedGroupIds: [],
          removedTabsCount: 1,
          removedGroupsCount: 0,
        }) as never,
        'req-1',
        undefined
      )
    );
    const g1 = store.getState().tabs.groups.find(g => g.id === 'g1')!;
    assert.equal(g1.updatedAt, NOW, 'updatedAt 必须来自 SW 的 now');
    assert.deepEqual(g1.lastOp, STAMP, 'lastOp 必须来自 SW 的 stamp');
    assert.equal(g1.version, 2, 'version 由 applyCleanDuplicatesPlan 递增');
  });

  it('【核心】本地计划误删了 SW 认为该留的项时，重推必须补回来（叠加做不到）', async () => {
    // popup 状态陈旧：它以为 t1/t2 是同 URL 重复，本地乐观删掉 t2；
    // 而 SW 拿 storage 真值算出的计划是「什么都没删」。
    // 叠加语义下 t2 永远回不来（popup 又会忽略自己写出的 groups 回声），
    // 于是 UI 与磁盘长期分叉。从快照重推则无条件等于 SW 的结果。
    const groups = [
      mkGroup('g1', [
        mkTab('t1', { url: 'https://a.com', lastAccessed: NOW }),
        mkTab('t2', { url: 'https://a.com', lastAccessed: OLD }),
      ]),
    ];
    const { store, mod } = await makeStore(groups);
    store.dispatch(mod.cleanDuplicateTabs.pending('req-1', undefined));
    assert.equal(
      store.getState().tabs.groups[0].tabs.length,
      1,
      '前置条件：本地乐观确实删掉了一条'
    );

    store.dispatch(
      mod.cleanDuplicateTabs.fulfilled(
        swResult({
          removedTabsByGroup: [],
          removedGroupIds: [],
          removedTabsCount: 0,
          removedGroupsCount: 0,
        }) as never,
        'req-1',
        undefined
      )
    );
    assert.deepEqual(
      store.getState().tabs.groups[0].tabs.map(t => t.id),
      ['t1', 't2'],
      'SW 说没删，UI 就必须回到没删的样子'
    );
  });

  it('SW 计划比本地更激进时（本地没算到的重复），收敛后同样被删掉', async () => {
    const groups = [
      mkGroup('g1', [mkTab('t1', { url: 'https://a.com', lastAccessed: NOW })]),
      mkGroup('g2', [mkTab('t2', { url: 'https://b.com', lastAccessed: NOW })]),
    ];
    const { store, mod } = await makeStore(groups);
    store.dispatch(mod.cleanDuplicateTabs.pending('req-1', undefined));
    assert.equal(store.getState().tabs.groups.length, 2, '前置条件：本地无可清理');

    store.dispatch(
      mod.cleanDuplicateTabs.fulfilled(
        swResult({
          removedTabsByGroup: [{ groupId: 'g2', tabIds: ['t2'] }],
          removedGroupIds: ['g2'],
          removedTabsCount: 1,
          removedGroupsCount: 1,
        }) as never,
        'req-1',
        undefined
      )
    );
    assert.deepEqual(
      store.getState().tabs.groups.map(g => g.id),
      ['g1'],
      'SW 的权威计划必须落地'
    );
  });

  it('没有快照（直接 dispatch fulfilled）时退回当前值，不崩', async () => {
    const { store, mod } = await makeStore([mkGroup('g1', [mkTab('t1')])]);
    store.dispatch(
      mod.cleanDuplicateTabs.fulfilled(
        swResult({
          removedTabsByGroup: [],
          removedGroupIds: [],
          removedTabsCount: 0,
          removedGroupsCount: 0,
        }) as never,
        'req-1',
        undefined
      )
    );
    assert.deepEqual(store.getState().tabs.groups.map(g => g.id), ['g1']);
  });

  it('并发在途的单标签删除不被重推复活（stripInFlightDeletions 仍生效）', async () => {
    const groups = [
      mkGroup('g1', [
        mkTab('keep', { url: 'https://keep.com', lastAccessed: NOW }),
        mkTab('doomed', { url: 'https://doomed.com', lastAccessed: NOW }),
      ]),
    ];
    const { store, mod } = await makeStore(groups);
    // 先乐观删掉 doomed（deleteTabAndSync 的 pending 会建备份 + 前进代际）
    store.dispatch(mod.deleteTabAndSync.pending('req-tab', { groupId: 'g1', tabId: 'doomed' }));
    assert.equal(
      store.getState().tabs.groups[0].tabs.some(t => t.id === 'doomed'),
      false,
      '前置条件：doomed 已被乐观移除且在途'
    );

    store.dispatch(mod.cleanDuplicateTabs.pending('req-1', undefined));
    // SW 的清理计划不涉及 doomed，但重推基线是「清理前快照」，会把在途删除的
    // doomed 带回来 —— stripInFlightDeletions 必须补掉。
    store.dispatch(
      mod.cleanDuplicateTabs.fulfilled(
        swResult({
          removedTabsByGroup: [],
          removedGroupIds: [],
          removedTabsCount: 0,
          removedGroupsCount: 0,
        }) as never,
        'req-1',
        undefined
      )
    );
    assert.deepEqual(
      store.getState().tabs.groups[0].tabs.map(t => t.id),
      ['keep'],
      '在途删除不得被清理的重推复活'
    );
  });
});

describe('cleanDuplicateTabs.rejected：整段还原乐观结果', () => {
  it('清理失败后列表回到清理前（UI 不留假象）', async () => {
    const groups = [
      mkGroup('g1', [
        mkTab('newer', { url: 'https://dup.com', lastAccessed: NOW }),
        mkTab('older', { url: 'https://dup.com', lastAccessed: OLD }),
      ]),
    ];
    const { store, mod } = await makeStore(groups);
    store.dispatch(mod.cleanDuplicateTabs.pending('req-1', undefined));
    assert.equal(store.getState().tabs.groups[0].tabs.length, 1, '前置条件：乐观已生效');

    store.dispatch(
      mod.cleanDuplicateTabs.rejected(
        { message: '清理失败' } as never,
        'req-1',
        undefined
      )
    );
    const state = store.getState().tabs;
    assert.deepEqual(
      state.groups[0].tabs.map(t => t.id),
      ['newer', 'older'],
      '必须还原：磁盘没变，UI 不能显示已删'
    );
    assert.equal(state.error, '清理失败');
    assert.equal(state.cleanDuplicatesSnapshot, null, '快照用完即清');
  });

  it('还原时同样剥掉在途单标签删除（不复活正在删的标签）', async () => {
    const groups = [
      mkGroup('g1', [
        mkTab('keep', { url: 'https://keep.com', lastAccessed: NOW }),
        mkTab('doomed', { url: 'https://doomed.com', lastAccessed: NOW }),
      ]),
    ];
    const { store, mod } = await makeStore(groups);
    store.dispatch(mod.deleteTabAndSync.pending('req-tab', { groupId: 'g1', tabId: 'doomed' }));
    store.dispatch(mod.cleanDuplicateTabs.pending('req-1', undefined));
    store.dispatch(mod.cleanDuplicateTabs.rejected({ message: 'x' } as never, 'req-1', undefined));
    assert.deepEqual(
      store.getState().tabs.groups[0].tabs.map(t => t.id),
      ['keep'],
      '还原不得把在途删除的 doomed 带回来'
    );
  });

  it('没有快照时 rejected 不崩（保留当前 groups）', async () => {
    const { store, mod } = await makeStore([mkGroup('g1', [mkTab('t1')])]);
    store.dispatch(mod.cleanDuplicateTabs.rejected({ message: 'x' } as never, 'req-1', undefined));
    assert.deepEqual(store.getState().tabs.groups.map(g => g.id), ['g1']);
    assert.equal(store.getState().tabs.error, 'x');
  });

  it('【超时】不得整段还原：SW 可能已删完，还原就是让用户看到「删了又回来」', async () => {
    const { TIMEOUT_REASON_PREFIX } = await import('@/core/mutationProtocol');
    const groups = [
      mkGroup('g1', [
        mkTab('newer', { url: 'https://dup.com', lastAccessed: NOW }),
        mkTab('older', { url: 'https://dup.com', lastAccessed: OLD }),
      ]),
    ];
    const { store, mod } = await makeStore(groups);
    store.dispatch(mod.cleanDuplicateTabs.pending('req-1', undefined));
    assert.equal(store.getState().tabs.groups[0].tabs.length, 1, '前置条件：乐观已生效');

    store.dispatch(
      mod.cleanDuplicateTabs.rejected(
        { message: `${TIMEOUT_REASON_PREFIX}（超过 30 秒无响应）：cleanDuplicates` } as never,
        'req-1',
        undefined
      )
    );
    const state = store.getState().tabs;
    assert.deepEqual(
      state.groups[0].tabs.map(t => t.id),
      ['newer'],
      '超时不等于回滚（core/mutationProtocol 明写「后台可能仍在继续」）—— ' +
        '还原会把可能已删的重复标签显示回来，用户会重试、会质疑数据完整性'
    );
    assert.match(String(state.error), /可能仍在继续/, '必须说清后台可能仍在继续');
    assert.equal(state.errorSource, 'action');
    assert.equal(state.cleanDuplicatesSnapshot, null, '快照用完即清');
  });
});

describe('纯函数：planOptimisticClean / applyCleanPlanToActiveView', () => {
  it('乐观阶段不写 updatedAt / version / lastOp（不编造参与 LWW 裁决的字段）', async () => {
    const { planOptimisticClean } = await import('@/store/slices/tabSliceHelpers');
    const groups = [
      mkGroup('g1', [
        mkTab('newer', { url: 'https://dup.com', lastAccessed: NOW }),
        mkTab('older', { url: 'https://dup.com', lastAccessed: OLD }),
      ]),
    ];
    const out = planOptimisticClean(groups);
    const g1 = out.groups.find(g => g.id === 'g1')!;
    assert.equal(g1.updatedAt, OLD, '乐观阶段不得改 updatedAt');
    assert.equal(g1.version, 1, '乐观阶段不得改 version');
    assert.equal(g1.lastOp, undefined, '乐观阶段不得盖印记');
    assert.equal(out.plan.removedTabsCount, 1);
  });

  it('乐观与 SW 落地对同一份数据算出的删除集合一致（共用纯函数 ⇒ 规则不漂移）', async () => {
    const { planOptimisticClean } = await import('@/store/slices/tabSliceHelpers');
    const { planCleanDuplicates } = await import('@/core/mutationOps');
    const groups = [
      mkGroup('g1', [
        mkTab('a', { url: 'https://dup.com', lastAccessed: NOW }),
        mkTab('b', { url: 'https://dup.com', lastAccessed: '2026-05-01T00:00:00.000Z' }),
      ]),
      mkGroup('g2', [mkTab('c', { url: 'https://dup.com', lastAccessed: OLD })]),
      mkGroup('g3', [mkTab('d', { url: 'https://other.com', lastAccessed: NOW })]),
    ];
    const optimistic = planOptimisticClean(groups).plan;
    const sw = planCleanDuplicates(groups);
    assert.deepEqual(optimistic, sw, '两端必须逐字段相同');
  });

  it('计划里点了不存在的组/标签时跳过而不抛（活跃视图与 storage 真值可能不完全对应）', async () => {
    const { applyCleanPlanToActiveView } = await import('@/store/slices/tabSliceHelpers');
    const groups = [mkGroup('g1', [mkTab('t1')])];
    const out = applyCleanPlanToActiveView(
      groups,
      {
        removedTabsByGroup: [
          { groupId: 'g-unknown', tabIds: ['t-unknown'] },
          { groupId: 'g1', tabIds: ['t-not-in-group'] },
        ],
        removedGroupIds: ['g-unknown'],
        removedTabsCount: 2,
        removedGroupsCount: 1,
      },
      NOW,
      STAMP
    );
    assert.deepEqual(out.map(g => g.id), ['g1'], '不存在的项被跳过，组不受影响');
  });

  it('移除后的标签保持组内原序（不按待删集合的顺序重排）', async () => {
    const { planCleanDuplicates, applyCleanDuplicatesPlan } = await import('@/core/mutationOps');
    // b/d 是重复败者，但 a/c/e 的相对顺序必须原样保留
    const groups = [
      mkGroup('g1', [
        mkTab('a', { url: 'https://a.com', lastAccessed: NOW }),
        mkTab('b', { url: 'https://a.com', lastAccessed: OLD }),
        mkTab('c', { url: 'https://c.com', lastAccessed: NOW }),
        mkTab('d', { url: 'https://c.com', lastAccessed: OLD }),
        mkTab('e', { url: 'https://e.com', lastAccessed: NOW }),
      ]),
    ];
    const plan = planCleanDuplicates(groups);
    const out = applyCleanDuplicatesPlan(groups, plan, NOW, STAMP);
    assert.deepEqual(
      out[0].tabs.map(t => t.id),
      ['a', 'c', 'e'],
      '原序过滤；若按删除集合排序会变成 [b, d] 之外的乱序'
    );
  });

  it('没有重复时计划为空、groups 引用不变（不做无谓拷贝）', async () => {
    const { planCleanDuplicates, applyCleanDuplicatesPlan } = await import('@/core/mutationOps');
    const groups = [mkGroup('g1', [mkTab('t1')]), mkGroup('g2', [mkTab('t2')])];
    const plan = planCleanDuplicates(groups);
    assert.equal(plan.removedTabsCount, 0);
    assert.deepEqual(plan.removedTabsByGroup, []);
    assert.deepEqual(plan.removedGroupIds, []);
    const out = applyCleanDuplicatesPlan(groups, plan, NOW, STAMP);
    assert.equal(out[0], groups[0], '未被改动的组保持同一引用（React 免重渲染）');
  });
});

describe('mutationHandlers：cleanDuplicates 只回传计划，不回传 groups 全量', () => {
  it('payload 里没有 updatedGroups（跨进程不再克隆几 MB）', async () => {
    const { createMutationHandlers } = await import('@/background/mutationHandlers');
    // 内联一个最小 deps（与 tests/mutationHandlers.test.ts 同形状）
    let groups: TabGroup[] = [
      mkGroup('g1', [
        mkTab('newer', { url: 'https://dup.com', lastAccessed: NOW }),
        mkTab('older', { url: 'https://dup.com', lastAccessed: OLD }),
      ]),
    ];
    const uploads: number[] = [];
    const deletedIds: string[] = [];
    let seqN = 0;
    const deps = {
      now: () => NOW,
      getGroups: async () => [...groups],
      setGroups: async (g: TabGroup[]) => { groups = [...g]; },
      scheduleUpload: (ms: number) => { uploads.push(ms); },
      journal: {
        appendEntry: async (p: unknown) => {
          seqN += 1;
          return { d: 'devSW', s: seqN, ts: NOW, ...(p as object) };
        },
        read: async () => [],
        markConfirmedUpTo: async () => 0,
      },
      seq: {
        nextSeq: async () => ++seqN,
        getDeviceSeq: async () => seqN,
        bumpSeqIfLower: async (c: number) => c,
      },
      noteGroupDeleted: async (ids: readonly string[]) => { deletedIds.push(...ids); },
    };
    const handlers = createMutationHandlers(deps as never);
    const res = await handlers.handle({ op: 'cleanDuplicates' });

    assert.equal(res.ok, true);
    const payload = res.payload as Record<string, unknown>;
    assert.equal('updatedGroups' in payload, false, 'payload 不得再含 groups 全量');
    assert.ok(payload.plan, 'payload 必须含计划');
    assert.equal(payload.now, NOW, 'payload 必须带落盘 now，供两端算出同一个 updatedAt');
    assert.deepEqual(payload.stamp, { d: 'devSW', s: seqN }, 'payload 必须带落盘 stamp');
    const plan = payload.plan as { removedTabsCount: number; removedTabsByGroup: unknown[] };
    assert.equal(plan.removedTabsCount, 1);
    assert.deepEqual(plan.removedTabsByGroup, [{ groupId: 'g1', tabIds: ['older'] }]);
    // 磁盘确实改了（乐观更新不能替代落盘）
    assert.equal(groups[0].tabs.length, 1);
    assert.deepEqual(uploads, [3000], '清理后照常调度上传');
  });

  it('清空的组 id 登记删除广播队列（跨设备删除不受乐观更新影响）', async () => {
    const { createMutationHandlers } = await import('@/background/mutationHandlers');
    let groups: TabGroup[] = [
      mkGroup('keep', [mkTab('k', { url: 'https://dup.com', lastAccessed: NOW })]),
      mkGroup('gone', [mkTab('g', { url: 'https://dup.com', lastAccessed: OLD })]),
    ];
    const deletedIds: string[] = [];
    let seqN = 0;
    const deps = {
      now: () => NOW,
      getGroups: async () => [...groups],
      setGroups: async (g: TabGroup[]) => { groups = [...g]; },
      scheduleUpload: () => {},
      journal: {
        appendEntry: async (p: unknown) => ({ d: 'devSW', s: ++seqN, ts: NOW, ...(p as object) }),
        read: async () => [],
        markConfirmedUpTo: async () => 0,
      },
      seq: { nextSeq: async () => ++seqN, getDeviceSeq: async () => seqN, bumpSeqIfLower: async (c: number) => c },
      noteGroupDeleted: async (ids: readonly string[]) => { deletedIds.push(...ids); },
    };
    const handlers = createMutationHandlers(deps as never);
    await handlers.handle({ op: 'cleanDuplicates' });
    assert.deepEqual(deletedIds, ['gone'], '被清空的组必须登记云端删除广播，否则对端复活');
  });
});
