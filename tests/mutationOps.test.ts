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
// 阶段二·§4.1：apply* 全部接 stamp 入参。测试用固定 stamp 不参与决胜，仅验证
// stamp 透传到被改实体（具体 stamp 盖印验收见文末 stamp 盖印 describe 块）。
const STAMP = { d: 'devTest', s: 1 };

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
    const out = applySaveGroup([a], fresh, NOW, STAMP);
    assert.deepEqual(out.map(g => g.id), ['fresh', 'a']);
  });
  it('不改变传入数组（不可变）', async () => {
    const { applySaveGroup } = await import('@/utils/mutationOps');
    const a = mkGroup('a', []);
    const fresh = mkGroup('fresh', [], { createdAt: NOW });
    applySaveGroup([a], fresh, NOW, STAMP);
    assert.deepEqual(a.tabs, []);
  });
});

describe('mutationOps.applyRemoveTab（语义命令，替代 updateGroup diff——根因 R3）', () => {
  it('只墓碑化指定 tab：其余 tab 原样，组 version+1、updatedAt=now', async () => {
    const { applyRemoveTab } = await import('@/utils/mutationOps');
    const g = mkGroup('g1', [mkTab('t1'), mkTab('t2')]);
    const { groups, group } = applyRemoveTab([g], 'g1', 't1', NOW, STAMP);
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
    const { groups, group } = applyRemoveTab([g], 'g1', 't1', NOW, STAMP);
    const out = groups.find(x => x.id === 'g1')!;
    assert.equal(group, null);
    assert.equal(out.isDeleted, true);
    assert.equal(out.version, 2);
    assert.equal(out.tabs.length, 1); // tab 不再重复墓碑
  });
  it('锁定组删到最后一个活跃 tab → 只墓碑 tab，组保留', async () => {
    const { applyRemoveTab } = await import('@/utils/mutationOps');
    const g = mkGroup('g1', [mkTab('t1')], { isLocked: true });
    const { groups, group } = applyRemoveTab([g], 'g1', 't1', NOW, STAMP);
    assert.equal(group!.isDeleted, false);
    assert.equal(groups.find(x => x.id === 'g1')!.tabs[0].isDeleted, true);
  });
  it('组内只剩墓碑时删最后一个活跃 tab → 触发整组墓碑（按活跃计数，与 autoDeleteEmptyGroup 口径一致）', async () => {
    const { applyRemoveTab } = await import('@/utils/mutationOps');
    const g = mkGroup('g1', [mkTab('dead', { isDeleted: true }), mkTab('t1')]);
    const { groups } = applyRemoveTab([g], 'g1', 't1', NOW, STAMP);
    assert.equal(groups.find(x => x.id === 'g1')!.isDeleted, true);
  });
  it('组不存在 → group 返回 null，数组原样', async () => {
    const { applyRemoveTab } = await import('@/utils/mutationOps');
    const { groups, group } = applyRemoveTab([], 'nope', 't1', NOW, STAMP);
    assert.equal(group, null);
    assert.equal(groups.length, 0);
  });
});

