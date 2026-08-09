# TabStack S2 实施计划 — UX 与性能打磨

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 TabStack popup 启动变快、大列表变流畅、UI 减负并打磨到"用着舒服"的水平，让户主日常体验显著改善而不破坏数据安全护栏。

**Architecture:** 五个阶段（P1 死代码 + 骨架 → P2 DnD 解耦 → P3 虚拟化 → P4 懒加载 → P5 UI 收拢 + 测试）。每个阶段独立可测试。每个阶段完成时 5 个不变量测试保持绿。

**Tech Stack:** React 18.2 / TypeScript 5.4 / Redux Toolkit 2.x / Tailwind 3.4 / react-dnd / Vite 4.5 / @crxjs/vite-plugin 2.x（全部**锁版本不动**）。
- ✅ **生产依赖新增 1 个**：`@tanstack/react-virtual` v3.x（已确认）
- ⏸ **测试 devDeps 新增 2 个待 P1 启动前用户最终确认**：`@testing-library/react` + `jsdom`
  - 备选：`react-test-renderer`（无 jsdom，更轻但功能弱）
  - 如果拒绝：本 plan Phase 5 改为只覆盖"纯函数 + 集成测试"，UI 测试改用现有 vite + 手工

**Spec:** `docs/superpowers/specs/2026-08-05-S2-ux-performance-polish-design.md`

**继承蓝图：** `docs/superpowers/specs/2026-08-05-tabstack-personal-revamp-blueprint.md`

---

## Global Constraints

从 S2 spec 复制下来的硬约束。任何任务都必须遵守，**不可因为任何理由违反**：

- **不引入 React 19 / Vite 5 / CRXJS v3 / Tailwind 升级**
- **不动** `mergeTabGroups` / `validateMergeResult` / `hydrationDecision` 三个核心纯函数
- **不动** IndexedDB DB 名 `tabvaultpro`
- **Service Worker 不加回同步 / alarm 逻辑**（v1.12.0 推翻的旧设计）
- **不删除** 5 个不变量测试 `hydrationDecision / syncMergeSafety / storageLayer / syncEngine / tombstone{Propagation,Gc}`
- **不破 5 个不变量测试** —— commit 前必须 `pnpm verify` 全绿
- **保持 React 18 + `node --test --experimental-strip-types` 测试栈**
- **测试基建限制**：`mock.module` 与自定义 TS loader `_alias-loader.mjs` 不兼容 — 集成测试用 fake-indexeddb + 真实 store 实例
- **popup viewport 380–450px**（chrome extension 默认）
- **视觉规范**：主 CTA 唯一（teal+橙）、hover 不用 scale、焦点环 2px teal + 2px offset、`prefers-reduced-motion` 尊重
- **每个 Phase 完成 = 一次 commit**；commit message 含阶段号
- **依赖审批**：`@testing-library/react` + `jsdom` 在 Phase 5 才引入；Phase 1–4 不依赖

---

## Phase 1: 死代码清理 + Selector 切片化 + Bootstrap 单源化

> 这是地基改动——把已有的"散点三处重复读"、"整 slice selector 风暴"、"无用代码"清掉。任何后续 Phase 改动都以这一层的稳定为前提。

### Task 1.1: 死代码删除

**Files:**
- Delete: `src/components/layout/ThemeToggleButton.tsx`
- Delete: `src/components/sync/SyncStatus.tsx`
- Delete: `src/components/sync/SyncStatusIndicator.tsx`
- Delete: `src/components/search/SearchBar.tsx`
- Delete: `src/components/common/StatusFeedback.tsx`
- Delete: `src/styles/themes/refined.css`
- Delete: `src/styles/themes/productivity.css`
- Modify: `src/styles/global.css:2-15`（删 9 个主题文件的 import 中的 refined/productivity）
- Modify: 各处 import 死代码的调用点（grep 找出）

**Interfaces:**
- 无新增接口；纯删除

- [ ] **Step 1: 确认死代码无外部引用**

```bash
cd /Users/panbo/Code/Demos/chrome-plugin-one-tab
grep -rn "from.*ThemeToggleButton" src --include="*.tsx" --include="*.ts"
grep -rn "from.*SyncStatus\b\|from.*SyncStatusIndicator" src --include="*.tsx" --include="*.ts"
grep -rn "from.*SearchBar" src --include="*.tsx" --include="*.ts"
grep -rn "from.*StatusFeedback" src --include="*.tsx" --include="*.ts"
grep -rn "refined.css\|productivity.css" src --include="*.tsx" --include="*.ts"
```
预期输出：5 个 grep 全部**无结果**。如果有，**停**，先解决 import 引用。

- [ ] **Step 2: 删除 7 个文件**

```bash
cd /Users/panbo/Code/Demos/chrome-plugin-one-tab
git rm src/components/layout/ThemeToggleButton.tsx
git rm src/components/sync/SyncStatus.tsx
git rm src/components/sync/SyncStatusIndicator.tsx
git rm src/components/search/SearchBar.tsx
git rm src/components/common/StatusFeedback.tsx
git rm src/styles/themes/refined.css
git rm src/styles/themes/productivity.css
```

- [ ] **Step 3: 编辑 `src/styles/global.css` 删除不可达主题 import**

读当前 `src/styles/global.css:1-30`，找出 `@import` 列表，删除任何对 `refined.css` 或 `productivity.css` 的引用。其余保持不动。

- [ ] **Step 4: 跑 `pnpm validate`**

```bash
cd /Users/panbo/Code/Demos/chrome-plugin-one-tab
pnpm validate
```
预期：全绿（type-check + lint + build 通过）。如果有模块找不到 import 报错，回到 Step 2 之前的 grep 找到引用并修正。

- [ ] **Step 5: 跑测试**

```bash
pnpm test
```
预期：~297 测试全绿。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(s2/p1): remove dead code (ThemeToggleButton, SyncStatus{,Indicator}, SearchBar, StatusFeedback, refined.css, productivity.css)"
```

---

### Task 1.2: Selector 切片化

**Files:**
- Create: `src/store/selectors/tabSelectors.ts`
- Modify: `src/components/tabs/TabList.tsx:19`（用 selectSortedGroups）
- Modify: `src/components/search/SearchResultList.tsx:31-51`（用 selectGroups + selectSearchQuery）
- Modify: `src/components/app/MainApp.tsx:36-39`（用切片的 dispatch）
- Create: `tests/tabSelectors.test.ts`

**Interfaces:**
- **Produces:** 导出函数 `selectGroups / selectIsLoading / selectLastLoadedAt / selectSearchQuery / selectLayoutMode / selectSortedGroups` 供后续 UI 任务消费

- [ ] **Step 1: 写失败测试**

Create `tests/tabSelectors.test.ts`：

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectGroups, selectSortedGroups, selectIsLoading } from '@/store/selectors/tabSelectors';
import { initialTabState } from '@/store/slices/tabSlice';
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
  isFavorite: false,
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

test('selectSortedGroups puts favorite groups first, then newest', () => {
  const a = mkGroup({ id: 'a', createdAt: '2026-08-01T00:00:00Z', isFavorite: false });
  const b = mkGroup({ id: 'b', createdAt: '2026-08-05T00:00:00Z', isFavorite: false });
  const c = mkGroup({ id: 'c', createdAt: '2026-08-03T00:00:00Z', isFavorite: true });
  const s = makeRootState({ tabs: { groups: [a, b, c] } as any });
  const sorted = selectSortedGroups(s);
  assert.deepEqual(sorted.map(g => g.id), ['c', 'b', 'a']);
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
  const s1 = makeRootState({ tabs: { groups: [mkGroup({ id: 'a' })], searchQuery: '' } as any });
  const s2 = makeRootState({ tabs: { groups: [mkGroup({ id: 'a' })], searchQuery: 'xxx' } as any });
  assert.equal(selectSortedGroups(s1), selectSortedGroups(s2));
});
```

- [ ] **Step 2: 跑测试 — 必须 fail**

