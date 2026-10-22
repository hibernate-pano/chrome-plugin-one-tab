// 搜索框里只有**空白字符**时，空态引导卡必须还在（2026-10-20 审计 A-14 的收口）。
//
// ── 这个文件要防的具体事故 ────────────────────────────────────────────────
//
// A-14 的修复给列表层引入了「界面形态」判定（list / browse / search）。
// 形态判定用的是**去空白后**的搜索词（`resolveSearchViewMode` 内部 `query.trim()`），
// 而空态分支原本用的是**原始**搜索词（`!searchQuery`）。
//
// 两处口径不一致 ⇒ 搜索框里只敲了一个空格时：
//
//   · 形态 = list（因为 `"   ".trim() === ''`）⇒ 应该显示**空态引导卡**；
//   · 但 `!searchQuery` 为**假**（`"   "` 是真值）⇒ 空态分支被跳过。
//
// 结果：用户在一个**空会话**的 TapStack 上，把搜索框里敲了个空格，
// 整个页面变成**一片空白** —— 没有引导卡、没有「先保存一个工作会话」、
// 没有主 CTA。新用户第一屏就撞上这个，且**无法自查原因**。
//
// 事故形态不是「文案不好看」，是**界面什么都不给**。
//
// ── 为什么必须渲染一遍而不是读源码 ────────────────────────────────────────
//
// 读源码能断言「空态分支的条件是什么」，但断言不了「**这个条件下真的渲染出卡**」。
// 本仓已经吃过这个亏：2026-10-20 审计 A-14 的第一版守卫只测纯函数，
// 变异 M2/M6/M7 全部漏网 —— 根因是「函数是对的」与「界面用的是它」是两件事。
// 所以这里用 `react-dom/server` 真的把 `TabList` 渲染一遍，断言输出的 HTML。
//
// 本仓没有 jsdom / happy-dom / @testing-library，但服务端渲染不需要 DOM
// （与 tests/guards/filterBrowseRender.test.ts 同一套 harness）。
//
// ── 判据从哪来 ────────────────────────────────────────────────────────────
//
// **从代码取事实**：渲染出来的 HTML 里有什么字 / 有什么元素。
//   · 空会话 + 空白搜索词 ⇒ 必须出现空态引导卡（「先保存一个工作会话」）；
//   · 空会话 + 空白搜索词 + 有筛选条件 ⇒ 走筛选浏览态，**不该**出现引导卡
//     （那是另一个形态，不是这条守卫要管的事）。
//
// **不**从文档取事实：README 说什么与这条无关 —— 这是**行为**断言。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// react-dom/server 依赖 window/localStorage 的一小撮 API（只是桩，不是 DOM 环境）。
const lsData = new Map<string, string>();
(globalThis as Record<string, unknown>).window = {
  localStorage: {
    get length() {
      return lsData.size;
    },
    key: (i: number) => [...lsData.keys()][i] ?? null,
    getItem: (k: string) => (lsData.has(k) ? (lsData.get(k) as string) : null),
    setItem: (k: string, v: string) => void lsData.set(k, String(v)),
    removeItem: (k: string) => void lsData.delete(k),
    clear: () => void lsData.clear(),
  },
  matchMedia: () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }),
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true,
};
(globalThis as Record<string, unknown>).localStorage = (
  globalThis as unknown as { window: { localStorage: unknown } }
).window.localStorage;
(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined,
    },
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  },
  runtime: { getManifest: () => ({ version: 'test' }), sendMessage: async () => ({}) },
  tabs: { query: async () => [] },
};

/** 空态引导卡的标志文案（来自 TabList 的 EmptyState title）。 */
const EMPTY_STATE_MARKER = '先保存一个工作会话';

/**
 * 真的把列表渲染一遍，返回 HTML 字符串。
 *
 * 默认 Redux store 的 `tabs.groups` 为空、加载已完成 —— 即「用户还没有任何会话」
 * 这条路径（空态引导卡唯一会出现的地方）。
 */
