// tab 级墓碑语义回归测试——钉死「单标签删除跨设备复活」bug 的修复。
//
// 历史背景：v1.16.0 及之前，deleteTabAndSync / UI updateGroup(filter) 物理
// 移除 tab 且无墓碑；mergeTabs 对两侧非删除 tab 做并集 → A 设备删除的标签
// 在 B 设备后台轮询合并时以 local-only 身份复活，再经 B 上传传回 A。
//
// 修复后的不变量：
//   1. 任一侧墓碑 → 另一侧活跃副本被剔除（删除意图优先于状态并集）
//   2. 墓碑本体保留在合并结果中（向第三方设备传播）
//   3. TabData 序列化双向携带 is_deleted
//   4. shouldAutoDeleteAfterTabRemoval 只按活跃（非墓碑）计数

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

function makeTab(id: string, url: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    url,
    title: `tab ${id}`,
    createdAt: NOW,
    lastAccessed: NOW,
    pinned: false,
    ...overrides,
  };
}

function makeGroup(id: string, tabs: ReturnType<typeof makeTab>[], overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `group-${id}`,
    tabs,
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

describe('tabTombstone: 标签级删除意图跨设备传播', () => {
  it('本地删除（墓碑）+ 云端仍活跃 → 合并后该 tab 被剔除', async () => {
    const { mergeTabGroups } = await import('@/utils/syncUtils');

    const local = [
      makeGroup('g1', [
        makeTab('t1', 'https://a.com'),
        makeTab('t2', 'https://b.com', { isDeleted: true }),
      ]),
    ];
    const cloud = [
      makeGroup('g1', [
        makeTab('t1', 'https://a.com'),
        makeTab('t2', 'https://b.com'), // 云端还是旧状态：t2 活跃
      ]),
    ];

    const merged = mergeTabGroups(local, cloud, 'newest');
    const g1 = merged.find(g => g.id === 'g1')!;

    assert.ok(g1, '合并结果应包含组 g1');
    const activeTabs = g1.tabs.filter(t => !t.isDeleted);
    assert.strictEqual(
      activeTabs.length, 1,
      '被本地删除的 t2 不应因云端仍是活跃状态而复活'
    );
    assert.strictEqual(activeTabs[0].id, 't1');
  });

  it('云端删除（墓碑）+ 本地仍活跃 → 合并后本地副本被剔除', async () => {
    const { mergeTabGroups } = await import('@/utils/syncUtils');

    const local = [
      makeGroup('g1', [makeTab('t1', 'https://a.com')]), // B 设备还没收到删除
    ];
    const cloud = [
      makeGroup('g1', [
        makeTab('t1', 'https://a.com', { isDeleted: true }), // A 已删除并上传
      ]),
    ];

    const merged = mergeTabGroups(local, cloud, 'newest');
    const g1 = merged.find(g => g.id === 'g1')!;

    const activeTabs = g1.tabs.filter(t => !t.isDeleted);
    assert.strictEqual(activeTabs.length, 0, '云端已删除的 t1 不应在 B 设备复活');
  });

  it('墓碑本体保留在合并结果中（第三方设备可继续接收删除意图）', async () => {
    const { mergeTabGroups } = await import('@/utils/syncUtils');

    const local = [makeGroup('g1', [makeTab('t2', 'https://b.com', { isDeleted: true })])];
    const cloud = [makeGroup('g1', [])]; // 第三方设备从未见过 t2

    const merged = mergeTabGroups(local, cloud, 'newest');
    const g1 = merged.find(g => g.id === 'g1')!;

    const tombstone = g1.tabs.find(t => t.id === 't2');
    assert.ok(tombstone, '墓碑应保留在合并结果中以传播删除意图');
    assert.strictEqual(tombstone!.isDeleted, true);
  });

  it('活跃 tab 未命中墓碑 → 正常保留（不误删）', async () => {
    const { mergeTabGroups } = await import('@/utils/syncUtils');

    const local = [
      makeGroup('g1', [
        makeTab('t1', 'https://a.com'),
        makeTab('t3', 'https://c.com'), // 新增的无关 tab
      ]),
    ];
    const cloud = [
      makeGroup('g1', [
        makeTab('t1', 'https://a.com'),
        makeTab('t2', 'https://b.com', { isDeleted: true }),
      ]),
    ];

    const merged = mergeTabGroups(local, cloud, 'newest');
    const g1 = merged.find(g => g.id === 'g1')!;
    const activeIds = g1.tabs.filter(t => !t.isDeleted).map(t => t.id).sort();

    assert.deepEqual(activeIds, ['t1', 't3'], '未命中墓碑的活跃 tab 应全部保留');
  });
});

describe('tabTombstone: 空组自动删除判断按活跃计数', () => {
  it('组内只剩墓碑 + 删除最后一个活跃 tab → 触发自动删除', async () => {
    const { shouldAutoDeleteAfterTabRemoval } = await import('@/utils/tabGroupUtils');

    const group = makeGroup('g1', [
      makeTab('t1', 'https://a.com'),
      makeTab('t2', 'https://b.com', { isDeleted: true }), // 历史墓碑不算活跃
    ]);

    assert.strictEqual(shouldAutoDeleteAfterTabRemoval(group, 't1'), true,
      '删除最后一个活跃 tab 后（墓碑不计入）应触发自动删除');
  });

  it('组内仍有其他活跃 tab → 不触发自动删除', async () => {
    const { shouldAutoDeleteAfterTabRemoval } = await import('@/utils/tabGroupUtils');

    const group = makeGroup('g1', [
      makeTab('t1', 'https://a.com'),
      makeTab('t2', 'https://b.com'),
      makeTab('t3', 'https://c.com', { isDeleted: true }),
    ]);

    assert.strictEqual(shouldAutoDeleteAfterTabRemoval(group, 't1'), false);
  });

  it('锁定组永不触发自动删除', async () => {
    const { shouldAutoDeleteAfterTabRemoval } = await import('@/utils/tabGroupUtils');

    const group = makeGroup('g1', [makeTab('t1', 'https://a.com')], { isLocked: true });

    assert.strictEqual(shouldAutoDeleteAfterTabRemoval(group, 't1'), false);
  });
});
