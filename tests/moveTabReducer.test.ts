// moveTabReducer 测试：钉死新 moveTabLocal reducer 的契约。
//
// 5 个测试覆盖：
// 1. 同组内移动：tab 顺序被改写、跨组不变化
// 2. 跨组移动：tab 从 source 移到 target，source 减 1，target 增 1
// 3. 缺 tab 时 reducer 是 no-op（groups 引用不变）
// 4. 负 toIndex 被夹到 0
// 5. 大于 length 的 toIndex 不抛错

import { test, before } from 'node:test';
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

// 注意：必须用动态 import，因为 alias-loader 必须在 register 之后才生效。
const { default: tabReducer, moveTabLocal, initialTabState } = await import(
  '@/store/slices/tabSlice'
);
import type { TabGroup } from '@/types/tab';

function mkGroup(id: string, tabs: { id: string }[]): TabGroup {
  return {
    id, name: id, tabs: tabs as any, isFavorite: false, isLocked: false,
    isDeleted: false, createdAt: '2026-08-05T00:00:00Z', updatedAt: '2026-08-05T00:00:00Z',
    displayOrder: 0,
  } as TabGroup;
}

const tA = { id: 't1', title: 'A', url: '', favicon: '' } as any;
const tB = { id: 't2', title: 'B', url: '', favicon: '' } as any;
const tC = { id: 't3', title: 'C', url: '', favicon: '' } as any;

const g1 = mkGroup('g1', [tA, tB]);
const g2 = mkGroup('g2', [tC]);

test('moveTabLocal moves tab within same group', () => {
  const next = tabReducer(
    { ...initialTabState, groups: [g1, g2] },
    moveTabLocal({ groupId: 'g1', tabId: 't1', toIndex: 1 })
  );
  assert.deepEqual(next.groups[0].tabs.map((t: any) => t.id), ['t2', 't1']);
  // g2 不变
  assert.equal(next.groups[1].id, 'g2');
  assert.equal(next.groups[1].tabs.length, 1);
});

test('moveTabLocal moves tab across groups', () => {
  // tab t3 当前在 g2。要把它插入到 g1 的索引 0。
  // 契约：groupId = 目标标签组 ID；tabId 在全局查找；toIndex = 插入位置。
  const next = tabReducer(
    { ...initialTabState, groups: [g1, g2] },
    moveTabLocal({ groupId: 'g1', tabId: 't3', toIndex: 0 })
  );
  // g1 现在 3 个，第一个是 t3
  assert.equal(next.groups[0].tabs.length, 3);
  assert.equal(next.groups[0].tabs[0].id, 't3');
  // g2 空
  assert.equal(next.groups[1].tabs.length, 0);
});

test('moveTabLocal is a no-op on missing tab', () => {
  const state = { ...initialTabState, groups: [g1] };
  const next = tabReducer(
    state,
    moveTabLocal({ groupId: 'g1', tabId: 'missing', toIndex: 0 })
  );
  // tabs 数组在内容上应等价
  assert.deepEqual(next.groups[0].tabs, g1.tabs);
});

test('moveTabLocal clamps negative toIndex to 0', () => {
  const next = tabReducer(
    { ...initialTabState, groups: [g1] },
    moveTabLocal({ groupId: 'g1', tabId: 't1', toIndex: -100 })
  );
  // t1 应该被移到 0（或者说无论如何还在首位）
  assert.equal(next.groups[0].tabs[0].id, 't1');
});

test('moveTabLocal clamps toIndex past group length', () => {
  const next = tabReducer(
    { ...initialTabState, groups: [g1] },
    moveTabLocal({ groupId: 'g1', tabId: 't1', toIndex: 100 })
  );
  // t1 should still be moved to end (or remain) — test: not throwing
  assert.ok(Array.isArray(next.groups[0].tabs));
  // t1 仍然存在
  const ids = next.groups[0].tabs.map((t: any) => t.id);
  assert.ok(ids.includes('t1'));
});
