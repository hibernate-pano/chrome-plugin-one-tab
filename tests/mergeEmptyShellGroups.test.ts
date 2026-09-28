// 回归：同步合并不得留下空壳会话（2026-09-28 统一规则的同步侧）。
//
// 真实 bug（Jasper 报「切双栏多出空标签组、越攒越多」）：mergeTabsOpStamped 的 URL
// 去重给败者盖**标签级**墓碑，却从不处理组——组墓碑不置位，于是被剥空的组以
// isDeleted:false 落盘，在 UI 渲染成空会话卡，且每轮后台同步都有机会再剥空一个。
//
// 修复：合并结果落盘前用统一判据剔除空壳（dropEmptyShellGroups），并把 id 登记进
// purge 队列让云端行一并删除——只删本地的话云端行残留，下次下载以 remote-only 复活。
//
// 这里直测判据与合并结果的衔接（不拉起整个 syncEngine，避免网络与登录态依赖）。

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

const NOW = '2026-09-28T10:00:00.000Z';

let dropEmptyShellGroups: typeof import('../src/core/mutationOps.ts').dropEmptyShellGroups;
let isEmptyShellGroup: typeof import('../src/core/mutationOps.ts').isEmptyShellGroup;
let mergeOpStamped: typeof import('../src/utils/opStampMerge.ts').mergeOpStamped;

function tab(id: string, url: string, extra: Record<string, unknown> = {}) {
  return { id, url, title: id, createdAt: NOW, lastAccessed: NOW, pinned: false, ...extra };
}

function group(id: string, tabs: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id, name: `g-${id}`, tabs,
    createdAt: NOW, updatedAt: NOW, isLocked: false, version: 1, ...extra,
  } as any;
}

before(async () => {
  register(LOADER_PATH, import.meta.url);
  ({ dropEmptyShellGroups, isEmptyShellGroup } = await import('../src/core/mutationOps.ts'));
  ({ mergeOpStamped } = await import('../src/utils/opStampMerge.ts'));
});

describe('同步合并 · 空壳会话不留', () => {
  it('云端删光组内标签后合并出的组被判为空壳（空组越攒越多的机制）', () => {
    // 真实场景：本机还持有活跃副本，别的设备把该组标签全删了。云端行带更新的
    // 印记且组内 tab 全是墓碑 → 合并按 stamp 决胜，墓碑版本赢下组字段与 tab 列表。
    // 注意组级墓碑从未置位——这就是空壳能留在 UI 上的唯一原因。
    const local = [group('g1', [tab('t1', 'https://a.com'), tab('t2', 'https://b.com')])];
    const cloud = [group('g1', [
      tab('t1', 'https://a.com', { isDeleted: true, lastOp: { d: 'devB', s: 50 } }),
      tab('t2', 'https://b.com', { isDeleted: true, lastOp: { d: 'devB', s: 50 } }),
    ], { lastOp: { d: 'devB', s: 50 } })];

    const merged = mergeOpStamped(local, cloud, { mergeStamp: { d: 'devA', s: 99 } });
    const g = merged.find(x => x.id === 'g1')!;

    assert.equal(g.tabs.filter(t => !t.isDeleted).length, 0, '云端删除意图合并后组被剥空');
    assert.notEqual(g.isDeleted, true, '关键：组墓碑从未置位（这正是空壳能留在 UI 的原因）');
    assert.equal(isEmptyShellGroup(g), true, '因此必须被判为空壳');
  });

  it('合并结果落盘前剔除空壳：UI 侧永远拿不到空会话卡', () => {
    const local = [group('g1', [tab('t1', 'https://a.com')]), group('ok', [tab('t3', 'https://b.com')])];
    const cloud = [group('g1', [tab('t1', 'https://a.com', { isDeleted: true, lastOp: { d: 'devB', s: 50 } })], { lastOp: { d: 'devB', s: 50 } })];
    const merged = mergeOpStamped(local, cloud, { mergeStamp: { d: 'devA', s: 100 } });
    const final = dropEmptyShellGroups(merged);

    assert.deepEqual(final.map(g => g.id), ['ok'], '被剥空的组不进落盘结果');
  });

  it('有内容的组与锁定组一律保留（不得误伤）', () => {
    const groups = [
      group('ok', [tab('t1', 'https://a.com')]),
      group('locked-empty', [], { isLocked: true }), // 锁定 = 用户显式防误删
    ];
    const final = dropEmptyShellGroups(groups);

    assert.deepEqual(final.map(g => g.id), ['ok', 'locked-empty'], '锁定空组豁免自动清理');
  });

  it('回收站里仍有标签的墓碑组不受影响（可恢复性不能被破坏）', () => {
    const groups = [group('in-bin', [tab('t1', 'https://a.com')], { isDeleted: true })];
    const final = dropEmptyShellGroups(groups);

    assert.equal(final.length, 1, '有内容的墓碑组留在回收站等恢复');
  });

  it('纯函数：输入不被就地修改', () => {
    const groups = [group('dup', [tab('t1', 'https://a.com', { isDeleted: true })])];
    const snapshot = JSON.stringify(groups);

    dropEmptyShellGroups(groups);

    assert.equal(JSON.stringify(groups), snapshot);
  });
});
