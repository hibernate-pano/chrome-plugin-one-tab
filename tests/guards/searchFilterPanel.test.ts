// 筛选面板的四条不变量 —— 2026-10-22 审计 U-07 / U-08 / U-09 / U-22 的守卫。
//
// ── 这个文件守的是什么 ────────────────────────────────────────────────────
//
// 面板（`src/components/search/SearchFilterPanel.tsx`）是筛选区唯一的渲染点。
// 这一轮审计在它身上量到四个问题：
//
//   · U-07 颜色：它是全页**唯一不跟主题走**的一块 —— claude 主题下
//     「显示筛选」是写死的品牌蓝 rgb(37,99,235)，而同屏强调色是 #d97757；
//   · U-08 高度：400px 宽下面板 191px 高，把第一张会话卡（287px）的下半截
//     顶出折叠线；
//   · U-09 布局：4 列栅格把 3 个短字段摊成 1/4 屏，第 4 格空着，而且
//     「固定标签页」是条件渲染的 ⇒ 开关一变列数就变；
//   · U-22 字号：字段标签 12px、输入框 13px，比页面其它文字小一档。
//
// 修法都落在**同一个文件**里 ⇒ 这个文件就是那道闸门。
//
// ── 为什么「源码 + 渲染」两层都要 ─────────────────────────────────────────
//
// 只读源码的守卫在本仓反复吃过亏（见 `tests/guards/hardcodedGrayTextScanned.test.ts`
// 的文件头：白名单式守卫让**新文件**天然落在网外）。所以这里两层都做：
//   · 源码层：扫 className 里的写死颜色、扫布局类名里的条件表达式；
//   · 渲染层：真的把筛选区渲染一遍（react-dom/server），断言输出的 HTML。
//
// ── 为什么守的是「不变量」而不是字面量 ────────────────────────────────────
//
// 字号那一组刻意用「**不小于**某一档」而不是「必须等于 text-base」——
// 全局字号阶梯（审计 U-04）会整体调整，硬钉具体类名会让正确的改动先变红。
// 同理，颜色那一组守的是「不许出现写死的调色板类」，不是「必须写某个
// theme-* 类」—— 主题工具类以后增删都不该把守卫打红。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PANEL_REL = 'src/components/search/SearchFilterPanel.tsx';
const PANEL_SOURCE = readFileSync(resolve(ROOT, PANEL_REL), 'utf8');

/**
 * 字号阶梯：档名 → px（**从 tailwind 配置里取**，不写死 —— 阶梯会调整）。
 *
 * 【为什么解析文本而不是 require】仓库是 ESM（package.json 里 type: module），
 * 而 tailwind.config.js 是 CJS 语法（module.exports）⇒ require 会炸。
 * 这里只取 fontSize 那一段，够用且不引依赖。
 */
const FONT_SIZE_LADDER: Record<string, number> = (() => {
  const configSource = readFileSync(resolve(ROOT, 'tailwind.config.js'), 'utf8');
  const block = configSource.match(/fontSize:\s*\{([\s\S]*?)\n\s*\},/);
  assert.ok(block, 'tailwind.config.js 里找不到 fontSize 阶梯');
  const ladder: Record<string, number> = {};
  for (const match of block[1].matchAll(/'([^']+)':\s*\[\s*'([\d.]+)(rem|px)'/g)) {
    const size = Number(match[2]);
    ladder[match[1]] = match[3] === 'rem' ? size * 16 : size;
  }
  assert.ok(Object.keys(ladder).length > 0, 'fontSize 阶梯解析为空');
  return ladder;
})();

// ─────────────────────────────────────────────────────────────────────────
// 0. harness
// ─────────────────────────────────────────────────────────────────────────

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
    onChanged: { addListener: () => undefined, removeEventListener: () => undefined },
  },
  runtime: { getManifest: () => ({ version: 'test' }), sendMessage: async () => ({}) },
};

interface ControlsStub {
  filters: Record<string, unknown>;
  effectiveFilters: Record<string, unknown>;
  activeFilterCount: number;
  showFilters: boolean;
  isFilterPending: boolean;
  updateFilters: () => void;
  clearFilters: () => void;
  toggleFilters: () => void;
}

