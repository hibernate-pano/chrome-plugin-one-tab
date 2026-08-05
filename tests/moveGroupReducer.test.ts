// moveGroupLocal reducer 测试：钉死新 moveGroupLocal reducer 的契约。
//
// 5 个测试覆盖：
// 1. 列表内移动：groups 顺序被改写
// 2. 无效 dragIndex 是 no-op（groups 引用不变，memoization 友好）
// 3. hoverIndex 越界被 clamp（正向到末尾、负向到开头）
// 4. 顺序正确性：上移/下移都正确，displayOrder 与移动后索引一致，
//    version 跟随 updateDisplayOrder 语义递增（旧存储路径产出一致）
// 5. memo/immutability：no-op 返回同一引用；真实移动不修改输入、返回新引用

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
const { default: tabReducer, moveGroupLocal, initialTabState } = await import(
  '@/store/slices/tabSlice'
);
import type { TabGroup } from '@/types/tab';

function mkGroup(id: string, overrides: Partial<TabGroup> = {}): TabGroup {
  return {
    id, name: id, tabs: [], isFavorite: false, isLocked: false,
    isDeleted: false, createdAt: '2026-08-05T00:00:00Z', updatedAt: '2026-08-05T00:00:00Z',
    displayOrder: 0, version: 1,
    ...overrides,
  } as TabGroup;
}

const ids = (groups: TabGroup[]) => groups.map(g => g.id);

test('moveGroupLocal moves group within the list', () => {
  const groups = [mkGroup('g1'), mkGroup('g2'), mkGroup('g3')];
  // 下移：g1 从 0 移到 2 → [g2, g3, g1]（索引为移动前数组索引）
  const next = tabReducer(
    { ...initialTabState, groups },
    moveGroupLocal({ dragIndex: 0, hoverIndex: 2 })
  );
  assert.deepEqual(ids(next.groups), ['g2', 'g3', 'g1']);
});

test('moveGroupLocal is a no-op on invalid dragIndex', () => {
  const groups = [mkGroup('g1'), mkGroup('g2')];
  const state = { ...initialTabState, groups };
  const next = tabReducer(state, moveGroupLocal({ dragIndex: 5, hoverIndex: 0 }));
  // 引用不变（memoization 友好）+ 内容不变
  assert.equal(next.groups, groups);
  const nextNeg = tabReducer(state, moveGroupLocal({ dragIndex: -1, hoverIndex: 0 }));
  assert.equal(nextNeg.groups, groups);
});

test('moveGroupLocal clamps hoverIndex out of range', () => {
  const groups = [mkGroup('g1'), mkGroup('g2'), mkGroup('g3')];
  // 正向越界 → 移到末尾
  const toEnd = tabReducer(
    { ...initialTabState, groups },
    moveGroupLocal({ dragIndex: 0, hoverIndex: 100 })
  );
  assert.deepEqual(ids(toEnd.groups), ['g2', 'g3', 'g1']);
  // 负向越界 → 移到开头
  const toStart = tabReducer(
    { ...initialTabState, groups },
    moveGroupLocal({ dragIndex: 2, hoverIndex: -5 })
  );
  assert.deepEqual(ids(toStart.groups), ['g3', 'g1', 'g2']);
});

test('moveGroupLocal keeps order + displayOrder consistent after moves', () => {
  const groups = [mkGroup('g1'), mkGroup('g2'), mkGroup('g3'), mkGroup('g4')];
  // 上移：g4 从 3 移到 1 → [g1, g4, g2, g3]
  let next = tabReducer(
    { ...initialTabState, groups },
    moveGroupLocal({ dragIndex: 3, hoverIndex: 1 })
  );
  assert.deepEqual(ids(next.groups), ['g1', 'g4', 'g2', 'g3']);
  // displayOrder 必须与移动后索引一致
  next.groups.forEach((g, i) => assert.equal(g.displayOrder, i));
  // version 跟随 updateDisplayOrder 语义 +1（旧存储路径产出一致，sync 依赖）
  next.groups.forEach(g => assert.equal(g.version, 2));

  // 再下移：g1 从 0 移到 3 → [g4, g2, g3, g1]
  next = tabReducer(
    { ...initialTabState, groups: next.groups },
    moveGroupLocal({ dragIndex: 0, hoverIndex: 3 })
  );
  assert.deepEqual(ids(next.groups), ['g4', 'g2', 'g3', 'g1']);
  next.groups.forEach((g, i) => assert.equal(g.displayOrder, i));

  // 原地移动（dragIndex === hoverIndex）no-op：引用与顺序都不变
  const same = tabReducer(
    { ...initialTabState, groups: next.groups },
    moveGroupLocal({ dragIndex: 1, hoverIndex: 1 })
  );
  assert.equal(same.groups, next.groups);
});

test('moveGroupLocal does not mutate input; real move returns new references', () => {
  const groups = [mkGroup('g1'), mkGroup('g2'), mkGroup('g3')];
  const snapshot = JSON.stringify(groups.map(g => ({ id: g.id, displayOrder: g.displayOrder })));
  const state = { ...initialTabState, groups };
  const next = tabReducer(state, moveGroupLocal({ dragIndex: 0, hoverIndex: 2 }));

  // 输入未被修改（immer 保证）
  assert.deepEqual(
    groups.map(g => ({ id: g.id, displayOrder: g.displayOrder })),
    JSON.parse(snapshot)
  );
  // 输出是新数组 + 新 group 对象
  assert.notEqual(next.groups, groups);
  assert.notEqual(next.groups[0], groups[0]);
  // 其余 state 字段不受影响
  assert.equal(next.isLoading, initialTabState.isLoading);
  assert.equal(next.searchQuery, initialTabState.searchQuery);
});