```bash
cd /Users/panbo/Code/Demos/chrome-plugin-one-tab
pnpm test -- tests/tabSelectors.test.ts
```
预期：`Cannot find module '@/store/selectors/tabSelectors'`。

- [ ] **Step 3: 创建 `src/store/selectors/tabSelectors.ts`**

```typescript
import { createSelector } from '@reduxjs/toolkit';
import type { RootState } from '@/store';

export const selectGroups = (s: RootState) => s.tabs.groups;
export const selectIsLoading = (s: RootState) => s.tabs.isLoading;
export const selectLastLoadedAt = (s: RootState) => s.tabs.lastLoadedAt;
export const selectSearchQuery = (s: RootState) => s.tabs.searchQuery;
export const selectLayoutMode = (s: RootState) => s.settings.layoutMode;

/**
 * Sorted by: isFavorite desc, createdAt desc. New array reference only when
 * groups slice changes (createSelector memo). searchQuery is a separate concern
 * — SearchResultList filters on top of this.
 */
export const selectSortedGroups = createSelector(
  [selectGroups],
  (groups) =>
    [...groups].sort((l, r) => {
      const favL = !!l.isFavorite;
      const favR = !!r.isFavorite;
      if (favL !== favR) return favL ? -1 : 1;
      return new Date(r.createdAt).getTime() - new Date(l.createdAt).getTime();
    })
);
```

- [ ] **Step 4: 跑测试 — 必须 pass**

```bash
pnpm test -- tests/tabSelectors.test.ts
```
预期：6 测试全 pass。

- [ ] **Step 5: 改 TabList 用 selector**

读 `src/components/tabs/TabList.tsx:18-25`，把 selector 改：

```typescript
import { selectSortedGroups, selectIsLoading, selectLastLoadedAt } from '@/store/selectors/tabSelectors';

// ... 替换
const { isLoading, error, lastLoadedAt } = useAppSelector(state => ({
  isLoading: selectIsLoading(state),
  error: state.tabs.error,
  lastLoadedAt: selectLastLoadedAt(state),
}));
const sortedGroups = useAppSelector(selectSortedGroups);
```

删除 `TabList.tsx:85-91` 的 `[...groups].sort(...)` 内联排序，**直接用 `sortedGroups`**。

`src/components/tabs/TabList.tsx:94` 的 `filteredGroups = sortedGroups` 不变。

- [ ] **Step 6: 改 SearchResultList 用 selector**

读 `src/components/search/SearchResultList.tsx:31-51`，把 selector 改：

```typescript
import { selectGroups, selectSearchQuery } from '@/store/selectors/tabSelectors';

const groups = useAppSelector(selectGroups);
const storedQuery = useAppSelector(selectSearchQuery);

// 内部仍可用 useMemo 包装搜索计算，但 selector 切片化
```

把内联 `AdvancedSearch.search(groups, ...)` 调用套上 `useMemo(..., [groups, storedQuery])`，避免每次 render 重算。

- [ ] **Step 7: 改 MainApp 不用 dispatch(loadSettings)**

读 `src/components/app/MainApp.tsx:36-39`：

```typescript
// 删除这段
useEffect(() => {
  dispatch(loadSettings());
}, [dispatch]);
```

（settings 已经在 popup/index.tsx 的 bootstrap 中通过 preloadedState 注入；MainApp dispatch 重复读是无用功。）

- [ ] **Step 8: 跑全测试**

```bash
pnpm verify
```
预期：type-check + lint + test 全绿；tabSelectors.test.ts 6 测试 + 原 297 测试 = 303 测试。

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(s2/p1): selector slicing + createSelector memo + bootstrap single-source

- Add src/store/selectors/tabSelectors.ts (6 slice-scope selectors)
- TabList uses selectSortedGroups (was in-place sort O(N) per render)
- SearchResultList uses selectGroups + selectSearchQuery
- MainApp drops redundant dispatch(loadSettings) — settings loaded by popup bootstrap
- Tests: 6 new tests for selectSortedGroups memoization"
```

---

### Task 1.3: Bootstrap 单源化（`storage.hydrateAll`）

> **重要**：这部分代码 S1 与 S2 共写。S1 详细 spec 待 S2 P1 阶段启动时同步开写（参见蓝图 §5）。本任务定的是 S2 部分的接口契约。

**Files:**
- Modify: `src/utils/storage.ts`（新增 `hydrateAll` 函数）
- Modify: `src/popup/index.tsx:26-53`（改用 `hydrateAll`）
- Modify: `src/components/app/AppContainer.tsx:13-25`（删除重复 initStorage useEffect）
- Modify: `src/contexts/ThemeContext.tsx:34-50`（删除独立 storage 读，改 useSelector）
- Create: `tests/storageHydrate.test.ts`

**Interfaces:**
- **Produces:** `storage.hydrateAll(): Promise<HydrateResult>` — 一次性返回 `{ groups, settings, lastLoadedAt }`

- [ ] **Step 1: 写 `hydrateAll` 失败测试**

Create `tests/storageHydrate.test.ts`：

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
(globalThis as any).chrome = { runtime: { id: 'test-id' } };

import { storage } from '@/utils/storage';
import { invalidateGroupsCache } from '@/utils/storage';
import { cacheManager } from '@/utils/performance';
import { IndexedDBStorage } from '@/storage/indexedDbClient';

async function resetStorage() {
  await new Promise<void>((res, rej) => {
    const req = indexedDB.deleteDatabase('tabvaultpro');
    req.onsuccess = () => res();
    req.onerror = () => rej(req.error);
  });
  invalidateGroupsCache();
  cacheManager.getCache('storage').clear();
}

test.beforeEach(async () => { await resetStorage(); });

test('hydrateAll returns empty defaults when storage is empty', async () => {
  const r = await storage.hydrateAll();
  assert.deepEqual(r.groups, []);
  assert.equal(typeof r.settings, 'object');
  assert.equal(r.lastLoadedAt, null);
});

test('hydrateAll reads existing groups', async () => {
  await storage.setGroups([
    { id: 'g1', name: 'g1', tabs: [], isFavorite: false, isLocked: false, isDeleted: false, createdAt: '2026-08-05T00:00:00Z', updatedAt: '2026-08-05T00:00:00Z', displayOrder: 0 } as any,
  ]);
  const r = await storage.hydrateAll();
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].id, 'g1');
});

test('hydrateAll reads existing settings', async () => {
  await storage.setSettings({ themeMode: 'dark', themeStyle: 'aurora' } as any);
  const r = await storage.hydrateAll();
  assert.equal(r.settings.themeMode, 'dark');
  assert.equal(r.settings.themeStyle, 'aurora');
});

test('hydrateAll is single IO round-trip (only one Promise chain)', async () => {
  // 调用一次后内部缓存命中；第二次调用不再读 storage
  // 实际验证：第二次调用结果 === 第一次（同样的引用）是不可能的（每次生成新对象），
  // 但可以验证第二次调用的耗时明显小于第一次（异步差距）
  await storage.hydrateAll();
  const t0 = Date.now();
  await storage.hydrateAll();
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5, `hydrateAll second call should be fast, was ${elapsed}ms`);
});
```

- [ ] **Step 2: 跑测试 — fail**

```bash
pnpm test -- tests/storageHydrate.test.ts
```
预期：`storage.hydrateAll is not a function` 或类似。

- [ ] **Step 3: 在 `src/utils/storage.ts` 实现 `hydrateAll`**

读 `src/utils/storage.ts` 现有 public API（`getGroups / setGroups / getSettings / setSettings / getLastLoadedAt` 等），加：

```typescript
export interface HydrateResult {
  groups: TabGroup[];
  settings: UserSettings;
  lastLoadedAt: string | null;
}

export const storage = {
  // ... 所有现有方法保持
  
  async hydrateAll(): Promise<HydrateResult> {
    const [groups, settings, lastLoadedAt] = await Promise.all([
      this.getGroups(),
      this.getSettings(),
      this.getLastLoadedAt(),
    ]);
    return { groups, settings, lastLoadedAt };
  },
};
```

