// 影子写路径两处平方级热点的回归（v1.22.9 性能修复）。
//
// 【为什么这两处值得单独钉】它们都是**同步纯计算**，跑在 Service Worker 的唯一
// 线程上。影子写虽然是 fire-and-forget（mutationHandlers 不 await 它），
// 但它一开始同步计算，队列里的下一个用户操作就得等它算完 —— 也就是说这些开销
// 直接转成用户点「删除会话 / 清理重复」的等待时间，且随数据量平方级恶化。
//
// 1) snapshotToRows 的 tabCount：原实现在 groups.map 里对全表 tabs 做一次 filter，
//    O(G×T)。实测 1000 组 × 20 标签 ≈ 2.9s，改成「先计数一遍再查表」后 ≈ 4ms。
// 2) applyYPlans 清组内 tab 镜像：原实现每次全表扫 tabs.keys() 做前缀匹配，
//    O(计划数 × T)。cleanDuplicates 是最坏形状（一次删几百组），
//    实测 2 万标签删 400 组 ≈ 80ms，加 groupId→keys 索引后 ≈ 4ms。
//
// 本文件钉的是**语义等价性**（索引/计数必须与全表扫描的结果逐条相同），
// 而不是耗时数字 —— 耗时依赖机器，放进断言会让 CI 随机变红。
// 索引与真实状态分叉会漏删/误删 tab 镜像，那正是最容易出错的地方。
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

const NOW = '2026-10-04T10:00:00.000Z';
const STAMP = { d: 'devTest', s: 1 };

function yGroup(id: string, seq = 1): any {
  return {
    id, name: `n-${id}`, createdAt: NOW, updatedAt: NOW, isLocked: false,
    is_deleted: false, version: 1, last_op_device: 'devTest', last_op_seq: seq,
  };
}

function yTab(groupId: string, id: string, over: Record<string, unknown> = {}): any {
  return {
    id, groupId, url: `https://${groupId}.com/${id}`, title: id, lastAccessed: NOW,
    is_deleted: false, last_op_device: 'devTest', last_op_seq: 1, ...over,
  };
}

/** 直接铺好一个 state（模拟已持久化的影子文档）。 */
async function seedState(groupIds: string[], tabsPerGroup: number) {
  const { newYState } = await import('@/core/yTranslate');
  const s = newYState();
  for (const gid of groupIds) {
    s.groups.set(gid, yGroup(gid));
    for (let t = 0; t < tabsPerGroup; t++) s.tabs.set(`${gid}:t${t}`, yTab(gid, `t${t}`));
  }
  s.order = [...groupIds];
  return s;
}

describe('applyYPlans：groupId→keys 索引与全表扫描语义等价', () => {
  it('setOrder 修剪：死组的组记录与 tab 镜像全部消失，活组原封不动', async () => {
    const { applyYPlans } = await import('@/core/yTranslate');
    const s = await seedState(['g1', 'g2', 'g3'], 4);
    applyYPlans(s, [{ kind: 'setOrder', order: ['g1', 'g3'] }], STAMP);

    assert.deepEqual([...s.groups.keys()].sort(), ['g1', 'g3']);
    assert.deepEqual([...s.order], ['g1', 'g3']);
    // 索引必须把 g2 的 4 条镜像全删掉，且不误删 g1/g3 的
    assert.deepEqual(
      [...s.tabs.keys()].filter(k => k.startsWith('g2:')),
      [],
      'g2 的 tab 镜像必须清空（索引漏删会让死组的标签在物化视图里永久残留）'
    );
    assert.equal(s.tabs.size, 8, 'g1/g3 各 4 条必须原样保留');
  });

  it('removeGroup：同样清干净组记录与镜像', async () => {
    const { applyYPlans } = await import('@/core/yTranslate');
    const s = await seedState(['g1', 'g2'], 3);
    applyYPlans(s, [{ kind: 'removeGroup', groupId: 'g1' }], STAMP);
    assert.equal(s.groups.has('g1'), false);
    assert.deepEqual([...s.tabs.keys()].filter(k => k.startsWith('g1:')), []);
    assert.equal(s.tabs.size, 3);
    assert.deepEqual([...s.order], ['g2'], 'order 同步移除');
  });

  it('upsertGroup：先清本组旧镜像再写新 tabs（删除意图不残留）', async () => {
    const { applyYPlans } = await import('@/core/yTranslate');
    const s = await seedState(['g1'], 5);
    // 新版本只剩 2 个标签：旧的 5 条必须被清掉，不能残留 3 条幽灵镜像
    applyYPlans(
      s,
      [{
        kind: 'upsertGroup',
        group: yGroup('g1', 7),
        tabs: [yTab('g1', 'a'), yTab('g1', 'b')],
      }],
      { d: 'devTest', s: 7 },
    );
    assert.deepEqual([...s.tabs.keys()].sort(), ['g1:a', 'g1:b']);
  });

  it('同一次调用里 upsert 与 setOrder 交错：索引不得与实际状态分叉', async () => {
    const { applyYPlans } = await import('@/core/yTranslate');
    const s = await seedState(['g1', 'g2', 'g3'], 3);
    // 一批计划同时包含「改组标签」与「删组」，且顺序交错
    applyYPlans(
      s,
      [
        { kind: 'upsertGroup', group: yGroup('g1', 2), tabs: [yTab('g1', 'new1')] },
        { kind: 'setOrder', order: ['g1', 'g3'] },   // 删 g2
        { kind: 'upsertGroup', group: yGroup('g3', 2), tabs: [yTab('g3', 'new3a'), yTab('g3', 'new3b')] },
      ],
      { d: 'devTest', s: 2 },
    );
    assert.deepEqual([...s.groups.keys()].sort(), ['g1', 'g3']);
    assert.deepEqual([...s.tabs.keys()].sort(), ['g1:new1', 'g3:new3a', 'g3:new3b']);
    assert.deepEqual(
      [...s.tabs.keys()].filter(k => k.startsWith('g2:')),
      [],
      '交错执行后 g2 的镜像仍必须为空'
    );
  });

  it('连续两次 applyYPlans（跨调用）：每次都重建索引，不沿用上次的陈旧状态', async () => {
    const { applyYPlans } = await import('@/core/yTranslate');
    const s = await seedState(['g1', 'g2'], 2);
    applyYPlans(s, [{ kind: 'setOrder', order: ['g1'] }], STAMP);   // 删 g2
    // 第二次：g1 改成 1 个标签
    applyYPlans(
      s,
      [{ kind: 'upsertGroup', group: yGroup('g1', 2), tabs: [yTab('g1', 'only')] }],
      { d: 'devTest', s: 2 },
    );
    assert.deepEqual([...s.tabs.keys()], ['g1:only']);
  });

  it('key 里没有冒号时按「不属于任何组」处理（不误删、不崩）', async () => {
    const { applyYPlans, newYState } = await import('@/core/yTranslate');
    const s = newYState();
    s.groups.set('g1', yGroup('g1'));
    s.tabs.set('legacy-no-colon', yTab('g1', 'x'));   // 本模块不会产出这种 key，但要容错
    s.tabs.set('g1:t1', yTab('g1', 't1'));
    s.order = ['g1'];
    // 删 g1：只该清掉 g1: 前缀的那条；无冒号的 key 与原实现的 startsWith('g1:') 判定一致（永假）
    applyYPlans(s, [{ kind: 'setOrder', order: [] }], STAMP);
    assert.equal(s.groups.has('g1'), false);
    assert.deepEqual([...s.tabs.keys()], ['legacy-no-colon']);
  });

  it('空计划不建索引也能正确跑完（无死组时 setOrder 只是重排）', async () => {
    const { applyYPlans } = await import('@/core/yTranslate');
    const s = await seedState(['g1', 'g2'], 2);
    applyYPlans(s, [{ kind: 'setOrder', order: ['g2', 'g1'] }], STAMP);
    assert.deepEqual([...s.order], ['g2', 'g1']);
    assert.equal(s.tabs.size, 4, '重排不得动任何镜像');
    assert.equal(s.groups.size, 2);
  });
});

