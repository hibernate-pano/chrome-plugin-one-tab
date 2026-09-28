// 回归：全墓碑组（tabs 全被墓碑化）不得作为空会话卡留在活跃列表。
//
// 真实场景（2026-09-28 Jasper 报「切双栏多出空标签组」）：tab 被非 moveTab 路径
// 清空——同步合并把远端删除意图落成本地 tab 墓碑、云端删光整组、URL 去重败者盖
// 墓碑——组级墓碑不置位，stripTombstonedTabs 剥完标签级墓碑只剩 tabs: []，
// 于是一张空会话卡永远挂在列表里。
//
// 修复：toActiveGroupsView 复用 moveTab reducer 既有的 shouldAutoDeleteAfterTabRemoval
// 判据把空壳会话剔出活跃视图；锁定组豁免（用户显式保护，不静默隐藏）。
// 只过滤视图、不写 storage——读路径不产生写（v1.21.2 墓碑灌入事故的教训）。

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

let toActiveGroupsView: typeof import('../src/store/slices/tabSliceHelpers.ts').toActiveGroupsView;

const NOW = '2026-09-28T08:00:00.000Z';

function tab(id: string, extra: Record<string, unknown> = {}) {
  return { id, url: `https://${id}.com`, title: id, createdAt: NOW, lastAccessed: NOW, pinned: false, ...extra };
}

function group(id: string, tabs: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `g-${id}`,
    tabs,
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    version: 1,
    ...extra,
  } as any;
}

before(async () => {
  register(LOADER_PATH, import.meta.url);
  ({ toActiveGroupsView } = await import('../src/store/slices/tabSliceHelpers.ts'));
});

describe('toActiveGroupsView · 空壳会话', () => {
  it('全墓碑组（剥完无活跃 tab）不进活跃视图——就是那张凭空多出的空卡', () => {
    const groups = [
      group('all-tombstoned', [tab('t1', { isDeleted: true }), tab('t2', { isDeleted: true })]),
      group('normal', [tab('t3')]),
    ];

    const view = toActiveGroupsView(groups);

    assert.equal(view.length, 1, '空壳会话必须被剔出活跃视图');
    assert.equal(view[0].id, 'normal');
  });

  it('本来就没有标签的组同样不进活跃视图（同步删光整组）', () => {
    const view = toActiveGroupsView([group('empty', []), group('normal', [tab('t1')])]);

    assert.deepEqual(view.map(g => g.id), ['normal']);
  });

  it('部分墓碑的组保留，并剥掉墓碑标签', () => {
    const view = toActiveGroupsView([
      group('mixed', [tab('t1'), tab('t2', { isDeleted: true })]),
    ]);

    assert.equal(view.length, 1);
    assert.deepEqual(view[0].tabs.map(t => t.id), ['t1'], '墓碑标签不进 UI');
  });

  it('锁定组豁免：用户显式保护的空会话不静默隐藏', () => {
    const view = toActiveGroupsView([
      group('locked-empty', [tab('t1', { isDeleted: true })], { isLocked: true }),
    ]);

    assert.equal(view.length, 1, '锁定组沿用既有语义：不自动删除');
  });

  it('组级墓碑照旧剔除，且不误伤正常组', () => {
    const view = toActiveGroupsView([
      group('group-tombstone', [tab('t1')], { isDeleted: true }),
      group('normal', [tab('t2')]),
    ]);

    assert.deepEqual(view.map(g => g.id), ['normal']);
  });

  it('不产生写：输入数组不被就地修改（读路径绝不改数据）', () => {
    const groups = [group('all-tombstoned', [tab('t1', { isDeleted: true })])];
    const snapshot = JSON.stringify(groups);

    toActiveGroupsView(groups);

    assert.equal(JSON.stringify(groups), snapshot, 'toActiveGroupsView 必须是纯函数');
  });
});