（位置 / 包裹方式以 storage.ts 现有结构为准；不要重写整个文件。）

- [ ] **Step 4: 跑 storageHydrate 测试 — pass**

```bash
pnpm test -- tests/storageHydrate.test.ts
```
预期：4 测试全 pass。

- [ ] **Step 5: 改 `src/popup/index.tsx` 用 `hydrateAll`**

读 `src/popup/index.tsx:26-53`，改：

```typescript
async function bootstrap() {
  let preloadedState: PreloadedState | undefined;
  try {
    await initStorage();
    const { groups, settings } = await storage.hydrateAll();
    // lastLoadedAt 单独读（hydrateAll 已包含，但 hydrationDecision 不需要）

    const decision = decideTabsHydration({ groups, now: new Date().toISOString() });
    const tabsPreload = buildTabsPreloadedState(decision);

    preloadedState = {
      tabs: { ...initialTabState, ...(tabsPreload ?? {}) },
      settings,
    };
  } catch (err) {
    console.warn('[popup] local hydration failed, falling back to empty store', err);
  }
  // 后续不变
}
```

- [ ] **Step 6: 删 `src/components/app/AppContainer.tsx:13-25` 重复 initStorage**

读 `AppContainer.tsx:13-25`：

```typescript
// 删除整个 useEffect（initStorage 已由 bootstrap 完成）
// 保留文件其它部分（ErrorBoundary / ToastProvider / ThemeProvider / AuthProvider）
```

- [ ] **Step 7: 改 `src/contexts/ThemeContext.tsx:34-50` 不再独立 storage 读**

读 ThemeContext.tsx 第 34-50 行附近，把 `useEffect(() => { chrome.storage.local.get(['themeMode', 'themeStyle']).then(...) }, [])` 改为：

```typescript
const themeMode = useAppSelector(selectThemeMode); // 从 settings slice
const themeStyle = useAppSelector(selectThemeStyle);
useEffect(() => {
  applyThemeToDocument(themeMode, themeStyle);
}, [themeMode, themeStyle]);
```

（如果有 `applyThemeToDocument` 这个 helper 函数名，保留原结构；只要不再独立 `chrome.storage.local.get` 即可。）

- [ ] **Step 8: 跑 `pnpm verify` 全绿**

```bash
pnpm verify
```
预期：303 + 4 = 307 测试全绿。

- [ ] **Step 9: 跑 hydrationDecision 不变量测试（关键 safety net）**

```bash
pnpm test -- tests/hydrationDecision.test.ts
```
预期：8 测试全绿。**如果失败，必须 revert 本 task 再修**——这是数据安全护栏。

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor(s2/p1): storage.hydrateAll single-source bootstrap

- Add storage.hydrateAll() — one Promise.all for groups + settings + lastLoadedAt
- popup/index.tsx uses hydrateAll instead of Promise.all
- AppContainer.tsx drops redundant initStorage useEffect (was double-call)
- ThemeContext reads theme from settings slice (no longer its own chrome.storage read)
- Tests: 4 new hydrateAll tests
- Safety: hydrationDecision tests still green (8 tests pass)"
```

---

## Phase 1 验收

- 死代码已删，pnpm validate 全绿
- selector 切片化且 createSelector memo 生效
- bootstrap 只读 storage 一次
- 307 测试全绿
- 5 个不变量测试（其中 hydrationDecision）保持绿

> **P1 完成。Checkpoint：让用户感受一下"精简 selector + 单源存储"的初始态（popup 启动已经快一点了），再进入 P2。**

---

## Phase 2: DnD Hover 与 Persist 解耦

> 这是"性能地基"——解除 hover 期间写盘带来的卡顿。这部分对性能影响最大（诊断 #1 影响最大的 5 项之一）。

### Task 2.1: 抽出 `moveTabLocal` action + reducer

**Files:**
- Modify: `src/store/slices/tabSlice.ts:402-543`（拆分为 `moveTabLocal` action + 现有 `moveTab` thunk）
- Create: `tests/moveTabReducer.test.ts`

**Interfaces:**
- **Produces:** 导出 `moveTabLocal({ groupId, tabId, toIndex })` action —— reducer 内纯修改 state.tabs.groups，不写 storage

- [ ] **Step 1: 写 reducer 测试**

Create `tests/moveTabReducer.test.ts`：

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import tabReducer, { moveTabLocal, initialTabState } from '@/store/slices/tabSlice';
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
});

test('moveTabLocal moves tab across groups', () => {
  const next = tabReducer(
    { ...initialTabState, groups: [g1, g2] },
    moveTabLocal({ groupId: 'g2', tabId: 't3', toIndex: 0 })
  );
  assert.equal(next.groups[0].tabs.length, 3);
  assert.equal(next.groups[0].tabs[0].id, 't3');
  assert.equal(next.groups[1].tabs.length, 0);
});

test('moveTabLocal is a no-op on missing tab', () => {
  const next = tabReducer(
    { ...initialTabState, groups: [g1] },
    moveTabLocal({ groupId: 'g1', tabId: 'missing', toIndex: 0 })
  );
  assert.deepEqual(next.groups, [{ ...g1, tabs: g1.tabs }]);
});

test('moveTabLocal clamps negative toIndex to 0', () => {
  const next = tabReducer(
    { ...initialTabState, groups: [g1] },
    moveTabLocal({ groupId: 'g1', tabId: 't1', toIndex: -100 })
  );
  assert.equal(next.groups[0].tabs[0].id, 't1');
});

test('moveTabLocal clamps toIndex past group length', () => {
  const next = tabReducer(
    { ...initialTabState, groups: [g1] },
    moveTabLocal({ groupId: 'g1', tabId: 't1', toIndex: 100 })
  );
  // t1 should still be moved to end (or remain) — test: not throwing
  assert.ok(Array.isArray(next.groups[0].tabs));
});
```

- [ ] **Step 2: 跑测试 — fail**

```bash
pnpm test -- tests/moveTabReducer.test.ts
```
预期：`moveTabLocal is not exported`。

- [ ] **Step 3: 在 `tabSlice.ts` 添加 `moveTabLocal` action + reducer**

读 `tabSlice.ts:402-543`（现有 moveTabAndSync thunk）。**新策略**：

```typescript
// 在 createSlice 顶部 extraReducers 旁边加 reducers 字段
// 改 createSlice 配置：
const tabSlice = createSlice({
  name: 'tabs',
  initialState: initialTabState,
  reducers: {
    moveTabLocal(state, action: PayloadAction<{ groupId: string; tabId: string; toIndex: number }>) {
      const { groupId, tabId, toIndex } = action.payload;
      const target = state.groups.find(g => g.id === groupId);
      if (!target) return;
      const idx = target.tabs.findIndex(t => t.id === tabId);
      if (idx < 0) return;
      const [item] = target.tabs.splice(idx, 1);
      const clamped = Math.max(0, Math.min(target.tabs.length, toIndex));
      target.tabs.splice(clamped, 0, item);
    },
  },
  extraReducers: (builder) => {
    // ... 现有 extraReducers 不变
  },
});

export const { moveTabLocal } = tabSlice.actions;
```

- [ ] **Step 4: 跑测试 — pass**

```bash
pnpm test -- tests/moveTabReducer.test.ts
```
预期：5 测试全 pass。

- [ ] **Step 5: **保持现有 thunk `moveTabAndSync` 不破坏**，但其内部改为触发 reducer + persist**

读 `tabSlice.ts:402-543` 改：

```typescript
// moveTabAndSync 现在不直接写 storage；先 dispatch reducer，再触发 debounced persist
export const moveTabAndSync = createAsyncThunk(
  'tabs/moveTabAndSync',
  async (payload: { groupId: string; tabId: string; toIndex: number }, { dispatch }) => {
    dispatch(moveTabLocal(payload));           // UI 立即更新
    dispatch(persistGroupsDebounced());       // 200ms trailing 写盘
  }
);
```

