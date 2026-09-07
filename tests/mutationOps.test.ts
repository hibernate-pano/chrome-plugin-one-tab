// 钉死 SW 单写者使用的语义纯函数（规格 §3.2）：
// 1) applySaveGroup —— 新组置顶并按 createdAt 倒序排序；
// 2) applyRemoveTab —— 命令式指定 (groupId, tabId) 墓碑化，替代 updateGroup(filter) diff
//    在 UI 状态陈旧时误伤的根因 R3；行为与 tabSlice.deleteTabAndSync 逐字段一致。
//
// 文件头部样板必须与 tests/mutationQueue.test.ts 的既有模式一致：
// @/ 别名的模块只能在 register(loader) 之后【动态 import】（静态 import 会被
// 提升、先于 loader 注册而失败）。本文件的每个 it 内用 await import('@/...')。
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

// 共享构造器（纯数据，无 @/ 依赖，可安全静态定义）
const NOW = '2026-09-07T10:00:00.000Z';
const EARLIER = '2026-09-01T10:00:00.000Z';

function mkTab(id: string, over: Record<string, unknown> = {}) {
  return { id, url: `https://e.com/${id}`, title: id, favicon: '', createdAt: EARLIER, lastAccessed: EARLIER, pinned: false, isDeleted: false, ...over };
}
function mkGroup(id: string, tabs: unknown[], over: Record<string, unknown> = {}) {
  return { id, name: `g-${id}`, tabs, createdAt: EARLIER, updatedAt: EARLIER, version: 1, isDeleted: false, isLocked: false, ...over };
}

describe('mutationOps.applySaveGroup', () => {
  it('新组插入头部，按 createdAt 倒序', async () => {
    const { applySaveGroup } = await import('@/utils/mutationOps');
    const a = mkGroup('a', []);
    const fresh = mkGroup('fresh', [], { createdAt: NOW });
    const out = applySaveGroup([a], fresh, NOW);
    assert.deepEqual(out.map(g => g.id), ['fresh', 'a']);
  });
  it('不改变传入数组（不可变）', async () => {
    const { applySaveGroup } = await import('@/utils/mutationOps');
    const a = mkGroup('a', []);
    const fresh = mkGroup('fresh', [], { createdAt: NOW });
    applySaveGroup([a], fresh, NOW);
    assert.deepEqual(a.tabs, []);
  });
});

describe('mutationOps.applyRemoveTab（语义命令，替代 updateGroup diff——根因 R3）', () => {
  it('只墓碑化指定 tab：其余 tab 原样，组 version+1、updatedAt=now', async () => {
    const { applyRemoveTab } = await import('@/utils/mutationOps');
    const g = mkGroup('g1', [mkTab('t1'), mkTab('t2')]);
    const { groups, group } = applyRemoveTab([g], 'g1', 't1', NOW);
    const out = groups.find(x => x.id === 'g1')!;
    assert.equal(group!.version, 2);
    assert.equal(out.tabs.find(t => t.id === 't1')!.isDeleted, true);
    assert.equal(out.tabs.find(t => t.id === 't2')!.isDeleted, false);
    assert.equal(out.updatedAt, NOW);
    assert.equal(out.tabs.find(t => t.id === 't2')!.lastAccessed, EARLIER); // 未动
  });
  it('已删除最后一个活跃 tab 且组未锁定 → 整组墓碑化（isDeleted, version+1），tab 数组原样', async () => {
    const { applyRemoveTab } = await import('@/utils/mutationOps');
    const g = mkGroup('g1', [mkTab('t1')]);
    const { groups, group } = applyRemoveTab([g], 'g1', 't1', NOW);
    const out = groups.find(x => x.id === 'g1')!;
    assert.equal(group, null);
    assert.equal(out.isDeleted, true);
    assert.equal(out.version, 2);
    assert.equal(out.tabs.length, 1); // tab 不再重复墓碑
  });
  it('锁定组删到最后一个活跃 tab → 只墓碑 tab，组保留', async () => {
    const { applyRemoveTab } = await import('@/utils/mutationOps');
    const g = mkGroup('g1', [mkTab('t1')], { isLocked: true });
    const { groups, group } = applyRemoveTab([g], 'g1', 't1', NOW);
    assert.equal(group!.isDeleted, false);
    assert.equal(groups.find(x => x.id === 'g1')!.tabs[0].isDeleted, true);
  });
  it('组内只剩墓碑时删最后一个活跃 tab → 触发整组墓碑（按活跃计数，与 autoDeleteEmptyGroup 口径一致）', async () => {
    const { applyRemoveTab } = await import('@/utils/mutationOps');
    const g = mkGroup('g1', [mkTab('dead', { isDeleted: true }), mkTab('t1')]);
    const { groups } = applyRemoveTab([g], 'g1', 't1', NOW);
    assert.equal(groups.find(x => x.id === 'g1')!.isDeleted, true);
  });
  it('组不存在 → group 返回 null，数组原样', async () => {
    const { applyRemoveTab } = await import('@/utils/mutationOps');
    const { groups, group } = applyRemoveTab([], 'nope', 't1', NOW);
    assert.equal(group, null);
    assert.equal(groups.length, 0);
  });
});