describe('mutationOps 组生命周期', () => {
  it('applyDeleteGroup：软删 + version+1，其余组不动', async () => {
    const { applyDeleteGroup } = await import('@/utils/mutationOps');
    const out = applyDeleteGroup([mkGroup('a', []), mkGroup('b', [])], 'a', NOW, STAMP);
    assert.equal(out.find(g => g.id === 'a')!.isDeleted, true);
    assert.equal(out.find(g => g.id === 'a')!.version, 2);
    assert.equal(out.find(g => g.id === 'b')!.isDeleted, false);
  });

  it('applyDeleteAllGroups：只墓碑活跃组；已墓碑的 version 不动（幂等）', async () => {
    const { applyDeleteAllGroups } = await import('@/utils/mutationOps');
    const tomb = mkGroup('dead', [], { isDeleted: true, version: 7 });
    const out = applyDeleteAllGroups([mkGroup('a', []), tomb], NOW, STAMP);
    assert.equal(out.count, 2); // 与现 thunk 一致：count = groups.length
    assert.equal(out.groups.find(g => g.id === 'a')!.isDeleted, true);
    assert.equal(out.groups.find(g => g.id === 'dead')!.version, 7);
  });

  it('applyRestoreGroup：置回活跃 + version+1', async () => {
    const { applyRestoreGroup } = await import('@/utils/mutationOps');
    const g = mkGroup('a', [], { isDeleted: true });
    const out = applyRestoreGroup([g], 'a', NOW, STAMP);
    assert.equal(out.restored!.isDeleted, false);
    assert.equal(out.restored!.version, 2);
  });

  it('applyRestoreGroup：未找到 → restored=null', async () => {
    const { applyRestoreGroup } = await import('@/utils/mutationOps');
    assert.equal(applyRestoreGroup([], 'x', NOW, STAMP).restored, null);
  });

  it('applyPurgeGroup：物理移除', async () => {
    const { applyPurgeGroup } = await import('@/utils/mutationOps');
    const out = applyPurgeGroup([mkGroup('a', []), mkGroup('b', [])], 'a', NOW, STAMP);
    assert.deepEqual(out.map(g => g.id), ['b']);
  });

  it('applyRenameGroup：走 updateGroupWithVersion（version+1）', async () => {
    const { applyRenameGroup } = await import('@/utils/mutationOps');
    const out = applyRenameGroup([mkGroup('a', [])], 'a', '新名字', NOW, STAMP);
    assert.equal(out.renamed!.name, '新名字');
    assert.equal(out.renamed!.version, 2);
    assert.equal(out.renamed!.updatedAt, NOW);
  });

  it('applyToggleGroupLock：翻转锁定', async () => {
    const { applyToggleGroupLock } = await import('@/utils/mutationOps');
    const out = applyToggleGroupLock([mkGroup('a', [], { isLocked: false })], 'a', NOW, STAMP);
    assert.equal(out.isLocked, true);
  });

  it('applyImportGroups：生成新 id、丢弃危险 URL tab、置顶', async () => {
    const { applyImportGroups } = await import('@/utils/mutationOps');
    const src = mkGroup('old', [mkTab('x', { url: 'javascript:alert(1)' }), mkTab('y')]);
    const { groups, imported } = applyImportGroups(
      [mkGroup('existing', [])],
      [src],
      { genId: (() => { let i = 0; return () => `new${++i}`; })(), sanitizeUrl: (u) => u.startsWith('javascript:') ? null : u },
      NOW,
      STAMP
    );
    assert.equal(imported.length, 1);
    assert.equal(imported[0].id, 'new1');
    assert.equal(imported[0].tabs.length, 1); // javascript: 被丢
    assert.equal(imported[0].tabs[0].id, 'new2');
    assert.equal(groups[0].id, 'new1'); // 置顶
  });
});

describe('mutationOps 本地字段（isFavorite/notes 不进 sync —— 阶段一 review fix）', () => {
  it('applyUpdateGroupFields：覆写 isFavorite/notes，【不】bump version/updatedAt', async () => {
    const { applyUpdateGroupFields } = await import('@/utils/mutationOps');
    const g = mkGroup('a', [], { isFavorite: false, notes: undefined, version: 5, updatedAt: EARLIER });
    const { groups, updated } = applyUpdateGroupFields(
      [g], 'a', { isFavorite: true, notes: 'hi' }, NOW, STAMP
    );
    const out = groups.find(x => x.id === 'a')!;
    assert.equal(out.isFavorite, true);
    assert.equal(out.notes, 'hi');
    assert.equal(out.version, 5, 'version MUST NOT bump for local-pref writes');
    assert.equal(out.updatedAt, EARLIER, 'updatedAt MUST NOT bump for local-pref writes');
    assert.equal(updated!.isFavorite, true);
  });
  it('applyUpdateGroupFields：未找到 → updated=null', async () => {
    const { applyUpdateGroupFields } = await import('@/utils/mutationOps');
    const { groups, updated } = applyUpdateGroupFields([], 'nope', { isFavorite: true }, NOW, STAMP);
    assert.equal(updated, null);
    assert.deepEqual(groups, []);
  });
  it('applyUpdateGroupFields：空 fields 对象 → 仍命中组，返回新对象（不可变）', async () => {
    const { applyUpdateGroupFields } = await import('@/utils/mutationOps');
    const g = mkGroup('a', [], { version: 2 });
    const before = g;
    const { groups, updated } = applyUpdateGroupFields([g], 'a', {}, NOW, STAMP);
    assert.notEqual(updated, before, '应返回新引用（Object.assign 创建新对象）');
    assert.equal(groups.length, 1);
    assert.equal(updated!.version, 2);
  });
  it('applyUpdateGroupFields：其他组不被影响', async () => {
    const { applyUpdateGroupFields } = await import('@/utils/mutationOps');
    const a = mkGroup('a', [], { isFavorite: false });
    const b = mkGroup('b', [], { isFavorite: false });
    const { groups } = applyUpdateGroupFields([a, b], 'a', { isFavorite: true }, NOW, STAMP);
    assert.equal(groups.find(x => x.id === 'a')!.isFavorite, true);
    assert.equal(groups.find(x => x.id === 'b')!.isFavorite, false);
  });
});

