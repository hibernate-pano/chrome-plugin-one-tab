// tabSelectors 测试：钉死 selector 切片契约。
//
// 5 个测试覆盖：
// 1. selectGroups 返回 tabSlice.groups
// 2. selectIsLoading 返回 tabSlice.isLoading
// 3. selectSortedGroups 排序：createdAt desc
// 4. selectSortedGroups memoization：相同输入返回相同引用
// 5. selectSortedGroups 当 groups 变化时返回新引用
// 6. selectSortedGroups 忽略 searchQuery（consumer-side filter）

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
// 静态 import 会在顶层求值，绕过 register 钩子，导致 ERR_MODULE_NOT_FOUND。
const { selectGroups, selectSortedGroups, selectIsLoading } = await import(
  '@/store/selectors/tabSelectors'
);
const { initialTabState } = await import('@/store/slices/tabSlice');
import type { RootState } from '@/store';

function makeRootState(overrides: Partial<RootState> = {}): RootState {
  return {
    tabs: { ...initialTabState, ...overrides.tabs },
    settings: overrides.settings ?? ({} as any),
    auth: overrides.auth ?? ({} as any),
  } as RootState;
}

const mkGroup = (overrides: any) => ({
  id: 'g',
  name: 'n',
  createdAt: '2026-08-05T00:00:00Z',
  updatedAt: '2026-08-05T00:00:00Z',
  tabs: [],
  isLocked: false,
  isDeleted: false,
  displayOrder: 0,
  ...overrides,
});

test('selectGroups returns tabSlice.groups', () => {
  const s = makeRootState({ tabs: { groups: [mkGroup({ id: 'a' })] } as any });
  assert.equal(selectGroups(s)[0].id, 'a');
});

test('selectIsLoading returns tabSlice.isLoading', () => {
  assert.equal(selectIsLoading(makeRootState({ tabs: { isLoading: true } as any })), true);
  assert.equal(selectIsLoading(makeRootState()), false);
});

test('selectSortedGroups sorts by createdAt desc (newest first)', () => {
  const a = mkGroup({ id: 'a', createdAt: '2026-08-01T00:00:00Z' });
  const b = mkGroup({ id: 'b', createdAt: '2026-08-05T00:00:00Z' });
  const c = mkGroup({ id: 'c', createdAt: '2026-08-03T00:00:00Z' });
  const s = makeRootState({ tabs: { groups: [a, b, c] } as any });
  const sorted = selectSortedGroups(s);
  assert.deepEqual(sorted.map(g => g.id), ['b', 'c', 'a']);
});

test('selectSortedGroups is memoized: same input returns same reference', () => {
  const a = mkGroup({ id: 'a' });
  const s = makeRootState({ tabs: { groups: [a] } as any });
  const r1 = selectSortedGroups(s);
  const r2 = selectSortedGroups(s);
  assert.equal(r1, r2); // createSelector memo
});

test('selectSortedGroups returns NEW ref when groups change', () => {
  const a = mkGroup({ id: 'a' });
  const s1 = makeRootState({ tabs: { groups: [a] } as any });
  const s2 = makeRootState({ tabs: { groups: [a, mkGroup({ id: 'b' })] } as any });
  assert.notEqual(selectSortedGroups(s1), selectSortedGroups(s2));
});

test('selectSortedGroups ignores searchQuery (consumer-side filter)', () => {
  // 共享同一个 groups 引用，让 createSelector 走 memo 路径。
  // 真正要验证的不变式是：searchQuery 变化不应导致 sorted 重算。
  const sharedGroups = [mkGroup({ id: 'a' })];
  const s1 = makeRootState({ tabs: { groups: sharedGroups, searchQuery: '' } as any });
  const s2 = makeRootState({ tabs: { groups: sharedGroups, searchQuery: 'xxx' } as any });
  assert.equal(selectSortedGroups(s1), selectSortedGroups(s2));
});