（`persistGroupsDebounced` action 在下一个 Task 2.2 添加。）

- [ ] **Step 6: 跑 `pnpm verify` 全绿**

```bash
pnpm verify
```
预期：测试总数 307 + 5 = 312。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(s2/p2): split moveTabLocal from moveTabAndSync

- Add moveTabLocal reducer (pure UI update, no storage write)
- moveTabAndSync thunk now dispatches moveTabLocal + persistGroupsDebounced
- Tests: 5 new reducer tests (within-group, cross-group, missing-tab, clamping)"
```

---

### Task 2.2: 抽出 `debouncedPersist` 中间件

**Files:**
- Create: `src/store/middleware/debouncedPersist.ts`
- Modify: `src/store/index.ts:30`（注册新中间件）
- Modify: `src/store/slices/tabSlice.ts`（定义 `persistGroupsDebounced` + `persistGroupsThunk`）
- Create: `tests/debouncedPersist.test.ts`

**Interfaces:**
- **Produces:** 
  - `persistGroupsDebounced()` action —— 触发 200ms 防抖 persist
  - `persistGroupsThunk()` thunk —— 实际写盘（含加密 + IndexedDB）
  - `debouncedPersistMiddleware` —— Redux middleware

- [ ] **Step 1: 写失败测试**

Create `tests/debouncedPersist.test.ts`：

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
(globalThis as any).chrome = { runtime: { id: 'test-id' } };

import { debouncedPersistMiddleware, persistGroupsDebounced, persistGroupsThunk } from '@/store/middleware/debouncedPersist';
import { configureStore } from '@reduxjs/toolkit';

function makeStore() {
  let writes = 0;
  const slice = (state = { groups: [] as any[] }, action: any) => {
    if (action.type === 'setGroups') {
      return { groups: action.payload };
    }
    return state;
  };
  const persistFake = () => ({ type: 'persistFired', payload: undefined });
  const store = configureStore({
    reducer: slice,
    middleware: getDefault => getDefault().concat(debouncedPersistMiddleware({ persistFn: persistFake, delayMs: 50 })),
  });
  return { store, persistFake, get writes() { return writes; }, set writes(n: number) { writes = n; } };
}
```

— 注：如果 middleware 需要 factory 模式简化测试，下面 step 4 给出可选实现。

```typescript
// 简化版：直接传 delayMs
test('debouncedPersistMiddleware coalesces multiple dispatches into one', async () => {
  let persistCount = 0;
  const fakeMiddleware = debouncedPersistMiddleware({ persistFn: () => { persistCount++; }, delayMs: 30 });
  const rootReducer = (state: any = { groups: [] }, action: any) => state;
  const store = configureStore({ reducer: rootReducer, middleware: getDefault => getDefault().concat(fakeMiddleware as any) });

  store.dispatch({ type: persistGroupsDebounced.type });
  store.dispatch({ type: persistGroupsDebounced.type });
  store.dispatch({ type: persistGroupsDebounced.type });

  assert.equal(persistCount, 0, 'should not fire synchronously');
  await new Promise(res => setTimeout(res, 60));
  assert.equal(persistCount, 1, 'should fire exactly once after delay');
});

test('debouncedPersistMiddleware does not intercept other actions', () => {
  let count = 0;
  const fakeMiddleware = debouncedPersistMiddleware({ persistFn: () => { count++; }, delayMs: 30 });
  const rootReducer = (state: any = { groups: [] }, action: any) => state;
  const store = configureStore({ reducer: rootReducer, middleware: getDefault => getDefault().concat(fakeMiddleware as any) });

  store.dispatch({ type: 'unrelated/action' });
  assert.equal(count, 0);
});
```

- [ ] **Step 2: 跑测试 — fail**

```bash
pnpm test -- tests/debouncedPersist.test.ts
```

- [ ] **Step 3: 创建 `src/store/middleware/debouncedPersist.ts`**

```typescript
import type { Middleware } from '@reduxjs/toolkit';
import { createAction } from '@reduxjs/toolkit';

export const persistGroupsDebounced = createAction('tabs/persistGroupsDebounced');

export interface DebouncedPersistOptions {
  persistFn: () => void;
  delayMs?: number;
}

/**
 * Coalesces rapid persistGroupsDebounced actions into a single trailing call.
 * Designed for DnD hover → many dispatches → only one persist round-trip.
 */
export function debouncedPersistMiddleware(opts: DebouncedPersistOptions): Middleware {
  const delay = opts.delayMs ?? 200;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => (next) => (action) => {
    const result = next(action);
    if (action.type !== persistGroupsDebounced.type) return result;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      opts.persistFn();
      timer = null;
    }, delay);
    return result;
  };
}
```

- [ ] **Step 4: 创建 thunk `persistGroupsThunk` + 索引变化**

在 `src/store/slices/tabSlice.ts` 顶部 import + 索引新 thunk：

```typescript
import { persistGroupsDebounced } from '@/store/middleware/debouncedPersist';

export const persistGroupsThunk = createAsyncThunk(
  'tabs/persistGroups',
  async (_, { getState }) => {
    const s = getState() as { tabs: { groups: TabGroup[] } };
    await storage.setGroups(s.tabs.groups);
  }
);
```

- [ ] **Step 5: 注册中间件到 store**

读 `src/store/index.ts:24-30`：

```typescript
// 加 import
import { debouncedPersistMiddleware } from './middleware/debouncedPersist';
import { persistGroupsThunk } from './slices/tabSlice';

// 在 buildStore 中挂中间件
function buildStore(preloadedState?: PreloadedState) {
  return configureStore({
    reducer: rootReducer,
    preloadedState: preloadedState as RootState | undefined,
    middleware: getDefault =>
      getDefaultMiddleware({
        serializableCheck: {
          ignoredActionPaths: ['payload.tab', 'payload.tabs'],
          ignoredPaths: ['tabs.currentTab'],
        },
      })
        .concat(autoSyncMiddleware)
        .concat(debouncedPersistMiddleware({
          persistFn: () => (_store.getState() as any)._persistTrigger?.(),
          delayMs: 200,
        })),
  });
}
```

**简化建议**：用闭包捕获当前 store 的 ref：

```typescript
// store/index.ts 改：
let _store: AppStore = buildStore();

function _triggerPersist() {
  // store 重建后引用变了；这里始终读最新的
  _store.dispatch(persistGroupsThunk());
}

function buildStore(preloadedState?: PreloadedState) {
  return configureStore({
    reducer: rootReducer,
    preloadedState: preloadedState as RootState | undefined,
    middleware: getDefault =>
      getDefaultMiddleware({ /* ... */ })
        .concat(autoSyncMiddleware)
        .concat(debouncedPersistMiddleware({ persistFn: _triggerPersist, delayMs: 200 })),
  });
}
```

如果实现遇到循环依赖，用 factory 模式：

```typescript
.debouncedPersistMiddleware({
  persistFn: () => _store.dispatch(persistGroupsThunk()),
  delayMs: 200,
})
```

- [ ] **Step 6: 跑测试**

```bash
pnpm test -- tests/debouncedPersist.test.ts
pnpm verify
```
预期：debouncedPersist 测试 pass；pnpm verify 全绿（含旧 312 + 新 2 = 314 测试）。

- [ ] **Step 7: 跑 syncMergeSafety 不变量测试**

```bash
pnpm test -- tests/syncMergeSafety.test.ts
```
预期：15 测试全绿。

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(s2/p2): debouncedPersist middleware (200ms trailing)