const controlsWith = (over: Partial<ControlsStub>): ControlsStub => ({
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

/** 真的把筛选区渲染一遍，返回 HTML 字符串。 */
const renderFilterSection = async (
  over: Partial<ControlsStub>,
  collectPinnedTabs = false
): Promise<string> => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Provider } = await import('react-redux');
  const { createStore } = await import('@/store');
  const { ToastProvider } = await import('@/contexts/ToastContext');
  const { SearchFilterSection } = await import('@/components/search/SearchFilterPanel');

  const store = createStore();
  // ToastProvider 必须包上：排序控件用 useToast 报落盘失败（见面板里的回滚逻辑）。
  return renderToStaticMarkup(
    React.createElement(
      Provider,
      // 与 tests/guards/filterBrowseRender.test.ts 同一口径：react-redux 的
      // Provider 类型把 children 声明成必填，但这里 children 是第三个参数
      // （createElement 的用法）⇒ 类型上不匹配，cast 掉（与仓内其它渲染型
      // 守卫一致）。
      { store } as never,
      React.createElement(
        ToastProvider,
        null,
        React.createElement(SearchFilterSection, {
          controls: controlsWith(over) as never,
          title: '筛选会话',
          collectPinnedTabs,
          variant: 'flush',
        })
      )
    )
  );
};

// ─────────────────────────────────────────────────────────────────────────
// 1. 工具
// ─────────────────────────────────────────────────────────────────────────

/** 剥掉注释：注释里提到旧类名不该让守卫变红（与本仓其它守卫同一口径）。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

/**
 * 写死的调色板类（Tailwind 固定色阶 / 本仓的品牌色阶）。
 *
 * 这些颜色**不跟主题走** —— 六套主题各有自己的表面色与强调色，同一段灰阶在
 * 某些主题上低于 WCAG AA 正文线（实测 creamy 深色态 gray-400 只有 4.42:1）。
 * 主题工具类长这样：`theme-text-primary` / `theme-accent-soft` —— 前面是
 * `theme-`，所以本正则**不会**把它们误判（`text-primary` 前面那个 `-` 让
 * 「词首」不成立）。
 */
const FIXED_COLOR_TOKEN =
  /^(?:dark:)?(?:hover:|focus:|focus-visible:|active:|disabled:|checked:|group-hover:)*(?:text|bg|border|ring|fill|stroke|from|via|to|divide|outline|decoration|placeholder|caret|shadow)-(?:gray|slate|zinc|neutral|stone|primary|accent|success|warning|danger|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?$/;

/** HTML 里的 class 属性值 → 全部类名 token。 */
const classTokensOfHtml = (html: string): string[] =>
  [...html.matchAll(/class="([^"]*)"/g)].flatMap(match => match[1].split(/\s+/).filter(Boolean));

/** 源码里的字符串字面量 → 全部类名 token（近似：字符串里可能有非类名的字）。 */
const classTokensOfSource = (src: string): string[] => {
  const literals = [...stripComments(src).matchAll(/'([^'\\]*)'|"([^"\\]*)"|`([^`\\]*)`/g)];
  return literals.flatMap(match => {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    return value.split(/\s+/).filter(Boolean);
  });
};

const fixedColorOffenses = (tokens: string[]): string[] =>
  tokens.filter(token => FIXED_COLOR_TOKEN.test(token));

/** 取出某个元素的 class（渲染结果里）。 */
const classOfElement = (html: string, tagPattern: RegExp): string => {
  const tag = html.match(tagPattern);
  assert.ok(tag, `渲染结果里找不到元素：${tagPattern}`);
  const cls = tag[0].match(/class="([^"]*)"/);
  return cls ? cls[1] : '';
};

/** 字号类 → px（阶梯从 tailwind 配置取；任意值 text-[Npx] 覆盖同名档）。 */
const FONT_SIZE_TOKEN = /^text-(xs|sm|base|lg|xl|2xl|3xl)$/;
const ARBITRARY_FONT_SIZE = /^text-\[(\d+(?:\.\d+)?)px\]$/;

const fontSizePxOf = (classList: string): number | null => {
  let named: number | null = null;
  let arbitrary: number | null = null;
  for (const token of classList.split(/\s+/)) {
    const namedMatch = FONT_SIZE_TOKEN.exec(token);
    if (namedMatch) {
      const px = FONT_SIZE_LADDER[namedMatch[1]];
      // Tailwind 产物 CSS 里同名档按阶梯排序 ⇒ 多个同名档时较大的一档生效。
      named = named === null ? px : Math.max(named, px);
      continue;
    }
    const arbitraryMatch = ARBITRARY_FONT_SIZE.exec(token);
    if (arbitraryMatch) arbitrary = Number(arbitraryMatch[1]);
  }
  // 任意值在 Tailwind 里排在同名档之后 ⇒ 它覆盖同名档。
  return arbitrary ?? named;
};