describe('snapshotToRows：tabCount 计数一遍与逐组 filter 等价', () => {
  it('活跃标签计数正确，墓碑不计入', async () => {
    const { snapshotToRows } = await import('@/core/yMaterialize');
    const rows = snapshotToRows({
      groups: { g1: yGroup('g1'), g2: yGroup('g2'), gEmpty: yGroup('gEmpty') },
      tabs: {
        'g1:t1': yTab('g1', 't1'),
        'g1:t2': yTab('g1', 't2'),
        'g1:dead': yTab('g1', 'dead', { is_deleted: true }),
        'g2:t1': yTab('g2', 't1'),
      },
      order: ['g1', 'g2', 'gEmpty'],
    });
    const byId = new Map(rows.groups.map(g => [g.id, g.tabCount]));
    assert.equal(byId.get('g1'), 2, '墓碑不计入 tabCount');
    assert.equal(byId.get('g2'), 1);
    assert.equal(byId.get('gEmpty'), 0, '没有任何标签的组是 0，不是 undefined');
  });

  it('tab 的 groupId 与任何组都不匹配时不崩溃（索引里没有该组）', async () => {
    const { snapshotToRows } = await import('@/core/yMaterialize');
    const rows = snapshotToRows({
      groups: { g1: yGroup('g1') },
      tabs: { 'orphan:t1': yTab('orphan', 't1') },   // groupId 不在 groups 里
      order: ['g1'],
    });
    assert.equal(rows.groups[0].tabCount, 0);
    assert.equal(rows.tabs.length, 1, '孤儿 tab 仍进 tab 行（只是不计入任何组）');
  });

  it('大规模下结果与「逐组全表 filter」逐条一致（等价性的直接证据）', async () => {
    const { snapshotToRows } = await import('@/core/yMaterialize');
    const G = 200;
    const T = 7;
    const groups: Record<string, any> = {};
    const tabs: Record<string, any> = {};
    const order: string[] = [];
    for (let g = 0; g < G; g++) {
      const gid = `g${g}`;
      groups[gid] = yGroup(gid);
      order.push(gid);
      for (let t = 0; t < T; t++) {
        // 每 5 组留一条墓碑，验证计数条件
        tabs[`${gid}:t${t}`] = yTab(gid, `t${t}`, { is_deleted: g % 5 === 0 && t === 0 });
      }
    }
    const rows = snapshotToRows({ groups, tabs, order });

    // 参照实现：原样逐组全表 filter
    const allTabs = Object.values(tabs) as any[];
    for (const row of rows.groups) {
      const expected = allTabs.filter(t => t.groupId === row.id && !t.is_deleted).length;
      assert.equal(row.tabCount, expected, `${row.id} 的 tabCount 与参照实现不一致`);
    }
    assert.equal(rows.groups.length, G);
    assert.deepEqual(rows.groups.map(g => g.id), order, '仍按 order 排序');
  });
});