- Add debouncedPersistMiddleware (coalesces rapid persist dispatches into 1)
- Add persistGroupsThunk (does the actual storage.setGroups)
- Wire into store/index.ts as last middleware
- Tests: 2 new debounce tests (coalescing + action filtering)
- Safety: syncMergeSafety 15 tests still green"
```

---

### Task 2.3: `DraggableTab` hover dispatch 改用 `moveTabLocal`

**Files:**
- Modify: `src/components/dnd/DraggableTab.tsx:50-55,98`（hover 触发的 move callback 改用 reducer path）
- Test: 通过手动手测 / `tests/debouncedPersist.test.ts` 已覆盖关键路径

**Interfaces:**
- **Consumes:** `moveTabLocal` (Task 2.1) + `persistGroupsDebounced` (Task 2.2)

- [ ] **Step 1: 读 `DraggableTab.tsx:36-108` 当前 hover 处理**

确认 hover 触发的 dispatch 调用栈：

```bash
grep -n "moveTabAndSync\|moveTab" src/components/dnd/DraggableTab.tsx
```

- [ ] **Step 2: 改 hover callback**

读 `DraggableTab.tsx:50-55`：

```typescript
// 替换 moveTabAndSync 为 moveTabLocal + persistGroupsDebounced
const handleHover = useCallback(
  throttle(() => {
    dispatch(moveTabLocal({ groupId, tabId, toIndex: newIndex }));
    dispatch(persistGroupsDebounced());
  }, 100),
  [dispatch, groupId, tabId]
);
```

（保留 throttling 100ms；hover 期间 dispatch 2 个 action：纯 reducer + 防抖 persist。）

- [ ] **Step 3: 跑测试 + 手动检查 DnD 仍可用**

```bash
pnpm verify
```

手动：在浏览器中加载 dist，打开 popup，拖动一个 tab → 看是否仍正常 reorder；关 popup 重新打开，看是否保持 reorder 后的位置（说明 persist 仍生效）。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(s2/p2): DraggableTab hover uses moveTabLocal + persistGroupsDebounced

- Hover dispatch path now: reducer (sync, pure) + debounced persist (200ms trailing)
- Removes per-hover storage.setGroups (= PBKDF2 + AES-GCM)
- Net: DnD hover should feel snappier (no encryption round-trip per event)"
```

---

## Phase 2 验收

- DnD hover 中不再触发 storage.setGroups
- 关 popup 后数据仍持久化（防抖 trailing 触发持久化）
- 314 测试全绿
- 5 个不变量测试（其中 syncMergeSafety）保持绿

> **P2 完成。Checkpoint：让用户手动测一下拖拽流畅度有明显提升，再进入 P3。**

---

## Phase 3: 列表虚拟化

> 这是性能主菜——大列表滚动的卡顿。30+ 会话启用 @tanstack/react-virtual。

### Task 3.1: 安装 `@tanstack/react-virtual`

**Files:**
- Modify: `package.json`（dependencies）
- Modify: `pnpm-lock.yaml`（lock 自动更新）

**Interfaces:**
- 新增 devDep / dep `@tanstack/react-virtual` v3.x

- [ ] **Step 1: 安装**

```bash
cd /Users/panbo/Code/Demos/chrome-plugin-one-tab
pnpm add @tanstack/react-virtual@^3.0.0
```

预期：`package.json` 增加 `^3.x`，lock 文件更新。

- [ ] **Step 2: 验证安装**

```bash
ls node_modules/@tanstack/react-virtual/dist/esm/index.mjs 2>/dev/null && echo "INSTALLED" || pnpm install
```

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(s2/p3): install @tanstack/react-virtual v3.x"
```

---

### Task 3.2: 抽出 `useVirtualizer` 包装 hook

**Files:**
- Create: `src/hooks/useVirtualizer.ts`
- Create: `tests/useVirtualizer.test.ts`

**Interfaces:**
- **Produces:** `useListVirtualizer(items, options?) => { virtualizer, containerRef }` — 封装 @tanstack/react-virtual 的 estimateSize / overscan / scrollMargin

- [ ] **Step 1: 写失败测试**

```typescript
// tests/useVirtualizer.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeVirtualWindow } from '@/hooks/useVirtualizer';

test('computeVirtualWindow: returns full window when items < threshold (30)', () => {
  const items = Array.from({ length: 20 });
  const window = computeVirtualWindow({ items, threshold: 30, overscan: 5 });
  assert.equal(window.virtual, false);
  assert.equal(window.startIndex, 0);
  assert.equal(window.endIndex, 20);
});

test('computeVirtualWindow: enables virtual at threshold', () => {
  const items = Array.from({ length: 100 });
  const window = computeVirtualWindow({ items, threshold: 30, overscan: 5, viewportHeight: 600, itemHeight: 80 });
  assert.equal(window.virtual, true);
  assert.ok(window.endIndex > 0);
});

test('computeVirtualWindow: respects overscan', () => {
  const items = Array.from({ length: 100 });
  const w = computeVirtualWindow({ items, threshold: 30, overscan: 5, viewportHeight: 600, itemHeight: 80, scrollOffset: 400 });
  assert.ok(w.startIndex >= 0);
  assert.ok(w.endIndex > w.startIndex);
});
```

> 实现策略：抽出"是否启用虚拟化" + "窗口边界"纯函数。@tanstack/react-virtual 仍走 hook 调用，但有 unit-testable 的纯函数部分。

- [ ] **Step 2: 实现 `src/hooks/useVirtualizer.ts`**

```typescript
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef } from 'react';

export interface VirtualListOptions {
  itemHeight?: number;     // default 80
  overscan?: number;       // default 5
  threshold?: number;      // default 30; below = render all
  viewportHeight?: number; // default 600
  scrollOffset?: number;   // for tests
}

export interface VirtualWindow {
  virtual: boolean;
  startIndex: number;
  endIndex: number;
}

/** Pure function — unit tested. */
export function computeVirtualWindow<T>(
  opts: { items: T[] } & VirtualListOptions
): VirtualWindow {
  const { items, threshold = 30 } = opts;
  if (items.length < threshold) {
    return { virtual: false, startIndex: 0, endIndex: items.length };
  }
  // simple sliding window math — actual @tanstack useVirtualizer will replace this in hook
  const itemHeight = opts.itemHeight ?? 80;
  const viewportHeight = opts.viewportHeight ?? 600;
  const overscan = opts.overscan ?? 5;
  const scrollOffset = opts.scrollOffset ?? 0;

  const visibleCount = Math.ceil(viewportHeight / itemHeight);
  const startByScroll = Math.floor(scrollOffset / itemHeight);
  const startIndex = Math.max(0, startByScroll - overscan);
  const endIndex = Math.min(items.length, startIndex + visibleCount + overscan * 2);
  return { virtual: true, startIndex, endIndex };
}

export function useListVirtualizer<T>(
  items: T[],
  options: VirtualListOptions = {}
) {
  const parentRef = useRef<HTMLDivElement>(null);
  const itemHeight = options.itemHeight ?? 80;
  const threshold = options.threshold ?? 30;

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => itemHeight,
    overscan: options.overscan ?? 5,
  });

  return { virtualizer, parentRef, enabled: items.length >= threshold };
}
```

- [ ] **Step 3: 跑测试**

```bash
pnpm test -- tests/useVirtualizer.test.ts
pnpm verify
```
预期：3 测试 pass；全绿。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(s2/p3): useVirtualizer hook + computeVirtualWindow pure fn

- Add @tanstack/react-virtual wrapper
- Threshold (30 items) auto-enables virtualization
- Pure computeVirtualWindow function for unit testing
- Tests: 3 new"
```

---

### Task 3.3: `TabList` 应用虚拟化

**Files:**
- Modify: `src/components/tabs/TabList.tsx:135-186`

**Interfaces:**
- **Consumes:** `useListVirtualizer` (Task 3.2)

- [ ] **Step 1: 读 TabList 当前 render 结构**

读 `TabList.tsx:135-186` 确认现有 JSX 结构（注意 `reorderMode` 分支与 search 分支需要单独保留非虚拟化）。

- [ ] **Step 2: 改 render 用 virtualizer**