// ─────────────────────────────────────────────────────────────────────────
// 2. U-07 · 颜色必须走主题
// ─────────────────────────────────────────────────────────────────────────

describe('U-07 · 筛选面板不得用写死的颜色', () => {
  it('源码与渲染结果里都不得出现 Tailwind 固定色阶 / 品牌色阶', async () => {
    // 【为什么这条要存在】面板是全页唯一不跟主题走的一块：claude 主题下
    // 「显示筛选」是写死的品牌蓝 rgb(37,99,235)，而同屏强调色是 #d97757 ——
    // 同一行里两种颜色，用户会以为它们是两个不同的功能。
    //
    // 【为什么两层都扫】只看源码 ⇒ 运行期才拼出来的类名（模板表达式）漏网；
    // 只看渲染 ⇒ 注释与死分支里的类名漏网。两层都扫才盖得住。
    const sourceOffenses = fixedColorOffenses(classTokensOfSource(PANEL_SOURCE));
    assert.deepEqual(
      sourceOffenses,
      [],
      `源码里有写死的颜色（必须换成 theme-* 令牌）：${sourceOffenses.join('、')}`
    );

    const html = await renderFilterSection({ showFilters: true }, true);
    const renderedOffenses = fixedColorOffenses(classTokensOfHtml(html));
    assert.deepEqual(
      renderedOffenses,
      [],
      `渲染结果里有写死的颜色（必须换成 theme-* 令牌）：${renderedOffenses.join('、')}`
    );
  });

  it('「显示筛选」入口必须用主题强调色（它是最显眼的那个可点元素）', async () => {
    // 【为什么单独守这一条】写死品牌蓝的那一处就是「显示筛选」按钮 ——
    // 它是筛选区唯一带品牌色的文字，在暖色主题（claude / creamy）下最扎眼。
    // 别的类名以后会增删，这条守的是「这个按钮的颜色跟主题走」这件事。
    const html = await renderFilterSection({});
    const toggleTag = html.match(/<button[^>]*>[^<]*(?:<svg[\s\S]*?<\/svg>)?[^<]*筛选<\/button>/);
    assert.ok(toggleTag, '找不到「显示筛选 / 隐藏筛选」按钮');
    const cls = toggleTag[0].match(/class="([^"]*)"/);
    assert.ok(cls, '按钮没有 class');
    assert.ok(
      cls[1].includes('theme-accent-text'),
      `「显示筛选」必须用主题强调色（theme-accent-text），实测：${cls[1]}`
    );
    assert.deepEqual(
      fixedColorOffenses(cls[1].split(/\s+/)),
      [],
      `「显示筛选」按钮上有写死的颜色：${cls[1]}`
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. U-08 / U-09 · 布局与「生效条件可见」
// ─────────────────────────────────────────────────────────────────────────

describe('U-08 / U-09 · 面板的布局与生效条件', () => {
  it('chip 行的布局不得随「固定标签页」开关变化', async () => {
    // 【为什么这条要存在】修复前面板是 `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`，
    // 而「固定标签页」那一列是条件渲染的 ⇒ 关掉那个设置，列数从 4 变 3，
    // 整行重排、输入框宽度也变 —— 布局在用户眼皮底下抖。
    //
    // 【怎么判】渲染两次（开关开 / 关），取 chip 行那一格的 class 比对：
    // 布局容器必须**完全一样**。
    const withPinned = await renderFilterSection({ showFilters: true }, true);
    const withoutPinned = await renderFilterSection({ showFilters: true }, false);

    const rowClass = (html: string): string => {
      const tag = html.match(/<div[^>]*data-testid="search-filter-chip-row"[^>]*>/);
      assert.ok(tag, '面板里必须有一行 chip（data-testid 锚点不见了）');
      const cls = tag[0].match(/class="([^"]*)"/);
      return cls ? cls[1] : '';
    };

    assert.equal(
      rowClass(withPinned),
      rowClass(withoutPinned),
      'chip 行的布局类必须与「固定标签页」开关无关'
    );
    assert.ok(
      rowClass(withPinned).includes('flex-wrap'),
      `维度行必须是流式换行的（flex-wrap），实测：${rowClass(withPinned)}`
    );
  });

  it('布局类名不得是条件表达式，也不得用固定列数的栅格', () => {
    // 【为什么这条要存在】「列数」如果由开关算出来（`grid-cols-${n}`），那么
    // 改开关 = 改布局 = 用户眼里的抖动；固定列数的栅格在 3 个维度时还会留
    // 一格空白（U-09 说的「第 4 格空着」）。
    const anchor = PANEL_SOURCE.indexOf('data-testid="search-filter-chip-row"');
    assert.ok(anchor > -1, '源码里找不到 chip 行的锚点');
    const tagStart = PANEL_SOURCE.lastIndexOf('<div', anchor);
    const tagEnd = PANEL_SOURCE.indexOf('>', anchor);
    const openTag = PANEL_SOURCE.slice(tagStart, tagEnd + 1);

    const classMatch = openTag.match(/className="([^"]*)"/);
    assert.ok(
      classMatch,
      `chip 行的 className 必须是静态字符串（不得是模板表达式）：${openTag}`
    );
    assert.ok(
      !classMatch[1].includes('${') && !classMatch[1].includes('?'),
      `chip 行的布局类名不得含条件表达式：${classMatch[1]}`
    );
    assert.ok(
      !/grid-cols-/.test(PANEL_SOURCE),
      '面板不得用按固定列数排布的栅格（维度行是流式的；固定列数 ⇒ 开关一变就重排）'
    );
  });

  it('生效中的条件必须渲染成 chip，且内容来自当前生效值', async () => {
    // 【为什么这条要存在】「看不见但条件在生效」是本仓反复修过的那类隐形行为。
    // 徽章只说「有 1 个筛选」，不说**是哪一个** —— 条件生效而用户不知道是
    // 哪一个，界面上就等于条件是偷偷生效的。
    //
    // 【怎么判】两次渲染给不同的生效值：第二次必须显示新值、**不得**显示旧值
    // ⇒ 渲染处确实调用了当前值，而不是写死一句字符串。
    const first = await renderFilterSection({
      filters: { domain: 'github.com' },
      effectiveFilters: { domain: 'github.com' },
      activeFilterCount: 1,
      showFilters: false,
    });
    assert.ok(
      first.includes('github.com'),
      '面板收起时也必须看得见生效的条件（生效条件 chip 不能只在面板里）'
    );

    const second = await renderFilterSection({
      filters: { domain: 'example.org' },
      effectiveFilters: { domain: 'example.org' },
      activeFilterCount: 1,
    });
    assert.ok(second.includes('example.org'), 'chip 的内容必须跟着当前生效值走');
    assert.ok(
      !second.includes('github.com'),
      'chip 的内容写死了旧值 —— 生效条件变了，界面还显示上一个值'
    );
  });

  it('生效条件 chip 的 key 由当前生效值拼成', async () => {
    // 【为什么 key 里要带值】key 相同 ⇒ React 认为是同一个节点；值变了就是
    // 另一个 chip，key 跟着变才不会在两个不同内容之间复用同一个 DOM。
    const { buildActiveFilterChips } = await import('@/components/search/SearchFilterPanel');
    const first = buildActiveFilterChips({ domain: 'github.com' });
    assert.equal(first.length, 1, '一个生效条件 ⇒ 一个 chip');
    assert.equal(first[0].key, 'domain:github.com', 'chip 的 key 必须由当前生效值拼成');
    const second = buildActiveFilterChips({ domain: 'example.org' });
    assert.notEqual(
      second[0].key,
      first[0].key,
      '值变了 chip 必须是另一个 chip（key 得跟着变）'
    );
    assert.deepEqual(
      buildActiveFilterChips({}).map(chip => chip.key),
      [],
      '没有生效条件时不得凭空造 chip'
    );
  });

  it('排序控件在筛选面板收起时也必须可见（它不是筛选，是列表管理的主入口）', async () => {
    // 【为什么这条要存在】筛选面板**默认是收起的**。若把排序控件只摆在面板里，
    // 用户第一屏根本看不到「能换排序」这个能力存在 —— 排序是列表管理的主入口
    // （「这些会话按什么顺序摆」），不是筛选（「把不符合条件的去掉」）。
    //
    // 【怎么判】两种形态各渲染一次，**两次**都必须有排序下拉；且收起那次里
    // 它不在面板内（面板根本没渲染）⇒ 它在工具条上。
    const collapsed = await renderFilterSection({ showFilters: false }, true);
    const expanded = await renderFilterSection({ showFilters: true }, true);

    assert.ok(
      collapsed.includes('aria-label="排序方式"'),
      '筛选面板收起时排序控件必须仍然可见（否则这个能力在第一屏不存在）'
    );
    assert.ok(
      expanded.includes('aria-label="排序方式"'),
      '筛选面板展开时排序控件也必须可见'
    );
    // 两种形态都必须只有一个排序下拉（不许渲染两份）。
    for (const [name, html] of [['收起', collapsed], ['展开', expanded]] as const) {
      const count = (html.match(/aria-label="排序方式"/g) ?? []).length;
      assert.equal(count, 1, `${name}时排序下拉必须恰好一个（实测 ${count} 个）`);
    }
  });

  it('排序控件改了之后必须落盘，失败要回滚（不许下拉显示一个没存进去的值）', () => {
    // 【为什么这条要存在】排序键存在设置里。改了 Redux 但不落盘 ⇒ 刷新后回
    // 默认值 = 用户刚做的选择无声消失；而落盘是 fail-closed 的（读不到真值
    // 就拒绝写）⇒ 写失败时必须回滚 + 出声，否则下拉显示的是一个假状态。
    assert.match(
      PANEL_SOURCE,
      /dispatchSaveSettings/,
      '排序控件必须走 dispatchSaveSettings 落盘'
    );
    assert.match(
      PANEL_SOURCE,
      /dispatch\(setSessionSort\(previous\)\)/,
      '落盘失败必须把排序键回滚到旧值'
    );
    assert.match(
      PANEL_SOURCE,
      /showToast\(/,
      '落盘失败必须告诉用户失败原因（不许静默）'
    );
  });

  it('维度 chip 必须是真 button（键盘可达）且带展开状态', async () => {
    // 【为什么这条要存在】chip 用 div 也能「点开」，但 div 不可聚焦 ⇒ 键盘
    // 用户走不到筛选器。chip 必须是 `<button>`，并带 `aria-expanded`
    // （读屏用户才知道它现在是展开还是收起）。
    const html = await renderFilterSection({ showFilters: true }, true);
    const chips = html.match(/<button[^>]*aria-expanded="[^"]*"[^>]*>/g) ?? [];
    assert.ok(chips.length >= 3, `每个维度都要有一个 chip 按钮，实测 ${chips.length} 个`);
    for (const chip of chips) {
      assert.ok(
        /type="button"/.test(chip),
        `chip 必须是 type="button" 的真按钮（不提交表单、可聚焦）：${chip}`
      );
      assert.ok(
        /aria-controls="search-filter-[^"]+"/.test(chip),
        `chip 必须用 aria-controls 指向它控制的编辑区：${chip}`
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. U-22 · 字号阶梯
// ─────────────────────────────────────────────────────────────────────────

describe('U-22 · 筛选控件的字号不得比页面其它文字小一档', () => {
  it('输入框文字 ≥ base 档，字段标签 ≥ sm 档', async () => {
    // 【为什么用「不小于」而不是「必须等于 text-base」】
    // 全局字号阶梯（审计 U-04）会整体调整，硬钉具体类名 ⇒ 阶梯一改，
    // 守卫就红，而代码其实没问题。这里读 tailwind 配置里的阶梯（从代码取
    // 事实），断言的是「不得比这一档小」。
    const { FILTER_IDS } = await import('@/components/search/SearchFilterPanel');
    const html = await renderFilterSection({ showFilters: true }, true);

    for (const dimension of ['domain', 'groupName', 'savedWithin', 'pinned'] as const) {
      const id = FILTER_IDS[dimension];
      const controlClass = classOfElement(
        html,
        new RegExp(`<(input|select)[^>]*id="${id}"[^>]*>`)
      );
      const labelClass = classOfElement(html, new RegExp(`<label[^>]*for="${id}"[^>]*>`));

      const controlPx = fontSizePxOf(controlClass);
      assert.ok(
        controlPx !== null,
        `${dimension} 控件必须显式写字号（实测 class：${controlClass}）`
      );
      assert.ok(
        controlPx >= FONT_SIZE_LADDER.base,
        `${dimension} 控件文字不得小于 base 档（${FONT_SIZE_LADDER.base}px），实测 ${controlPx}px`
      );

      const labelPx = fontSizePxOf(labelClass);
      assert.ok(
        labelPx !== null,
        `${dimension} 标签必须显式写字号（实测 class：${labelClass}）`
      );
      assert.ok(
        labelPx >= FONT_SIZE_LADDER.sm,
        `${dimension} 标签不得小于 sm 档（${FONT_SIZE_LADDER.sm}px），实测 ${labelPx}px`
      );
    }
  });
});
