// 筛选浏览态的**渲染层**断言（2026-10-20 审计 A-14）。
//
// ── 这个文件要防的具体事故 ────────────────────────────────────────────────
//
// 空搜索词 + 有筛选条件时，界面会说错话：
//
//   · live region 播报「没有找到与“”相关的会话或标签」—— **“” 是空的**，
//     而且用户根本没搜过，说「没找到与空字符串相关的东西」是纯粹的胡话；
//   · 空态卡写「没有找到可找回的会话 / 没有找到与“”相关的会话或标签，
//     请尝试其他关键词」——「请尝试其他关键词」在**没有关键词**时是死路；
//   · 结果区标题写「会话搜索结果」—— 没有搜索这件事。
//
// 事故形态不是「文案写得难看」，是**界面声称了一件没发生的事**
// （本仓反复修过的那一类：2026-10-19 审计 F-5 的「重复导入被误报成备份坏了」）。
//
// ── 为什么必须用「真的渲染一遍」而不是读源码 ──────────────────────────────
//
// 【这是本文件存在的原因：上一版守卫的盲区】
//
// 第一版守卫只断言了**文案函数**产出的句子（「browseEmptyTitle 里不得出现
// 「搜索」」）。实测的变异验证 M4 揭示了它的检测力是**零**：
// 把组件里的 `isBrowseMode ? browseEmptyTitle : ...` 改成恒定走旧文案分支，
// 文案函数一个字没动 ⇒ **34 条守卫全绿**，而界面上已经在说
// 「没有找到与“”相关的会话或标签」。
//
// 根因：**「文案是对的」与「界面用的是这句文案」是两件事**。
// 前者是函数的性质，后者是接线的性质 —— 只测前者，测不到后者。
//
// 所以这里用 `react-dom/server` **真的把组件渲染一遍**，断言输出的 HTML。
// 本仓没有 jsdom / happy-dom / @testing-library，但服务端渲染不需要 DOM
// （见 tests/overwritePreviewRender.test.ts 的同一套 harness）。
//
// ── 判据从代码取事实还是从文档取事实 ─────────────────────────────────────
//
// **从代码取事实**：渲染出来的 HTML 里有什么字。
//   · 空搜索词时，界面上**不得**出现「与“”相关」「请尝试其他关键词」
//     这类声称「搜索过、没搜到」的字样；
//   · 空搜索词时，界面必须说清是**筛选条件**筛空的；
//   · 有搜索词时，界面上**必须**出现「与“react”相关」这类说法
//     （既有行为不许被这次改动悄悄改掉）。
//
// **不**从文档取事实：这里不检查 README 说什么 —— 那是另一个文件
// （filterReachability.test.ts）的第 0 组断言的职责。
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
    getItem: (k: string) => (lsData.has(k) ? lsData.get(k) : null),
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
};

interface FilterControlsStub {
  filters: Record<string, unknown>;
  effectiveFilters: Record<string, unknown>;
  activeFilterCount: number;
  showFilters: boolean;
  isFilterPending: boolean;
  updateFilters: () => void;
  clearFilters: () => void;
  toggleFilters: () => void;
}

const controlsWith = (over: Partial<FilterControlsStub>): FilterControlsStub => ({
  filters: {},
  effectiveFilters: {},
  activeFilterCount: 0,
  showFilters: false,
  isFilterPending: false,
  updateFilters: () => undefined,
  clearFilters: () => undefined,
  toggleFilters: () => undefined,
  ...over,
});

/** 真的把结果视图渲染一遍，返回 HTML 字符串。 */
const renderResults = async (
  searchQuery: string,
  controls: FilterControlsStub
): Promise<string> => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Provider } = await import('react-redux');
  const { createStore } = await import('@/store');
  const { SearchResultList } = await import('@/components/search/SearchResultList');
  const { ToastProvider } = await import('@/contexts/ToastContext');

  return renderToStaticMarkup(
    React.createElement(
      Provider,
      { store: createStore() } as never,
      React.createElement(
        ToastProvider,
        null,
        React.createElement(SearchResultList, {
          searchQuery,
          filterControls: controls as never,
        } as never)
      )
    )
  );
};

/**
 * 界面上**声称「搜索过、没搜到」**的字样。
 *
 * 判据是语义：出现了「与『某个查询词』相关」或「请尝试其他关键词」，
 * 就是声称用户搜过。空搜索词时这两者都是假的。
 */