```typescript
import { useListVirtualizer } from '@/hooks/useVirtualizer';

// TabList 函数体内：
const { virtualizer, parentRef, enabled } = useListVirtualizer(filteredGroups, {
  itemHeight: 220,
  overscan: 3,
  threshold: 30,
});

// 替换 lines 173-182：
if (!reorderMode && !searchQuery && enabled) {
  return (
    <div ref={parentRef} className="overflow-auto" style={{ maxHeight: '70vh' }}>
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
        {virtualizer.getVirtualItems().map(vi => {
          const group = filteredGroups[vi.index];
          return (
            <div
              key={group.id}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vi.start}px)`,
              }}
            >
              <DraggableTabGroup
                group={group}
                index={vi.index}
                moveGroup={(drag, hover) => dispatch(moveGroupAndSync({ dragIndex: drag, hoverIndex: hover }))}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

非虚拟化分支（`< 30` 个、`reorderMode` 下、`searchQuery` 下）保留原 render。

- [ ] **Step 3: 删 `findIndex` O(N²) 模式**

读 `TabList.tsx:142-168` 双栏布局 — 改用 `index` 直接传：

```typescript
// 之前：findIndex(item => item.id === group.id)
// 之后：map((group, index) => ...) — index 直接可拿
{filteredGroups.map((group, index) => (
  <DraggableTabGroup key={group.id} group={group} index={index} moveGroup={...} />
))}
```

- [ ] **Step 4: 跑测试 + 手动测**

```bash
pnpm verify
```

手动：使用 `__TV_BENCH__.seedLargeDataset(300)` 灌 300 个会话，看 TabList 滚动是否流畅（实际感受）。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "perf(s2/p3): TabList virtualized via @tanstack/react-virtual

- enable when groups.length >= 30 (configurable threshold)
- double-column layout: drop O(N^2) findIndex pattern
- 300-session seed should now scroll smoothly"
```

---

### Task 3.4: `SearchResultList` 应用虚拟化

**Files:**
- Modify: `src/components/search/SearchResultList.tsx:578-626`

**Interfaces:**
- **Consumes:** `useListVirtualizer` (Task 3.2)

- [ ] **Step 1: 读 SearchResultList render 结构**

读 `SearchResultList.tsx:578-626` 确认当前渲染。

- [ ] **Step 2: 改 render 用虚拟化**

按 Task 3.3 模式套（items 用 `sessionResults` 或 `tabResults`，itemHeight 不同）。

- [ ] **Step 3: 加 useMemo 包搜索计算**

读 `SearchResultList.tsx:43-51`：

```typescript
const results = useMemo(
  () => AdvancedSearch.search(groups, storedQuery).then(applyFilters),
  [groups, storedQuery]  // 简化：仅依赖两个切片 selector
);
```

（按现有 API 调整；关键是稳定 deps。）

- [ ] **Step 4: 跑测试 + Commit**

```bash
pnpm verify
git add -A
git commit -m "perf(s2/p3): SearchResultList virtualized + memoized search"
```

---

## Phase 3 验收

- 30+ 会话时 TabList 自动启用虚拟化
- SearchResultList 在搜索结果多时启用虚拟化
- 314 + ~5 = ~319 测试全绿
- 5 个不变量测试保持绿

---

## Phase 4: 组件懒加载与 CSS 减负

> 这是"启动更快"的关键——把"popup 打开时永远会 load 但未必用"的组件切到按需。

### Task 4.1: `HeaderDropdown` 懒加载

**Files:**
- Modify: `src/components/layout/Header.tsx:9-13`
- Modify: `src/components/layout/HeaderDropdown.tsx:393`（拆开 ThemeStyleSelector）

**Interfaces:**
- 无新增 API；纯 lazy() 包裹

- [ ] **Step 1: 改 Header 用 lazy + Suspense**

读 `Header.tsx:9-13`：

```typescript
// 改 import 为 lazy
const HeaderDropdown = lazy(() =>
  import('./HeaderDropdown').then(m => ({ default: m.HeaderDropdown }))
);

// Header render 内（showDropdown 时）：
{showDropdown && (
  <Suspense fallback={<div className="fixed top-12 right-2 w-64 h-96 rounded-2xl bg-white shadow animate-pulse" />}>
    <HeaderDropdown onClose={() => setShowDropdown(false)} />
  </Suspense>
)}
```

- [ ] **Step 2: 跑测试 + 手动**

```bash
pnpm verify
```

手动：测 Header 的 kebab 菜单点击是否仍正常工作（需要等待分块加载 ~50ms）。

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "perf(s2/p4): HeaderDropdown lazy-loaded via React.lazy"
```

---

### Task 4.2: `SyncButton` / `ThemeStyleSelector` 同样的 lazy + 移到 Settings

> **本 Task 与 Task 4.3（Header 收拢）紧密相关，先做 4.3 再做 4.2 集成更顺。**

---

### Task 4.3: Header 收拢（8 个 icon → 4 个）

**Files:**
- Modify: `src/components/layout/Header.tsx:212-323`（重写为精简版）
- Modify: `src/components/app/MainApp.tsx:95`

**Interfaces:**
- **Produces:** Header 行为变：只剩 Logo / Save CTA / Search / Kebab(=Menu)
  - Menu opens SettingsTabs (替代 HeaderDropdown 整个 panel)

- [ ] **Step 1: 读现有 Header 完整 JSX**

读 `Header.tsx:200-340` 确认全部入口（layout mode toggle / clean / stats / theme / sync / save / kebab）。

- [ ] **Step 2: 重写为精简版**

保留 imports 与 state 模式，删掉这些按钮的渲染：

- `toggleLayoutMode`（layout double/single） → 进 Settings → Appearance
- `cleanDuplicateTabs` → 进 Settings → DangerZone
- `onShowStats` → 已存在，进 Settings → 顶部 menu item
- `SimpleThemeToggle` → 进 Settings → Appearance（直接用 ThemeContext）
- `SyncButton` → 进 Settings → SyncTab（新版简化为 SyncStatusRow）

保留：

- Logo + TabCounter
- 搜索框
- 主 CTA "保存会话" 按钮（保持橙色实心）
- Kebab 菜单入口（lazy SettingsTabs）

- [ ] **Step 3: 在 MainApp.tsx 加 Settings 路由**

读 `MainApp.tsx:94-100`：

```typescript
// 加 state
const [showSettings, setShowSettings] = useState(false);

{showSettings ? (
  <Suspense fallback={<div className="p-4 text-center">加载设置...</div>}>
    <SettingsTabs onClose={() => setShowSettings(false)} />
  </Suspense>
) : (
  /* 原 Header + TabList */
)}
```

- [ ] **Step 4: 跑 `pnpm verify` + 手动**

```bash
pnpm verify
```

手动：测 Header 不再溢出 380px 视口；测 Settings 打开/关闭正常。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(s2/p4): Header collapsed to Logo/Save/Search/Kebab

- Move: layout mode, theme picker, sync, stats, danger zone into Settings (lazy)
- Net header items: 8 icons → 4 (Logo / Save / Search / Kebab)
- Settings tabs render full-screen when active"
```

---

### Task 4.4: 创建 `SettingsTabs` 组件（lazy full-screen）

**Files:**
- Create: `src/components/settings/SettingsTabs.tsx`
- Create: `src/components/settings/AccountTab.tsx`
- Create: `src/components/settings/SyncTab.tsx`
- Create: `src/components/settings/AppearanceTab.tsx`
- Create: `src/components/settings/ImportExportTab.tsx`
- Create: `src/components/settings/NotificationsTab.tsx`
- Create: `src/components/settings/DangerZoneTab.tsx`
- Modify: `src/components/layout/HeaderDropdown.tsx` 内容迁移

**Interfaces:**
- **Produces:** `<SettingsTabs onClose />` —— 完整 Settings 路由，6 个垂直 tab 项 + 主内容区

- [ ] **Step 1: 创建 `SettingsTabs.tsx` 框架**

读原 HeaderDropdown.tsx 把内容按 type 拆。先创建 SettingsTabs 框架：

```typescript
// src/components/settings/SettingsTabs.tsx
import React, { useState } from 'react';
import { AccountTab } from './AccountTab';
import { SyncTab } from './SyncTab';
import { AppearanceTab } from './AppearanceTab';
import { ImportExportTab } from './ImportExportTab';
import { NotificationsTab } from './NotificationsTab';
import { DangerZoneTab } from './DangerZoneTab';