describe('mutationOps 移动与清理', () => {
  it('applyMoveGroup：交换位置并重排 displayOrder', async () => {
    const { applyMoveGroup } = await import('@/utils/mutationOps');
    const a = mkGroup('a', []), b = mkGroup('b', []);
    const out = applyMoveGroup([a, b], 0, 1, STAMP);
    assert.deepEqual(out!.map(g => g.id), ['b', 'a']);
    assert.ok(out!.every(g => typeof g.displayOrder === 'number'));
  });
  it('applyMoveGroup：索引越界 → null', async () => {
    const { applyMoveGroup } = await import('@/utils/mutationOps');
    assert.equal(applyMoveGroup([mkGroup('a', [])], 0, 5, STAMP), null);
    assert.equal(applyMoveGroup([mkGroup('a', [])], -1, 0, STAMP), null);
  });
  it('applyMoveTab：跨组移动，两侧 version+1', async () => {
    const { applyMoveTab } = await import('@/utils/mutationOps');
    const g1 = mkGroup('g1', [mkTab('t1'), mkTab('t2')]);
    const g2 = mkGroup('g2', [mkTab('t3')]);
    const { groups } = applyMoveTab([g1, g2], { sourceGroupId: 'g1', sourceIndex: 0, targetGroupId: 'g2', targetIndex: 1 }, NOW, STAMP);
    const out1 = groups.find(g => g.id === 'g1')!;
    const out2 = groups.find(g => g.id === 'g2')!;
    assert.deepEqual(out2.tabs.map(t => t.id), ['t3', 't1']);
    assert.deepEqual(out1.tabs.map(t => t.id), ['t2']);
    assert.equal(out1.version, 2);
    assert.equal(out2.version, 2);
  });
  it('applyMoveTab：同组移动只动一个组、version+1 一次', async () => {
    const { applyMoveTab } = await import('@/utils/mutationOps');
    const g1 = mkGroup('g1', [mkTab('t1'), mkTab('t2'), mkTab('t3')]);
    const { groups } = applyMoveTab([g1], { sourceGroupId: 'g1', sourceIndex: 0, targetGroupId: 'g1', targetIndex: 2 }, NOW, STAMP);
    const out = groups.find(g => g.id === 'g1')!;
    assert.deepEqual(out.tabs.map(t => t.id), ['t2', 't3', 't1']);
    assert.equal(out.version, 2);
  });
  it('applyMoveTab：跨组移空源组且未锁定 → 源组墓碑化', async () => {
    const { applyMoveTab } = await import('@/utils/mutationOps');
    const g1 = mkGroup('g1', [mkTab('t1')]);
    const g2 = mkGroup('g2', []);
    const { groups, autoDeletedGroupId } = applyMoveTab([g1, g2], { sourceGroupId: 'g1', sourceIndex: 0, targetGroupId: 'g2', targetIndex: 0 }, NOW, STAMP);
    assert.equal(autoDeletedGroupId, 'g1');
    assert.equal(groups.find(g => g.id === 'g1')!.isDeleted, true);
  });
  it('applyMoveTab：源组锁定 → 不墓碑', async () => {
    const { applyMoveTab } = await import('@/utils/mutationOps');
    const g1 = mkGroup('g1', [mkTab('t1')], { isLocked: true });
    const g2 = mkGroup('g2', []);
    const { autoDeletedGroupId } = applyMoveTab([g1, g2], { sourceGroupId: 'g1', sourceIndex: 0, targetGroupId: 'g2', targetIndex: 0 }, NOW, STAMP);
    assert.equal(autoDeletedGroupId, null);
  });
  it('applyCleanDuplicates：同 URL 保留最新（lastAccessed），其余墓碑；清理后空且未锁定的组墓碑化', async () => {
    const { applyCleanDuplicates } = await import('@/utils/mutationOps');
    const old = mkTab('old', { url: 'https://dup.com', lastAccessed: '2026-01-01T00:00:00.000Z' });
    const fresh = mkTab('fresh', { url: 'https://dup.com', lastAccessed: NOW });
    const g1 = mkGroup('g1', [old, fresh]);
    // 修正（brief 笔误）：原 brief 用 mkTab('solo', { url: 'https://x.com' }) + stale2（同 URL，旧时间戳）。
    // 由于 solo 默认 EARLIER (2026-09-01) 比 stale2 (2026-01-01) 更新 → solo 不被墓碑、g2 不空，
    // 与断言 removedGroupsCount===1 矛盾。
    // 改为让 g2 的 tab 与 g1 的 https://dup.com 重复（老时间戳）→ 被 fresh 挤掉 → g2 清空 → 墓碑 g2。
    const g2 = mkGroup('g2', [mkTab('stale2', { url: 'https://dup.com', lastAccessed: '2026-01-01T00:00:00.000Z' })]);
    const { groups, removedTabsCount, removedGroupsCount } = applyCleanDuplicates([g1, g2], NOW, STAMP);
    const out1 = groups.find(g => g.id === 'g1')!;
    assert.equal(removedTabsCount, 2);
    assert.equal(out1.tabs.find(t => t.id === 'old')!.isDeleted, true);
    assert.equal(out1.tabs.find(t => t.id === 'fresh')!.isDeleted, false);
    assert.equal(removedGroupsCount, 1); // g2 清空且未锁定
    assert.equal(groups.find(g => g.id === 'g2')!.isDeleted, true);
  });
});