const renderList = async (searchQuery: string): Promise<string> => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Provider } = await import('react-redux');
  const { createStore } = await import('@/store');
  const { TabList } = await import('@/components/tabs/TabList');
  // 筛选状态住在**应用层**（MainApp 持有，2026-10-22 审计 P1-8：
  // 顶栏的「回到默认视图」要能清筛选，而顶栏在列表层上面）。
  // 所以这里用一个小包装组件在**组件内部**调 hook —— hook 不能在组件外调。
  const { useSearchFilters } = await import('@/components/search/useSearchFilters');
  // 有搜索词时会走到 SearchResultList，它用 useToast ⇒ 必须包 ToastProvider
  // （与 tests/guards/filterBrowseRender.test.ts 同一套 harness）。
  const { ToastProvider } = await import('@/contexts/ToastContext');

  const ListWithFilters = ({ query }: { query: string }) => {
    const filterControls = useSearchFilters();
    return React.createElement(TabList, { searchQuery: query, filterControls } as never);
  };

  return renderToStaticMarkup(
    React.createElement(
      Provider,
      { store: createStore() } as never,
      React.createElement(
        ToastProvider,
        null,
        React.createElement(ListWithFilters, { query: searchQuery })
      )
    )
  );
};

describe('空白搜索词：空态引导卡必须还在', () => {
  it('完全没搜索词时，空会话显示引导卡（基线：这条必须先成立）', async () => {
    const html = await renderList('');
    assert.match(
      html,
      new RegExp(EMPTY_STATE_MARKER),
      `前置：空会话且没有搜索词时必须显示引导卡（这是本文件的事实来源）。\n实际渲染：\n${html.slice(0, 800)}`
    );
  });

  it('搜索框里只有一个空格时，空会话**同样**显示引导卡', async () => {
    const html = await renderList(' ');
    assert.match(
      html,
      new RegExp(EMPTY_STATE_MARKER),
      `搜索框里只有空白字符时，用户看到的必须和「完全没搜」一样 —— ` +
        `否则新用户第一屏会是一片空白，既没有引导也没有主 CTA。\n实际渲染：\n${html.slice(0, 800)}`
    );
  });

  it('多个空白字符（空格 / 制表符 / 换行）同样不得让引导卡消失', async () => {
    for (const q of ['   ', '\t', '\n', ' \t\n ', '　']) {
      const html = await renderList(q);
      assert.match(
        html,
        new RegExp(EMPTY_STATE_MARKER),
        `搜索词 ${JSON.stringify(q)} 应当被当作「没搜」—— 引导卡必须还在。\n实际渲染：\n${html.slice(0, 800)}`
      );
    }
  });

  it('空白搜索词与「完全没搜」渲染出的引导卡内容必须一致', async () => {
    // 断言的是**一致性**：全角空格（U+3000）这类字符在 trim() 里不被去掉
    // （ECMAScript 的 trim 只去空白字符，不去全角空格）—— 但它对用户来说
    // 就是「没输入内容」。这里只断言「都显示引导卡」，不要求字节级相同，
    // 因为引导卡里的问候语依赖当前时刻。
    const blank = await renderList('   ');
    const none = await renderList('');
    const marker = new RegExp(EMPTY_STATE_MARKER);
    assert.equal(
      marker.test(blank),
      marker.test(none),
      '空白搜索词与没有搜索词，引导卡的显示与否必须一致'
    );
  });
});

describe('有搜索词时，空态引导卡必须**不**出现', () => {
  it('正常搜索词 + 空会话 ⇒ 不显示引导卡（那是搜索结果视图的职责）', async () => {
    const html = await renderList('react');
    assert.doesNotMatch(
      html,
      new RegExp(EMPTY_STATE_MARKER),
      `有搜索词时不该显示「先保存一个工作会话」—— 界面该给的是搜索结果（哪怕是空结果）。\n实际渲染：\n${html.slice(0, 800)}`
    );
  });
});