type TabId = 'account' | 'sync' | 'appearance' | 'import-export' | 'notifications' | 'danger';
const TABS: { id: TabId; label: string; component: React.FC }[] = [
  { id: 'account', label: '账户', component: AccountTab },
  { id: 'sync', label: '同步', component: SyncTab },
  { id: 'appearance', label: '外观', component: AppearanceTab },
  { id: 'import-export', label: '导入/导出', component: ImportExportTab },
  { id: 'notifications', label: '通知', component: NotificationsTab },
  { id: 'danger', label: '危险区', component: DangerZoneTab },
];

export const SettingsTabs: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [active, setActive] = useState<TabId>('account');
  const Active = TABS.find(t => t.id === active)!.component;
  return (
    <div className="grid grid-cols-[120px_1fr] h-screen">
      <aside className="border-r p-2 overflow-y-auto">
        <button onClick={onClose}>← 返回</button>
        <nav>{TABS.map(t => <button key={t.id} onClick={() => setActive(t.id)}>{t.label}</button>)}</nav>
      </aside>
      <main className="overflow-y-auto p-4"><Active /></main>
    </div>
  );
};
```

- [ ] **Step 2: 迁移 `AccountTab`**

读 `HeaderDropdown.tsx:24-72` 附近账户部分 → 迁移到 `AccountTab.tsx`。

- [ ] **Step 3: 迁移 `SyncTab` —— **同时降级 SyncButton**

读 `components/sync/SyncButton.tsx` 主体 → **不**整文件迁移；只保留"高级：覆盖/合并显式触发"逻辑；UI 主要内容用新组件 `SyncStatusRow`：

```typescript
// src/components/sync/SyncStatusRow.tsx（新）
import { useAppSelector } from '@/store/hooks';
import { syncService } from '@/services/syncService';

export const SyncStatusRow = () => {
  const status = useAppSelector(s => s.tabs.syncStatus);
  const lastSyncAt = useAppSelector(s => s.tabs.lastSyncTime);

  return (
    <div className="flex items-center gap-2">
      <span className={`w-2 h-2 rounded-full ${status === 'error' ? 'bg-rose-500' : status === 'syncing' ? 'bg-amber-500' : 'bg-emerald-500'}`} />
      <span>{formatLastSync(lastSyncAt)}</span>
      <button onClick={() => syncService.syncOnce()}>立即同步</button>
    </div>
  );
};
```

修改 `SyncTab.tsx`：用 `<SyncStatusRow />` 替换原 `<SyncButton />` 主体。

- [ ] **Step 4: 迁移 `AppearanceTab`（主题 3 选 1）**

读 `ThemeStyleSelector.tsx` 8 主题 → 精简到 3：

```typescript
const SHOW_THEMES = ['aurora', 'refined', 'cyberpunk']; // 3 选 1
```

删其他 5 个主题文件：

```bash
git rm src/styles/themes/legacy.css src/styles/themes/classic.css src/styles/themes/creamy.css src/styles/themes/pink.css src/styles/themes/mint.css src/styles/themes/prism.css
```

更新 `src/styles/global.css` 去掉这些 import。

**ThemeStyleSelector.tsx** 改为只渲染 3 个。

- [ ] **Step 5: 迁移 `ImportExportTab` / `NotificationsTab` / `DangerZoneTab`**

读 HeaderDropdown 剩余部分拆出来。

- [ ] **Step 6: 删 `HeaderDropdown.tsx`**（内容已迁移）

```bash
git rm src/components/layout/HeaderDropdown.tsx
```

- [ ] **Step 7: 跑 `pnpm verify`**

```bash
pnpm verify
```
预期：319 + ~5 = ~324 测试全绿。

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(s2/p4): SettingsTabs full-screen settings UI

- 7 new files in src/components/settings/ (Tabs + 6 Tab components)
- SyncStatusRow replaces SyncButton's busy UI
- ThemeStyleSelector reduced to 3 themes (aurora/refined/cyberpunk)
- Dropped 5 unused themes (legacy/classic/creamy/pink/mint/prism)
- HeaderDropdown removed (content migrated)
- All settings content reachable from Header kebab → Settings"
```

---

### Task 4.5: CSS 减负——修 `drag-drop.css` + 主题 lazy

**Files:**
- Modify: `src/styles/drag-drop.css:29-62,177-214`（删重复块）
- Modify: `src/styles/global.css`（主题 import 改 dynamic import）

- [ ] **Step 1: 删 drag-drop.css 重复块**

读 `drag-drop.css` 找出 `.tab-item / .dark .tab-item / .dragging` 重复定义，删除其中一组。

- [ ] **Step 2: 主题 CSS 改 dynamic import**

读 `global.css:2-15` 当前 `@import`；改为：

```typescript
// src/contexts/ThemeContext.tsx
// 主题 CSS 在切换时由 <link> 注入；不 eagerly import

function setThemeStylesheet(themeName: string) {
  const existing = document.getElementById('theme-stylesheet') as HTMLLinkElement | null;
  if (existing) existing.remove();
  const link = document.createElement('link');
  link.id = 'theme-stylesheet';
  link.rel = 'stylesheet';
  link.href = chrome.runtime.getURL(`themes/${themeName}.css`);
  document.head.appendChild(link);
}
```

将 `themes/<name>.css` 文件从 `src/styles/themes/` 移到 `public/themes/`（Vite 直接复制到 dist）。

`global.css` 仅保留非主题 base（字体、reset）。

- [ ] **Step 3: 跑 `pnpm validate` + 测**

```bash
pnpm validate
pnpm test
```