const claimsSearched = (html: string): boolean =>
  /与[“"「][^”"」]*[”"」]相关/.test(html) || /其他关键词/.test(html);

describe('筛选浏览态：界面不得声称「搜索过、没搜到」', () => {
  it('没有搜索词时，界面上不得出现「与「」相关」或「请尝试其他关键词」', async () => {
    const html = await renderResults(
      '',
      controlsWith({
        filters: { domain: 'github.com' },
        effectiveFilters: { domain: 'github.com' },
        activeFilterCount: 1,
      })
    );

    assert.ok(
      !claimsSearched(html),
      `没有搜索词时，界面不得说「与某词相关」或「请尝试其他关键词」—— 那是声称用户搜过。\n实际渲染：\n${html.slice(0, 1200)}`
    );
  });

  it('没有搜索词时，界面必须说清是**筛选条件**筛空的', async () => {
    const html = await renderResults(
      '',
      controlsWith({
        filters: { domain: 'github.com' },
        effectiveFilters: { domain: 'github.com' },
        activeFilterCount: 1,
      })
    );

    assert.match(
      html,
      /筛选|条件/,
      `没有搜索词时，空态必须说清是筛选条件筛空了什么。\n实际渲染：\n${html.slice(0, 1200)}`
    );
  });

  it('没有搜索词时，筛选条件生效的证据必须看得见（徽章 + 清空入口）', async () => {
    // 「看不见但条件在生效」是本仓反复修过的那类隐形行为。
    const html = await renderResults(
      '',
      controlsWith({
        filters: { domain: 'github.com' },
        effectiveFilters: { domain: 'github.com' },
        activeFilterCount: 1,
      })
    );

    assert.match(html, /1 个筛选/, '生效的筛选必须显示出来');
    assert.match(html, /清空筛选/, '生效的筛选必须给出清除入口');
  });

  it('有搜索词时，既有行为不变：界面照旧说「与该词相关」', async () => {
    // 这次改动**不许**把搜索态的文案也一起改掉 ——
    // 用户搜了词，「没搜到」的说法是对的。
    const html = await renderResults(
      'react',
      controlsWith({
        filters: { domain: 'github.com' },
        effectiveFilters: { domain: 'github.com' },
        activeFilterCount: 1,
      })
    );

    assert.ok(
      claimsSearched(html),
      `有搜索词时，空态必须照旧说「与该词相关」（既有行为不许被改掉）。\n实际渲染：\n${html.slice(0, 1200)}`
    );
  });

  it('没有搜索词、也没有筛选条件时，界面不得声称「没找到」', async () => {
    // 这一格本来就不该出现（没有条件就没有结果视图），但万一哪天接线变了，
    // 它也不该对用户说「没找到 X」。
    const html = await renderResults('', controlsWith({}));

    assert.ok(
      !claimsSearched(html),
      `没有搜索词也没有筛选条件时，界面不得说「没找到」之类的断言。\n实际渲染：\n${html.slice(0, 1200)}`
    );
  });
});

describe('筛选浏览态：同一句话不得在一屏里出现两次', () => {
  // 真机截图（outputs/prod-filter-browse/03-browse-filtered.png）暴露的瑕疵：
  //   卡片头：「符合条件的会话」
  //   筛选区：「按条件筛选会话」
  // 两行都是标题级、说的是同一件事（这批会话是按条件筛出来的）⇒
  // 同一个信息在一屏里出现两次，且两行都长得像标题 ⇒ 视觉噪音。
  //
  // 【为什么这条要钉在渲染层】标题去留的**判据**是纯函数
  // （showFilterSectionTitle），但「界面有没有真的不显示它」是**接线**的事。
  // 本仓已经吃过这个亏（A-14 第一轮守卫的 M4 变异：文案函数一个字没动，
  // 而组件恒定走旧分支 ⇒ 34 条守卫全绿，界面却在说假话）。
  // ⇒ 这里断言渲染出的 HTML。

  it('筛选浏览态：不得同时出现「符合条件的会话」与「按条件筛选会话」', async () => {
    const html = await renderResults(
      '',
      controlsWith({
        filters: { domain: 'github.com' },
        effectiveFilters: { domain: 'github.com' },
        activeFilterCount: 1,
      })
    );

    assert.match(
      html,
      /符合条件的会话/,
      `（前置）卡片头必须仍然说「符合条件的会话」。\n实际渲染：\n${html.slice(0, 1200)}`
    );
    assert.doesNotMatch(
      html,
      /按条件筛选会话/,
      `筛选浏览态下不得再显示「按条件筛选会话」—— 它与卡片头的` +
        `「符合条件的会话」是同一句话，在同一屏里出现两次且都长得像标题。`
    );
  });

  it('搜索态：标题保留（那里它起分区作用，不许被一起删掉）', async () => {
    const html = await renderResults(
      'react',
      controlsWith({
        filters: { domain: 'github.com' },
        effectiveFilters: { domain: 'github.com' },
        activeFilterCount: 1,
      })
    );

    assert.match(
      html,
      /会话搜索结果/,
      `搜索态下筛选区必须保留标题「会话搜索结果」—— ` +
        `那里筛选面板在结果卡内部，标题起分区标识的作用。\n实际渲染：\n${html.slice(0, 1200)}`
    );
  });
});