// 阶段二·§5.3：stamp 盖印验收。apply* 写入 stamp 到被改实体的 lastOp 字段。
// 这是「自己写自己测」的关键锚点——既有测试不参与 stamp 决胜，本组用例钉死
// stamp 实际落到目标实体上。
describe('mutationOps: stamp 盖印（阶段二·§4.1/§5）', () => {
  it('applySaveGroup：盖 group.lastOp', async () => {
    const { applySaveGroup } = await import('@/utils/mutationOps');
    const stamp = { d: 'devA', s: 10 };
    const fresh = mkGroup('fresh', [], { createdAt: NOW });
    const out = applySaveGroup([], fresh, NOW, stamp);
    assert.deepEqual(out[0].lastOp, stamp);
  });
  it('applyRemoveTab：盖被墓碑 tab 的 lastOp，组 lastOp 不动（§5.3）', async () => {
    const { applyRemoveTab } = await import('@/utils/mutationOps');
    const stamp = { d: 'devA', s: 11 };
    const g = mkGroup('g1', [mkTab('t1'), mkTab('t2')]);
    const { groups } = applyRemoveTab([g], 'g1', 't1', NOW, stamp);
    const out = groups.find(x => x.id === 'g1')!;
    assert.deepEqual(out.tabs.find(t => t.id === 't1')!.lastOp, stamp);
    assert.equal(out.tabs.find(t => t.id === 't2')!.lastOp, undefined);
    assert.equal(out.lastOp, undefined); // §5.3：标签级操作不盖组 stamp
  });
  it('applyRemoveTab 整组清空路径：组 lastOp 也要盖（与 deleteGroup 一致）', async () => {
    const { applyRemoveTab } = await import('@/utils/mutationOps');
    const stamp = { d: 'devA', s: 12 };
    const g = mkGroup('g1', [mkTab('t1')]);
    const { groups } = applyRemoveTab([g], 'g1', 't1', NOW, stamp);
    const out = groups.find(x => x.id === 'g1')!;
    assert.deepEqual(out.lastOp, stamp); // 整组墓碑是组级删除语义
  });
  it('applyRenameGroup：盖 group.lastOp', async () => {
    const { applyRenameGroup } = await import('@/utils/mutationOps');
    const stamp = { d: 'devA', s: 13 };
    const { renamed } = applyRenameGroup([mkGroup('a', [])], 'a', '新名', NOW, stamp);
    assert.deepEqual(renamed!.lastOp, stamp);
  });
  it('applyToggleGroupLock：盖 group.lastOp', async () => {
    const { applyToggleGroupLock } = await import('@/utils/mutationOps');
    const stamp = { d: 'devA', s: 14 };
    const out = applyToggleGroupLock([mkGroup('a', [], { isLocked: false })], 'a', NOW, stamp);
    assert.deepEqual(out.groups.find(g => g.id === 'a')!.lastOp, stamp);
  });
  it('applyMoveTab：源组与目标组的 lastOp 都盖（组级操作）', async () => {
    const { applyMoveTab } = await import('@/utils/mutationOps');
    const stamp = { d: 'devA', s: 15 };
    const g1 = mkGroup('g1', [mkTab('t1')]);
    const g2 = mkGroup('g2', [mkTab('t2')]);
    const { groups } = applyMoveTab(
      [g1, g2],
      { sourceGroupId: 'g1', sourceIndex: 0, targetGroupId: 'g2', targetIndex: 1 },
      NOW,
      stamp
    );
    assert.deepEqual(groups.find(x => x.id === 'g1')!.lastOp, stamp);
    assert.deepEqual(groups.find(x => x.id === 'g2')!.lastOp, stamp);
  });
  it('applyImportGroups：导入组盖统一 stamp', async () => {
    const { applyImportGroups } = await import('@/utils/mutationOps');
    const stamp = { d: 'devA', s: 16 };
    const { imported } = applyImportGroups(
      [], [mkGroup('src', [mkTab('x')])],
      { genId: () => 'newId', sanitizeUrl: (u: string) => u },
      NOW, stamp
    );
    assert.deepEqual(imported[0].lastOp, stamp);
  });
  it('applyMoveGroup：被拖动组盖 stamp，其他组不动', async () => {
    const { applyMoveGroup } = await import('@/utils/mutationOps');
    const stamp = { d: 'devA', s: 17 };
    const a = mkGroup('a', []);
    const b = mkGroup('b', []);
    const out = applyMoveGroup([a, b], 0, 1, stamp)!;
    assert.deepEqual(out.find(g => g.id === 'a')!.lastOp, stamp); // 拖动组
    assert.equal(out.find(g => g.id === 'b')!.lastOp, undefined); // 静止组不动
  });
  it('applyCleanDuplicates：被墓碑 tab  + 被清空组都盖 stamp', async () => {
    const { applyCleanDuplicates } = await import('@/utils/mutationOps');
    const stamp = { d: 'devA', s: 18 };
    const old = mkTab('old', { url: 'https://dup.com', lastAccessed: '2026-01-01T00:00:00.000Z' });
    const fresh = mkTab('fresh', { url: 'https://dup.com', lastAccessed: NOW });
    const g1 = mkGroup('g1', [old, fresh]);
    const g2 = mkGroup('g2', [mkTab('stale2', { url: 'https://dup.com', lastAccessed: '2026-01-01T00:00:00.000Z' })]);
    const { groups } = applyCleanDuplicates([g1, g2], NOW, stamp);
    const out1 = groups.find(g => g.id === 'g1')!;
    assert.deepEqual(out1.tabs.find(t => t.id === 'old')!.lastOp, stamp);
    assert.deepEqual(out1.lastOp, stamp); // 组也被改（tabs 变化 → version bump → 盖组 stamp）
    assert.deepEqual(groups.find(g => g.id === 'g2')!.lastOp, stamp); // 整组墓碑也盖 stamp
  });
});