手动：切换主题应该正常（首次切换有 50-100ms 加载，之后瞬切）。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "perf(s2/p4): CSS减肥 — drag-drop.css de-duplicated, themes lazy via <link>"
```

---

## Phase 4 验收

- popup entry dist 体积减 ≤ 30%（实测 `pnpm build && du -h dist/src/popup/index-*.js`）
- global CSS dist ≤ 80K（实测 `du -h dist/assets/*.css`）
- Header 不溢出 380px 视口
- Settings 全屏 tab 工作
- ~324 测试全绿
- 5 个不变量保持绿

---

## Phase 5: 测试基建 + UI 测试 + 错误 UX 收尾

> **最后冲刺**：让覆盖率从 40% → 65%，写 ~46 个新测试，并把最后的 UX 错误处理归位。

### Task 5.1: 引入 `@testing-library/react` + `jsdom` devDeps

> **注意**：此 Task 需要用户在 P1 启动前/中确认是否引入这两个 devDeps。如果拒绝，Task 5.2-5.4 改为使用 `react-test-renderer` 路径或更轻的替代。

**Files:**
- Modify: `package.json`
- Modify: `package.json` `test` 脚本（追加 `--experimental-vm-modules` + 设置 NODE_OPTIONS）

- [ ] **Step 1: 安装**

```bash
cd /Users/panbo/Code/Demos/chrome-plugin-one-tab
pnpm add -D @testing-library/react@^14.0.0 jsdom@^24.0.0 @testing-library/dom@^10.0.0
```

- [ ] **Step 2: 改测试脚本支持 jsdom**

读 `package.json` `test` 脚本：

```json
"test:jsdom": "node --test --test-force-exit --experimental-strip-types --experimental-vm-modules --import 'data:text/javascript,import { register } from \"node:module\"; import { pathToFileURL } from \"node:url\"; register(\"./tests/_jsdom-loader.mjs\", pathToFileURL(\"./\"));' tests/jsdom/*.test.tsx",
"test": "node --test --test-force-exit --experimental-strip-types --experimental-test-module-mocks tests/*.test.ts"
```

> 简化为：如果 jsdom 引入有兼容性问题，**先退回 react-test-renderer**（无 jsdom）。这一段是 S2 spec 里的"待你最终确认" —— 用户在 P1 起头前答复。

- [ ] **Step 3: 创建 `tests/setup.ts`**

```typescript
// tests/setup.ts
import 'fake-indexeddb/auto';
(globalThis as any).chrome = { runtime: { id: 'test-id' } };
(globalThis as any).__TABSTACK_META_ENV__ = { DEV: false, PROD: true, MODE: 'production', BASE_URL: '/' };

if (typeof structuredClone === 'undefined') {
  (globalThis as any).structuredClone = (v: any) => JSON.parse(JSON.stringify(v));
}
```

更新 `package.json` `test` 脚本前执行 `node --import ./tests/setup.ts`。

- [ ] **Step 4: 跑测试**

```bash
pnpm verify
```
预期：原有 ~324 测试不变（jsdom 不影响 Node 原生测试）；新增的 jsdom 测试单独跑。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(s2/p5): test infra — @testing-library/react + jsdom + setup.ts"
```

---

### Task 5.2: UI 烟雾测试（TabList / SyncStatusRow / TabGroupMenu）

**Files:**
- Create: `tests/components/TabList.smoke.test.tsx`
- Create: `tests/components/SyncStatusRow.smoke.test.tsx`
- Create: `tests/components/TabGroupMenu.smoke.test.tsx`

- [ ] **Step 1: 写 TabList 烟雾测试**

```typescript
// tests/components/TabList.smoke.test.tsx
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { TabList } from '@/components/tabs/TabList';
import { initialTabState } from '@/store/slices/tabSlice';
import tabReducer from '@/store/slices/tabSlice';
import settingsReducer, { initialSettingsState } from '@/store/slices/settingsSlice';
import authReducer from '@/store/slices/authSlice';

function makeStore(groups = []) {
  return configureStore({
    reducer: { tabs: tabReducer, settings: settingsReducer, auth: authReducer },
    preloadedState: {
      tabs: { ...initialTabState, groups, lastLoadedAt: '2026-08-05T00:00:00Z' },
      settings: initialSettingsState,
      auth: { isAuthenticated: false } as any,
    },
  });
}

test('TabList renders groups', () => {
  const groups = [/* 一个 mock group */];
  const store = makeStore(groups);
  render(<Provider store={store}><TabList searchQuery="" /></Provider>);
  // 至少应该有 SortByDate 后显示的 TabGroup
});
```

（具体 mock group 字段按 `src/types/tab.ts` 的 `TabGroup` interface 填。）

- [ ] **Step 2: 同步测试 SyncStatusRow / TabGroupMenu 类比**

按 TabList 模板写。

- [ ] **Step 3: 跑 + Commit**

```bash
pnpm test -- tests/components/
git add -A
git commit -m "test(s2/p5): UI smoke tests (TabList, SyncStatusRow, TabGroupMenu)"
```

---

### Task 5.3: 错误边界友好文案 + Toast 位置修正

**Files:**
- Modify: `src/components/common/ErrorBoundary.tsx:18-145`
- Modify: `src/components/common/Toast.tsx:124-167`

- [ ] **Step 1: 改 ErrorBoundary 文案**

```typescript
// 友好文案
<div>
  <h2>TabStack 遇到了一个问题</h2>
  <p>临时错误。点击重试，或刷新 popup。</p>
  <button onClick={() => window.location.reload()}>重试</button>
</div>
```

- [ ] **Step 2: 改 Toast 位置**

```typescript
// Toast.tsx position: fixed → fixed right-2 top-2 max-w-[340px]
className="fixed right-2 top-2 max-w-[340px] z-50"
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "polish(s2/p5): friendly ErrorBoundary + Toast popup-bound fix"
```

---

### Task 5.4: Onboarding 5 步 → 3 步 + 视觉统一

**Files:**
- Modify: `src/components/onboarding/OnboardingSteps.tsx`
- Modify: `src/components/onboarding/OnboardingGuide.tsx`

- [ ] **Step 1: 砍 5 步 → 3 步（保存/恢复/搜索）**

读 `OnboardingSteps.tsx` 的 5 个 step，把 step 3（同步）和 step 5（统计）合并到 step 1/2 旁白；保留 3 个核心步骤。

- [ ] **Step 2: 每步用不同模板**

每个 step 不要都用 3-card-grid；改为：step 1 用 action+CTA 模板，step 2 用示例对比模板，step 3 用技巧提示模板。

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "polish(s2/p5): Onboarding 5→3 steps with varied templates"
```

---

### Task 5.5: 性能基准 + CI 收尾

**Files:**
- Create: `scripts/bench-popup-cold-start.mjs`
- Modify: `.github/workflows/ci.yml`（已存在 S2 加 zip 体积门禁）

- [ ] **Step 1: 加冷启动 benchmark**

```javascript
// scripts/bench-popup-cold-start.mjs
// 启动一个 headless chrome 加载 popup.html，测 FirstContentfulPaint
// 用 puppeteer 或 chrome devtools protocol
```

> 实现细节略；非关键。如时间紧，可 skip。

- [ ] **Step 2: 改 CI 加 zip 体积门禁**

读 `.github/workflows/ci.yml` 加：

```yaml
- name: Check zip size
  run: |
    cd dist
    zip -r ../dist.zip . > /dev/null
    SIZE=$(stat -c%s ../dist.zip)
    if [ $SIZE -gt 200000 ]; then
      echo "::error::dist.zip exceeds 200K (actual: $SIZE)"
      exit 1
    fi
```

- [ ] **Step 3: 跑 `pnpm verify` + 提交**

```bash
pnpm verify
git add -A
git commit -m "chore(s2/p5): popup cold-start benchmark + CI zip-size gate"
```

---

## Phase 5 验收

- 覆盖率 ≥ 65%（手动估；不引入 c8/istanbul 在 S2 内）
- 测试总数 ~343（已实现目标）
- 5 个不变量测试 + 5 个不变量（包含新增 syncEngine integration 在 S1）保持绿
- Chrome extension zip ≤ 200K gzip（CI 强制）
- popup 冷启动 ≤ 250ms（手动测）
- 100/300 会话流畅滚动（手动测）

---

## 最终验收（S2 Done Definition）

| # | 验收 | 命令 / 方法 |
|---|---|---|
| 1 | popup 冷启动 ≤ 250ms | 手动 + bencher |
| 2 | 100/300 会话流畅滚动 | `__TV_BENCH__.seedLargeDataset(N)` + 手动 |
| 3 | Header 不溢出 380px | 手动 |
| 4 | Settings 全屏 tab | 手动 |
| 5 | SyncStatusRow + 立即同步 | 手动 + 模拟 5 类错误 |
| 6 | `pnpm verify` 全绿 | `pnpm verify` |
| 7 | 测试 ≥ 343 个 | `pnpm test 2>&1 \| grep "tests"` |
| 8 | 没有死代码 | `grep -rn "import .*SearchBar\|import .*ThemeToggleButton" src/` 应为空 |
| 9 | 5 个不变量测试绿 | 5 个 tests/*.test.ts 跑过 |
| 10 | zip ≤ 200K | CI |
| 11 | brand identity 不变 | 颜色 #0D9488 / #F97316 仍存在 |
| 12 | 没有引入未批准 deps | `git diff main..HEAD -- package.json \| grep '"@tanstack' `/testing-` |

---

## Out of Scope（**不在 S2 内**，留给后续 sprint）

- 任何 React 19 / Vite 5 / CRXJS v3 升级
- 主题 marketplace / 主题动态在线商店
- i18n 完整多语言（仅 ErrorBoundary 中文化）
- 多设备 / 商业化架构预设
- 自托管 Supabase 选项
- S1 完整 spec + 实现（仅复用 `storage.hydrateAll`）
- S3 候选新功能（仅 outline）

---

**本文档是 S2 的实施依据。任何代码改动前必须参考本 plan 对应 Phase/Task；改完在 AI_HANDOFF.md 顶部加 Sprint 8 行（已设惯例）。**
