// 钉死 SW 单写者使用的语义纯函数（无墓碑模型，2026-09-29）：
// 1) applySaveGroup —— 新组置顶并按 createdAt 倒序排序；
// 2) applyRemoveTab —— 命令式指定 (groupId, tabId) **物理移除**，删除意图由
//    pendingDeleteIds 队列 + 整组行上传广播（见 tests/_new-delete-semantics.md）。
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
// stamp 入参不参与决胜，仅验证透传到被改实体（具体验收见文末 stamp 盖印 describe 块）。
const STAMP = { d: 'devTest', s: 1 };

function mkTab(id: string, over: Record<string, unknown> = {}) {
  return { id, url: `https://e.com/${id}`, title: id, favicon: '', createdAt: EARLIER, lastAccessed: EARLIER, pinned: false, ...over };
}
function mkGroup(id: string, tabs: unknown[], over: Record<string, unknown> = {}) {
  return { id, name: `g-${id}`, tabs, createdAt: EARLIER, updatedAt: EARLIER, version: 1, isLocked: false, ...over };
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

describe('mutationOps.applyRemoveTab（物理移除语义，2026-09-29 无墓碑重写）', () => {
  it('只移除指定 tab：其余 tab 原样，组 version+1、updatedAt=now', async () => {
    const { applyRemoveTab } = await import('@/utils/mutationOps');
    const g = mkGroup('g1', [mkTab('t1'), mkTab('t2')]);
    const { groups, group } = applyRemoveTab([g], 'g1', 't1', NOW, STAMP);
    const out = groups.find(x => x.id === 'g1')!;
    assert.equal(group!.version, 2);
    assert.equal(out.tabs.some(t => t.id === 't1'), false, '被删 tab 物理移除，不留墓碑');
    assert.equal(out.tabs.find(t => t.id === 't2')!.isDeleted, undefined);
    assert.equal(out.updatedAt, NOW);
    assert.equal(out.tabs.find(t => t.id === 't2')!.lastAccessed, EARLIER); // 未动
  });
  it('删除最后一个 tab 且组未锁定 → 整组物理移除（removedGroupId 回报广播 id）', async () => {
    const { applyRemoveTab } = await import('@/utils/mutationOps');
    const g = mkGroup('g1', [mkTab('t1')]);
    const r = applyRemoveTab([g], 'g1', 't1', NOW, STAMP);
    assert.equal(r.group, null);
    assert.equal(r.groups.some(x => x.id === 'g1'), false, '空组被物理移除');
    assert.equal(r.removedGroupId, 'g1', '回报被删组 id，供调用方登记删除广播队列');
  });
  it('锁定组删到最后一个 tab → tab 移除，组保留为空（锁定豁免自动删除）', async () => {
    const { applyRemoveTab } = await import('@/utils/mutationOps');
    const g = mkGroup('g1', [mkTab('t1')], { isLocked: true });
    const { groups, group } = applyRemoveTab([g], 'g1', 't1', NOW, STAMP);
    assert.equal(group!.isLocked, true);
    assert.equal(groups.find(x => x.id === 'g1')!.tabs.length, 0);
    assert.equal(group!.version, 2);
  });
  it('老版本残留墓碑 tab 不算内容：删掉活跃 tab 后按 shouldAutoDeleteAfterTabRemoval 判空', async () => {
    const { applyRemoveTab } = await import('@/utils/mutationOps');
    const g = mkGroup('g1', [mkTab('dead', { isDeleted: true }), mkTab('t1')]);
    const r = applyRemoveTab([g], 'g1', 't1', NOW, STAMP);
    // 判据走 shouldAutoDeleteAfterTabRemoval（跳过 isDeleted tab）：删掉 t1 后组内
    // 无活跃 tab → 整组物理移除，残留墓碑一并清掉
    assert.equal(r.groups.some(x => x.id === 'g1'), false, '按活跃计数判空并物理移除');
    assert.equal(r.removedGroupId, 'g1');
  });
  it('tab 不存在 → group 返回 null，数组原样（幂等，不 bump version）', async () => {
    const { applyRemoveTab } = await import('@/utils/mutationOps');
    const g = mkGroup('g1', [mkTab('t1')]);
    const { groups, group } = applyRemoveTab([g], 'g1', 'nope', NOW, STAMP);
    assert.equal(group, null);
    assert.equal(groups[0].version, 1, '幂等命中不膨胀 version');
  });
  it('组不存在 → group 返回 null，数组原样', async () => {
    const { applyRemoveTab } = await import('@/utils/mutationOps');
    const { groups, group } = applyRemoveTab([], 'nope', 't1', NOW, STAMP);
    assert.equal(group, null);
    assert.equal(groups.length, 0);
  });
});

describe('mutationOps 组生命周期（物理删除）', () => {
  it('applyDeleteGroup：物理移除目标组，其余组不动，removedGroupId 回报', async () => {
    const { applyDeleteGroup } = await import('@/utils/mutationOps');
    const r = applyDeleteGroup([mkGroup('a', [mkTab('a1')]), mkGroup('b', [mkTab('b1')])], 'a', NOW, STAMP);
    assert.equal(r.groups.some(g => g.id === 'a'), false, '目标组被物理移除');
    assert.equal(r.removedGroupId, 'a');
    assert.equal(r.groups.some(g => g.id === 'b'), true, '其他组不受影响');
  });

  it('applyDeleteGroup：组不存在 → 原样返回（幂等）', async () => {
    const { applyDeleteGroup } = await import('@/utils/mutationOps');
    const groups = [mkGroup('b', [mkTab('b1')])];
    const r = applyDeleteGroup(groups, 'nope', NOW, STAMP);
    assert.equal(r.removedGroupId, null);
    assert.equal(r.groups.length, 1);
  });

  it('applyDeleteAllGroups：全部物理移除，removedGroupIds 含所有组，count = 原组数', async () => {
    const { applyDeleteAllGroups } = await import('@/utils/mutationOps');
    const out = applyDeleteAllGroups([mkGroup('a', [mkTab('a1')]), mkGroup('shell', [])], NOW, STAMP);
    assert.equal(out.groups.length, 0);
    assert.equal(out.count, 2);
    assert.deepEqual(out.removedGroupIds.sort(), ['a', 'shell']);
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
  it('applyMoveTab：跨组移空源组且未锁定 → 源组物理移除（removedGroupId 回报）', async () => {
    const { applyMoveTab } = await import('@/utils/mutationOps');
    const g1 = mkGroup('g1', [mkTab('t1')]);
    const g2 = mkGroup('g2', []);
    const { groups, removedGroupId } = applyMoveTab([g1, g2], { sourceGroupId: 'g1', sourceIndex: 0, targetGroupId: 'g2', targetIndex: 0 }, NOW, STAMP);
    assert.equal(removedGroupId, 'g1');
    assert.equal(groups.some(g => g.id === 'g1'), false, '空源组被物理移除');
    assert.equal(groups.find(g => g.id === 'g2')!.tabs.length, 1, '标签已落到目标组');
  });
  it('applyMoveTab：源组锁定 → 组保留为空', async () => {
    const { applyMoveTab } = await import('@/utils/mutationOps');
    const g1 = mkGroup('g1', [mkTab('t1')], { isLocked: true });
    const g2 = mkGroup('g2', []);
    const { groups, removedGroupId } = applyMoveTab([g1, g2], { sourceGroupId: 'g1', sourceIndex: 0, targetGroupId: 'g2', targetIndex: 0 }, NOW, STAMP);
    assert.equal(removedGroupId, null);
    assert.equal(groups.find(g => g.id === 'g1')!.tabs.length, 0, '锁定组保留空壳');
  });
  it('applyCleanDuplicates：同 URL 保留最新（lastAccessed），败者物理移除；清空的组物理移除', async () => {
    const { applyCleanDuplicates } = await import('@/utils/mutationOps');
    const old = mkTab('old', { url: 'https://dup.com', lastAccessed: '2026-01-01T00:00:00.000Z' });
    const fresh = mkTab('fresh', { url: 'https://dup.com', lastAccessed: NOW });
    const g1 = mkGroup('g1', [old, fresh]);
    const g2 = mkGroup('g2', [mkTab('stale2', { url: 'https://dup.com', lastAccessed: '2026-01-01T00:00:00.000Z' })]);
    const { groups, removedTabsCount, removedGroupsCount, removedGroupIds } = applyCleanDuplicates([g1, g2], NOW, STAMP);
    const out1 = groups.find(g => g.id === 'g1')!;
    assert.equal(removedTabsCount, 2);
    assert.equal(out1.tabs.some(t => t.id === 'old'), false, '败者 tab 物理移除，不留墓碑');
    assert.equal(out1.tabs.some(t => t.id === 'fresh'), true);
    assert.equal(removedGroupsCount, 1); // g2 被清空且未锁定
    assert.equal(groups.some(g => g.id === 'g2'), false, '被清空的组被物理移除');
    assert.deepEqual(removedGroupIds, ['g2'], '回报被删组 id 供登记删除广播队列');
  });
  it('applyCleanDuplicates：loading:// 同 URL 不同标题视为不同 tab（不去重）', async () => {
    const { applyCleanDuplicates } = await import('@/utils/mutationOps');
    const a = mkTab('a', { url: 'loading://x', title: '页面A' });
    const b = mkTab('b', { url: 'loading://x', title: '页面B' });
    const { groups, removedTabsCount } = applyCleanDuplicates([mkGroup('g', [a, b])], NOW, STAMP);
    assert.equal(removedTabsCount, 0);
    assert.equal(groups[0].tabs.length, 2);
  });
});

// stamp 盖印验收。apply* 写入 stamp 到被改实体的 lastOp 字段。
describe('mutationOps: stamp 盖印', () => {
  it('applySaveGroup：盖 group.lastOp', async () => {
    const { applySaveGroup } = await import('@/utils/mutationOps');
    const stamp = { d: 'devA', s: 10 };
    const fresh = mkGroup('fresh', [], { createdAt: NOW });
    const out = applySaveGroup([], fresh, NOW, stamp);
    assert.deepEqual(out[0].lastOp, stamp);
  });
  it('applyRemoveTab：组 lastOp 同步提升（组是 LWW 广播的载体）；被删 tab 物理移除无实体可盖', async () => {
    const { applyRemoveTab } = await import('@/utils/mutationOps');
    const stamp = { d: 'devA', s: 11 };
    const g = mkGroup('g1', [mkTab('t1'), mkTab('t2')]);
    const { groups } = applyRemoveTab([g], 'g1', 't1', NOW, stamp);
    const out = groups.find(x => x.id === 'g1')!;
    assert.equal(out.tabs.some(t => t.id === 't1'), false);
    assert.equal(out.tabs.find(t => t.id === 't2')!.lastOp, undefined);
    // 组 stamp 提升是删除广播的前提：整组行上传后对端按组 stamp 整组覆盖
    assert.deepEqual(out.lastOp, stamp);
  });
  it('applyRemoveTab 整组清空路径：组物理移除，无实体承接 stamp', async () => {
    const { applyRemoveTab } = await import('@/utils/mutationOps');
    const stamp = { d: 'devA', s: 12 };
    const g = mkGroup('g1', [mkTab('t1')]);
    const r = applyRemoveTab([g], 'g1', 't1', NOW, stamp);
    assert.equal(r.groups.some(x => x.id === 'g1'), false, '空组被物理移除');
    assert.equal(r.removedGroupId, 'g1', '回报被删组 id 供登记删除广播队列');
    assert.equal(r.group, null, '无存活组可回填');
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
  it('applyMoveTab：目标组的 lastOp 盖（组级操作）；被移空的源组物理移除', async () => {
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
    assert.equal(groups.some(x => x.id === 'g1'), false, '被移空的源组被物理移除');
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
  it('applyCleanDuplicates：存活组盖 stamp；被清空的组物理移除（无实体不盖）', async () => {
    const { applyCleanDuplicates } = await import('@/utils/mutationOps');
    const stamp = { d: 'devA', s: 18 };
    const old = mkTab('old', { url: 'https://dup.com', lastAccessed: '2026-01-01T00:00:00.000Z' });
    const fresh = mkTab('fresh', { url: 'https://dup.com', lastAccessed: NOW });
    const g1 = mkGroup('g1', [old, fresh]);
    const g2 = mkGroup('g2', [mkTab('stale2', { url: 'https://dup.com', lastAccessed: '2026-01-01T00:00:00.000Z' })]);
    const { groups } = applyCleanDuplicates([g1, g2], NOW, stamp);
    const out1 = groups.find(g => g.id === 'g1')!;
    assert.deepEqual(out1.lastOp, stamp); // 组被改（tabs 变化 → version bump → 盖组 stamp）
    assert.equal(groups.some(g => g.id === 'g2'), false);
  });
});
