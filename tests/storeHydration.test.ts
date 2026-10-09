// 验证 createStore(preloadedState) 把 local 数据塞进初始 state，
// 以便 popup 首屏 render 就能显示数据，避免 EmptyState 闪一下。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

// Set up Vite-style env stub so the loader can rewrite `import.meta.env`.
// Must be set BEFORE registering the loader / importing the store
// (supabase.ts reads import.meta.env at module load time).
globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

/** 仓库根（源码断言用）。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

before(async () => {
  register(LOADER_PATH);
});

describe('createStore + preloadedState', () => {
  it('不传 preloadedState 时使用 initialTabState 默认值（groups=[]）', async () => {
    const { createStore } = await import('@/store');
    const store = createStore();
    const state = store.getState();
    assert.deepEqual(state.tabs.groups, []);
    assert.equal(state.tabs.lastLoadedAt, null);
    assert.equal(state.tabs.lastSyncStatus, null);
  });

  it('传入 preloadedState 时把 groups / lastLoadedAt / lastSyncStatus 注入初始 state', async () => {
    // createStore 的形参是 Partial<RootState>，也就是 tabs 必须是**完整**的 TabState。
    // 【2026-10-09 注】原先这里引用 `src/core/hydrationDecision.ts:56` 的
    // buildTabsPreloadedState 作为「合并纪律」的出处。那套 hydration 路径已随
    // 专家团体检删除（零生产调用方：popup 不再 bootstrap、TabList 不再看
    // lastLoadedAt 短路）。本用例继续有效——它测的是 **createStore 的基础能力**，
    // 与那套路径无关；只是出处没了，纪律本身（tabs 需完整 TabState）由类型保证。
    const { createStore } = await import('@/store');
    const { initialTabState } = await import('@/store/slices/tabSlice');
    const now = '2026-06-02T08:00:00.000Z';
    const localGroups = [
      {
        id: 'g-1',
        name: 'Local',
        tabs: [],
        createdAt: now,
        updatedAt: now,
        isLocked: false,
        version: 1,
      },
    ];
    const store = createStore({
      tabs: { ...initialTabState, groups: localGroups, lastLoadedAt: now, lastSyncStatus: 'local' },
      settings: undefined,
    });
    const state = store.getState();
    assert.equal(state.tabs.groups.length, 1);
    assert.equal(state.tabs.groups[0].id, 'g-1');
    assert.equal(state.tabs.lastLoadedAt, now);
    assert.equal(state.tabs.lastSyncStatus, 'local');
  });
});

describe('「空读不得被固化」不变式的**活代码**守护者（2026-10-09 架构清理）', () => {
  // ── 这段记录一次「不变式换守护者」的迁移 ────────────────────────────────
  //
  // 历史上「刷新后数据丢失」的根因是：popup bootstrap 把瞬时空读（加密失败、
  // IndexedDB 冷启动错误被吞、缓存命中）当成「已加载」，固化 lastLoadedAt；
  // TabList 见到 lastLoadedAt 就**永久跳过 loadGroups**（`if (lastLoadedAt) return`），
  // 于是用户看到 EmptyState 而数据其实还在。
  //
  // 修法是 decideTabsHydration：只有读到**非空**才固化。
  //
  // 2026-10-09 专家团体检确认：整套 hydration 路径已退役 ——
  // popup/index.tsx 不再有 bootstrap/preloadedState，TabList 不再读 lastLoadedAt，
  // decideTabsHydration / buildTabsPreloadedState **零生产调用方**。
  // 于是删掉实现与它的纯函数测试（`hydrationDecision.test.ts`）。
  //
  // ⚠️ 但**不变式本身不能跟着消失**。它现在的守护者是活代码：
  // TabList 每次挂载都无条件 dispatch(loadGroups())，根本不存在「被固化后
  // 永久跳过」这条路径。下面的断言把这一点钉死：任何人重建 lastLoadedAt
  // 短路或 preloadedState 水合，都会在这里红。
  const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
  const strip = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('TabList 不得用 lastLoadedAt 短路 loadGroups（那正是丢数据的机制）', () => {
    const tabList = strip(read('src/components/tabs/TabList.tsx'));
    assert.ok(
      !/if\s*\(\s*lastLoadedAt\s*\)\s*return/.test(tabList),
      'TabList 又出现了 `if (lastLoadedAt) return` —— 这就是历史 P0 的机制本身：' +
        '瞬时空读被固化后永久跳过重载，用户看到空列表而数据还在'
    );
    // 必须**无条件**发起加载（挂载即 loadGroups）
    assert.match(
      tabList,
      /dispatch\(loadGroups\(\)\)/,
      'TabList 必须在挂载时 dispatch(loadGroups()) —— 这是「空读不会被固化」的活代码守护者'
    );
  });

  it('popup 入口不得重建 preloadedState 水合路径', () => {
    const popup = strip(read('src/popup/index.tsx'));
    assert.ok(
      !/preloadedState/.test(popup),
      'popup 入口又注入 preloadedState 了 —— 那需要重新论证「空读不被固化」' +
        '（原来的 decideTabsHydration 已删除；重建水合路径必须同时恢复那套决策与测试）'
    );
  });

  it('hydrationDecision 实现与它的纯函数测试都已删除（不得半途复活）', () => {
    assert.ok(
      !existsSync(resolve(ROOT, 'src/core/hydrationDecision.ts')),
      'hydrationDecision.ts 复活了 —— 若确实需要水合决策，请连同 popup/TabList 的接线一起恢复，' +
        '并恢复「空读不固化」的纯函数测试；只放回实现文件是没有调用方的死代码'
    );
    assert.ok(
      !existsSync(resolve(ROOT, 'tests/hydrationDecision.test.ts')),
      'hydrationDecision.test.ts 复活了但没有对应实现 —— 测一个不存在的模块'
    );
  });
});