describe('mutationOps 组生命周期', () => {
  it('applyDeleteGroup：软删 + version+1，其余组不动', async () => {
    const { applyDeleteGroup } = await import('@/utils/mutationOps');
    const out = applyDeleteGroup([mkGroup('a', []), mkGroup('b', [])], 'a', NOW);
    assert.equal(out.find(g => g.id === 'a')!.isDeleted, true);
    assert.equal(out.find(g => g.id === 'a')!.version, 2);
    assert.equal(out.find(g => g.id === 'b')!.isDeleted, false);
  });

  it('applyDeleteAllGroups：只墓碑活跃组；已墓碑的 version 不动（幂等）', async () => {
    const { applyDeleteAllGroups } = await import('@/utils/mutationOps');
    const tomb = mkGroup('dead', [], { isDeleted: true, version: 7 });
    const out = applyDeleteAllGroups([mkGroup('a', []), tomb], NOW);
    assert.equal(out.count, 2); // 与现 thunk 一致：count = groups.length
    assert.equal(out.groups.find(g => g.id === 'a')!.isDeleted, true);
    assert.equal(out.groups.find(g => g.id === 'dead')!.version, 7);
  });

  it('applyRestoreGroup：置回活跃 + version+1', async () => {
    const { applyRestoreGroup } = await import('@/utils/mutationOps');
    const g = mkGroup('a', [], { isDeleted: true });
    const out = applyRestoreGroup([g], 'a', NOW);
    assert.equal(out.restored!.isDeleted, false);
    assert.equal(out.restored!.version, 2);
  });

  it('applyRestoreGroup：未找到 → restored=null', async () => {
    const { applyRestoreGroup } = await import('@/utils/mutationOps');
    assert.equal(applyRestoreGroup([], 'x', NOW).restored, null);
  });

  it('applyPurgeGroup：物理移除', async () => {
    const { applyPurgeGroup } = await import('@/utils/mutationOps');
    const out = applyPurgeGroup([mkGroup('a', []), mkGroup('b', [])], 'a');
    assert.deepEqual(out.map(g => g.id), ['b']);
  });

  it('applyRenameGroup：走 updateGroupWithVersion（version+1）', async () => {
    const { applyRenameGroup } = await import('@/utils/mutationOps');
    const out = applyRenameGroup([mkGroup('a', [])], 'a', '新名字', NOW);
    assert.equal(out.renamed!.name, '新名字');
    assert.equal(out.renamed!.version, 2);
    assert.equal(out.renamed!.updatedAt, NOW);
  });

  it('applyToggleGroupLock：翻转锁定', async () => {
    const { applyToggleGroupLock } = await import('@/utils/mutationOps');
    const out = applyToggleGroupLock([mkGroup('a', [], { isLocked: false })], 'a', NOW);
    assert.equal(out.isLocked, true);
  });

  it('applyImportGroups：生成新 id、丢弃危险 URL tab、置顶', async () => {
    const { applyImportGroups } = await import('@/utils/mutationOps');
    const src = mkGroup('old', [mkTab('x', { url: 'javascript:alert(1)' }), mkTab('y')]);
    const { groups, imported } = applyImportGroups(
      [mkGroup('existing', [])],
      [src],
      { genId: (() => { let i = 0; return () => `new${++i}`; })(), sanitizeUrl: (u) => u.startsWith('javascript:') ? null : u },
      NOW
    );
    assert.equal(imported.length, 1);
    assert.equal(imported[0].id, 'new1');
    assert.equal(imported[0].tabs.length, 1); // javascript: 被丢
    assert.equal(imported[0].tabs[0].id, 'new2');
    assert.equal(groups[0].id, 'new1'); // 置顶
  });
});
