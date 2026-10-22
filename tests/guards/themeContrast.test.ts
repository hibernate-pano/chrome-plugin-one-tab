// 主题一致性与对比度守卫（2026-10-22 审计 U-01 / U-12 / U-13 / U-14 /
// U-16 / U-17 / U-23 / U-24）。
//
// 【本文件要防的回归类别】
//
// A. **写死的品牌色回到顶栏**：同步按钮曾写死 `bg-green-100 text-green-600` 与
//    `bg-primary-100 text-primary-600`（Tailwind 的固定品牌蓝，12 套主题 × 明暗
//    下颜色完全不变），实测对比度 3.00:1 与 4.24:1 —— 都低于 AA。
//
// B. **主题令牌被改回不可读的值**：claude 浅色的 accent 在卡片底上只有 2.96:1、
//    在三级面上 2.57:1（「恢复整个会话」那颗图标几乎看不见）；prism 浅色的
//    三级文字 4.41:1。改令牌是修法，但令牌随时可能被改回去 —— 所以这里按
//    **不变量**（某两个令牌压在一起必须 ≥ 多少）来守，而不是钉某个字面量。
//
// C. **形状语言分裂**：6 套主题曾有 4 种按钮形状（主按钮 9999/8/6px，
//    图标按钮 9999/8/12px），搜索框 2 种，徽章 2 种 ⇒ 同一个产品在 6 套主题下
//    看起来像 6 个产品。
//
// D. **徽章退化成「看不见的容器」**：浅色下徽章底色与卡头底色同源（都是
//    --color-bg-tertiary），深色下更糟 —— 写死的 rgba(148,163,184,0.12)/#94a3b8
//    是另一个品牌的冷灰蓝。
//
// E. **焦点环被换回固定蓝**：`focus-visible:ring-blue-500` 把全站按 12 组逐一
//    调过的 --color-focus-ring 顶掉了。
//
// 【判据】
//   · 令牌值从**主题文件本身**读出来再算，不写死常量副本（改了实现守卫照样绿）。
//   · 文字令牌按 WCAG 2.2 正文线 4.5:1；图标 / 描边 / 焦点环按非文本对比 3:1。
//   · 半透明底色先叠到它真实所在的那一层表面上再算。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** 剥掉块注释与整行行注释后再做结构断言：注释里提到旧写法不该让守卫变红。 */
const read = (rel: string) =>
  readFileSync(resolve(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');

const THEMES = ['legacy', 'creamy', 'prism', 'claude', 'apple', 'chrome'] as const;

const TEXT_MIN = 4.5;
const ICON_MIN = 3.0;

/* ── CSS 解析 ──────────────────────────────────────────────── */

function block(css: string, selector: string): string {
  const at = css.indexOf(selector);
  if (at === -1) return '';
  const open = css.indexOf('{', at);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return '';
}

function token(css: string, name: string): string {
  const all = [...css.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))];
  return all.length ? all[all.length - 1][1].trim() : '';
}

function declaration(css: string, prop: string): string {
  for (const decl of css.split(';')) {
    const at = decl.indexOf(':');
    if (at !== -1 && decl.slice(0, at).trim() === prop) return decl.slice(at + 1).trim();
  }
  return '';
}

/** 主题选择器的引号风格不统一（creamy 用单引号），两种都要试。 */
function themedBlock(css: string, theme: string, suffix: string): string {
  return (
    block(css, `html[data-theme="${theme}"]${suffix}`) ||
    block(css, `html[data-theme='${theme}']${suffix}`)
  );
}

/* ── 颜色 ──────────────────────────────────────────────────── */

type Rgb = { r: number; g: number; b: number; a: number };

function parseColor(raw: string): Rgb | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const hex = value.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('');
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  const fn = value.match(/^rgba?\(([^)]+)\)$/i);
  if (fn) {
    const p = fn[1].split(/[,/]/).map(v => parseFloat(v.trim())).filter(n => !Number.isNaN(n));
    if (p.length < 3) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  return null;
}

/** 渐变 → 每一档色标；单色 → 单元素数组。 */
function parseStops(raw: string): Rgb[] {
  const value = String(raw ?? '').trim();
  if (!value) return [];
  if (!/gradient\(/i.test(value)) {
    const c = parseColor(value);
    return c ? [c] : [];
  }
  const inner = value.slice(value.indexOf('(') + 1, value.lastIndexOf(')'));
  const stops: Rgb[] = [];
  for (const part of inner.split(/,(?![^(]*\))/)) {
    // 注意：结尾**不能**加 \b —— ')' 后面跟空格时没有词边界，
    // 加上就会把每一档 rgba() 色标整段丢掉（渐变被当成「没有色标」，
    // 整层卡头底色直接退化成卡片底 —— prism 浅色的徽章就是这么漏判的）。
    const m = part.trim().match(/^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|transparent)/i);
    if (m) {
      const c = parseColor(m[1]);
      if (c) stops.push(c);
    }
  }
  return stops;
}

function over(fg: Rgb, bg: Rgb): Rgb {
  if (fg.a >= 1) return { ...fg, a: 1 };
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

function luminance(c: Rgb): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/* ── 一套主题在某个明暗状态下的令牌与表面 ────────────────────── */

const GLOBAL = read('src/styles/global.css');
const GLOBAL_ROOT = block(GLOBAL, ':root {');
const GLOBAL_DARK = block(GLOBAL, 'html.dark {');

interface ThemeState {
  key: string;
  tok: (name: string) => string;
  surfaces: Record<string, Rgb[]>;
}

function loadState(theme: string, dark: boolean): ThemeState {
  const css = read(`src/styles/themes/${theme}.css`);
  const darkScope = themedBlock(css, theme, '.dark');
  const lightScope = themedBlock(css, theme, ' {');

  const raw = (name: string) => {
    if (dark) {
      return (
        token(darkScope, name) ||
        token(lightScope, name) ||
        token(GLOBAL_DARK, name) ||
        token(GLOBAL_ROOT, name)
      );
    }
    // 浅色态：html.dark 那块不匹配（html 上没有 .dark），只有 :root 兜底。
    return token(lightScope, name) || token(GLOBAL_ROOT, name);
  };

  // 令牌值里可能还有 var(--x) 引用（例如 --color-card-head-bg: var(--color-bg-tertiary)）
  const tok = (name: string): string => {
    const seen = new Set<string>();
    const resolve = (value: string, depth: number): string => {
      if (!value || depth > 6) return value;
      return value.replace(
        /var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]*))?\)/gi,
        (_, name2: string, fallback?: string) => {
          if (seen.has(name2)) return fallback ? resolve(fallback, depth + 1) : '';
          seen.add(name2);
          const next = raw(name2) || (fallback ? fallback.trim() : '');
          return resolve(next, depth + 1);
        },
      );
    };
    return resolve(raw(name), 0);
  };

  const white: Rgb = { r: 255, g: 255, b: 255, a: 1 };
  const page = over(parseColor(tok('--color-bg-primary')) ?? white, white);
  const card = over(parseColor(tok('--color-bg-secondary')) ?? page, page);
  const headStops = parseStops(tok('--color-card-head-bg'));
  const cardHead = headStops.length ? headStops.map(c => over(c, card)) : [card];
  const well = over(parseColor(tok('--color-well')) ?? card, card);
  const overlay = over(parseColor(tok('--color-bg-overlay')) ?? page, page);
  const elevated = over(parseColor(tok('--color-bg-elevated')) ?? page, page);
  const tertiary = over(parseColor(tok('--color-bg-tertiary')) ?? card, card);
  const softStops = parseStops(tok('--color-accent-soft'));
  // 卡头可能是渐变 ⇒ 强调淡染要叠在**每一档**卡头色标上（取最差）。
  // 只叠第一档会漏判（prism 浅色徽章真机 4.23:1，模型却算 5.07:1）。
  const overEach = (stops: Rgb[], bases: Rgb[]) => stops.flatMap(c => bases.map(b => over(c, b)));
  const accent = parseColor(tok('--color-accent'));
  const accentHover = parseColor(tok('--color-accent-hover'));

  return {
    key: `${theme}/${dark ? 'dark' : 'light'}`,
    tok,
    surfaces: {
      page: [page],
      card: [card],
      cardHead,
      well: [well],
      overlay: [overlay],
      elevated: [elevated],
      tertiary: [tertiary],
      // 徽章的底（强调淡染）落在卡头上；同步按钮的底落在顶栏浮层上。
      accentSoft: overEach(softStops, cardHead),
      accentSoftOnOverlay: softStops.map(c => over(c, overlay)),
      accentSubtle: overEach(parseStops(tok('--color-accent-subtle')), cardHead),
      accentWash: overEach(parseStops(tok('--color-accent-wash')), cardHead),
      accent: accent ? [accent] : [],
      accentHover: accentHover ? [accentHover] : [],
    },
  };
}

const STATES: ThemeState[] = THEMES.flatMap(t => [loadState(t, false), loadState(t, true)]);

/** 一对里取最差（渐变取最差色标）。 */
function worstRatio(state: ThemeState, fgToken: string, bgName: string): number | null {
  const fg = parseColor(state.tok(fgToken));
  const bgs = state.surfaces[bgName];
  if (!fg || !bgs || !bgs.length) return null;
  return Math.min(...bgs.map(bg => contrast(fg, bg)));
}

describe('U-12/U-13/U-16：令牌压在一起必须够读（6 套主题 × 明暗两态）', () => {
  const cases: Array<{ fg: string; bg: string; min: number; what: string }> = [
    { fg: '--color-text-primary', bg: 'page', min: TEXT_MIN, what: '正文 / 页面底' },
    { fg: '--color-text-primary', bg: 'card', min: TEXT_MIN, what: '正文 / 卡片底' },
    { fg: '--color-text-primary', bg: 'cardHead', min: TEXT_MIN, what: '正文 / 卡头底' },
    { fg: '--color-text-secondary', bg: 'card', min: TEXT_MIN, what: '次级文字 / 卡片底' },
    { fg: '--color-text-secondary', bg: 'cardHead', min: TEXT_MIN, what: '次级文字 / 卡头底' },
    { fg: '--color-text-tertiary', bg: 'card', min: TEXT_MIN, what: '三级文字 / 卡片底' },
    { fg: '--color-text-muted', bg: 'cardHead', min: TEXT_MIN, what: '提示色 / 卡头底' },
    { fg: '--color-accent-text', bg: 'page', min: TEXT_MIN, what: '强调文字 / 页面底' },
    { fg: '--color-accent-text', bg: 'card', min: TEXT_MIN, what: '强调文字 / 卡片底' },
    // 数量徽章与顶栏同步按钮都读这一对（12px 小字）
    { fg: '--color-accent-text', bg: 'accentSoft', min: TEXT_MIN, what: '徽章文字 / accent-soft 底' },
    { fg: '--color-accent-text', bg: 'accentSoftOnOverlay', min: TEXT_MIN, what: '同步按钮文字 / accent-soft 底' },
    { fg: '--color-accent-text', bg: 'accentSubtle', min: TEXT_MIN, what: '强调文字 / accent-subtle 底' },
    // 主按钮实底上的墨色
    { fg: '--color-accent-fg', bg: 'accent', min: TEXT_MIN, what: '主按钮墨色 / accent 实底' },
    // 「恢复整个会话」那颗图标（非文本）
    { fg: '--color-accent', bg: 'page', min: ICON_MIN, what: '强调图标 / 页面底' },
    { fg: '--color-accent', bg: 'card', min: ICON_MIN, what: '强调图标 / 卡片底' },
    { fg: '--color-accent', bg: 'cardHead', min: ICON_MIN, what: '强调图标 / 卡头底' },
    { fg: '--color-accent', bg: 'tertiary', min: ICON_MIN, what: '强调图标 / 三级面' },
    { fg: '--color-accent-strong', bg: 'accentWash', min: ICON_MIN, what: '空态强调图标 / accent-wash 底' },
    { fg: '--color-focus-ring', bg: 'card', min: ICON_MIN, what: '焦点环 / 卡片底' },
  ];

  for (const c of cases) {
    for (const state of STATES) {
      it(`${state.key}：${c.what} ≥ ${c.min}:1`, () => {
        const ratio = worstRatio(state, c.fg, c.bg);
        assert.ok(ratio !== null, `${state.key}：${c.fg} / ${c.bg} 读不出颜色（令牌缺失？）`);
        assert.ok(
          ratio! >= c.min,
          `${state.key}：${c.fg}（${state.tok(c.fg)}）压 ${c.bg} 上只有 ${ratio!.toFixed(2)}:1 —— 低于 ${c.min}:1（${c.what}）`
        );
      });
    }
  }
});

describe('U-14：形状语言令牌在 6 套主题里都必须声明，且不再有离群值', () => {
  const ALLOWED_BTN = new Set(['8px', '10px']);
  const ALLOWED_ICON = new Set(['8px']);

  for (const theme of THEMES) {
    for (const dark of [false, true]) {
      it(`${theme}/${dark ? 'dark' : 'light'}：声明 --radius-btn 与 --radius-btn-icon`, () => {
        const css = read(`src/styles/themes/${theme}.css`);
        const scope = themedBlock(css, theme, dark ? '.dark' : ' {');
        assert.ok(scope, `${theme}.css 里找不到 ${dark ? '深色' : '浅色'}作用域块`);
        const btn = token(scope, '--radius-btn');
        const icon = token(scope, '--radius-btn-icon');
        assert.ok(btn, `${theme}/${dark ? 'dark' : 'light'}：没有声明 --radius-btn —— 形状会退回 global 的兜底值，主题之间就又不一致了`);
        assert.ok(icon, `${theme}/${dark ? 'dark' : 'light'}：没有声明 --radius-btn-icon`);
        assert.ok(
          ALLOWED_BTN.has(btn),
          `--radius-btn = "${btn}"：允许的圆角只有 ${[...ALLOWED_BTN].join(' / ')}（9999px 药丸、6px、12px 都是离群值 —— 6 套主题曾有 4 种形状语言）`
        );
        assert.ok(
          ALLOWED_ICON.has(icon),
          `--radius-btn-icon = "${icon}"：图标按钮的圆角必须全仓统一（允许 ${[...ALLOWED_ICON].join(' / ')}；曾出现 9999px 与 12px）`
        );
      });
    }
  }

  it('6 套主题的 --radius-btn-icon 完全一致（同一形状语言）', () => {
    const values = new Set<string>();
    for (const theme of THEMES) {
      const css = read(`src/styles/themes/${theme}.css`);
      values.add(token(themedBlock(css, theme, ' {'), '--radius-btn-icon'));
      values.add(token(themedBlock(css, theme, '.dark'), '--radius-btn-icon'));
    }
    assert.equal(values.size, 1, `--radius-btn-icon 在 6 套主题里出现了多个取值：${[...values].join(' / ')}`);
  });

  it('主题文件里不得再有 9999px 的按钮圆角（药丸/正圆是「另一个产品的皮肤」）', () => {
    for (const theme of THEMES) {
      const css = read(`src/styles/themes/${theme}.css`);
      // 只查「按钮/徽章」类规则：搜索框本来就该是药丸（--radius-full），
      // 把 .search-input 也算进来会把「正确的药丸」误判成离群值。
      const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
      for (const [, selector, body] of rules) {
        if (!/\b(btn|button|badge|count)\b/.test(selector)) continue;
        for (const m of body.matchAll(/border-radius:\s*([^;]+);/g)) {
          assert.doesNotMatch(
            m[1],
            /9999px/,
            `${theme}.css 的「${selector.trim()}」里还有 border-radius: ${m[1]} —— 药丸/正圆必须改由 --radius-btn / --radius-btn-icon 给`
          );
        }
      }
    }
  });

  it('global.css 的 .btn / .btn-icon 读形状令牌', () => {
    assert.match(
      declaration(block(GLOBAL, '.btn {'), 'border-radius'),
      /var\(--radius-btn\)/,
      '.btn 的圆角必须读 --radius-btn（否则主题改了形状令牌也不生效）'
    );
    const iconRule = GLOBAL.match(/\.btn-icon\s*\{[^}]*border-radius:\s*var\(--radius-btn-icon\)[^}]*\}/);
    assert.ok(iconRule, '.btn-icon 必须有一条读 --radius-btn-icon 的规则');
  });

  it('搜索框在 6 套主题里都是药丸（legacy 曾是唯一的矩形例外）', () => {
    for (const theme of THEMES) {
      const css = read(`src/styles/themes/${theme}.css`);
      const rule = themedBlock(css, theme, ' .search-input');
      if (!rule) continue; // 没覆盖的主题吃 global 的 --radius-search（药丸）
      assert.match(
        declaration(rule, 'border-radius'),
        /var\(--radius-full\)|9999px/,
        `${theme} 的 .search-input 不是药丸 —— 6 套主题的搜索框必须是同一个形状`
      );
    }
  });
});

describe('U-13/U-16：徽章不许退化成「看不见的容器」，也不许写死颜色', () => {
  it('global.css 的 .tab-group-count 读强调族令牌，不再用三级面底 + 写死冷灰蓝', () => {
    const rule = block(GLOBAL, '.tab-group-count {');
    assert.ok(rule, 'global.css 里找不到 .tab-group-count');
    assert.doesNotMatch(
      rule,
      /#94a3b8|148,\s*163,\s*184/,
      '.tab-group-count 又出现了写死的 slate 色（深色下是另一个品牌的冷灰蓝，claude 暖黑 / apple / chrome 下色相不属于主题）'
    );
    assert.match(
      declaration(rule, 'background'),
      /var\(--color-accent-soft\)/,
      '徽章底色必须读 --color-accent-soft —— 读 --color-bg-tertiary 会与卡头底同源，徽章的容器等于不存在'
    );
    assert.match(
      declaration(rule, 'color'),
      /var\(--color-accent-text\)/,
      '徽章文字必须读 --color-accent-text（--color-accent 是填充色，当文字用时在浅底上只有 2.6–3.0:1）'
    );
    assert.match(
      declaration(rule, 'border-radius'),
      /var\(--radius-full\)/,
      '徽章必须是药丸（legacy 曾是 4px 圆角，与其余主题不同形）'
    );
  });

  it('6 套主题文件里，徽章/强调相关的规则不得出现写死的颜色值', () => {
    // 主题文件里的颜色只允许出现在**令牌定义**里（--color-accent: #xxx）；
    // 组件规则（.badge-accent / .tab-group-count / .tab-group-action-accent）
    // 只能引用令牌 —— 否则主题一改色，写死的那处就漏。
    for (const theme of THEMES) {
      const css = read(`src/styles/themes/${theme}.css`);
      const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
      for (const [, selector, body] of rules) {
        if (!/badge-accent|tab-group-count|tab-group-action-accent/.test(selector)) continue;
        const literals = [...body.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi)].map(m => m[0]);
        assert.equal(
          literals.length,
          0,
          `${theme}.css 的「${selector.trim()}」里还有写死的颜色 ${literals.join(' / ')} —— 语义位必须读主题令牌`
        );
      }
    }
  });

  it('legacy 的卡头底色不再写死 #f9fafb / #1f2937（U-24）', () => {
    const css = read('src/styles/themes/legacy.css');
    const rule = themedBlock(css, 'legacy', ' .tab-group-header');
    assert.ok(rule, 'legacy.css 里找不到 .tab-group-header 覆盖');
    const literals = [...rule.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi)].map(m => m[0]);
    assert.equal(literals.length, 0, `legacy 的卡头底色里还有写死的颜色 ${literals.join(' / ')}`);
  });
});

describe('U-24：--color-card-head-bg 必须在兜底与 6 套主题里各自声明', () => {
  it('global.css 的 :root 与 html.dark 各有一个默认值', () => {
    assert.ok(
      token(GLOBAL_ROOT, '--color-card-head-bg'),
      'global.css 的 :root 缺 --color-card-head-bg —— 没选主题时卡头会没有底色'
    );
    assert.ok(
      token(GLOBAL_DARK, '--color-card-head-bg'),
      'global.css 的 html.dark 缺 --color-card-head-bg'
    );
  });

  for (const theme of THEMES) {
    for (const dark of [false, true]) {
      it(`${theme}/${dark ? 'dark' : 'light'}：声明 --color-card-head-bg`, () => {
        const css = read(`src/styles/themes/${theme}.css`);
        const scope = themedBlock(css, theme, dark ? '.dark' : ' {');
        assert.ok(
          token(scope, '--color-card-head-bg'),
          `${theme}/${dark ? 'dark' : 'light'} 没有声明 --color-card-head-bg —— 「卡头是不是一个区块」必须是每个主题自己声明的事`
        );
      });
    }
  }

  it('.tab-group-header 读 --color-card-head-bg（否则上面这些令牌白给）', () => {
    const rule = block(GLOBAL, '.tab-group-header {');
    assert.ok(rule, 'global.css 里找不到 .tab-group-header');
    assert.match(
      declaration(rule, 'background'),
      /var\(--color-card-head-bg\)/,
      '.tab-group-header 必须读 --color-card-head-bg'
    );
  });
});

describe('U-17：涟漪的圆角跟随按钮（正圆按钮里不该出现方涟漪）', () => {
  it('.btn-icon::after 用 border-radius: inherit', () => {
    const css = read('src/styles/micro-interactions.css');
    const rule = css.match(/\.btn-icon::after\s*\{([^}]*)\}/);
    assert.ok(rule, 'micro-interactions.css 里找不到 .btn-icon::after');
    assert.match(
      rule[1],
      /border-radius:\s*inherit/,
      '涟漪的圆角必须 inherit 按钮自己的圆角（写死 0.5rem 时，chrome 的正圆按钮里会出现一个方形涟漪）'
    );
  });
});

describe('U-01/U-23：顶栏与设置页不得再写死品牌色', () => {
  /** 顶栏那一片（模态框之前）；模态框里的 slate 灰阶是另一件事，不在本次范围。 */
  const headerOf = (src: string) => src.slice(0, src.indexOf('createPortal('));

  it('SyncButton 的上传/下载按钮读主题令牌，不含固定品牌色', () => {
    const src = read('src/components/sync/SyncButton.tsx');
    assert.doesNotMatch(
      src,
      /bg-green-\d+|bg-primary-\d+|text-green-\d+|text-primary-\d+/,
      'SyncButton 又出现了写死的 Tailwind 绿/蓝 —— 那是固定品牌色，12 套主题 × 明暗下颜色完全不变（对比度 3.00:1 / 4.24:1，都低于 AA）'
    );
    assert.match(src, /theme-accent-soft/, '上传/下载按钮的底色应走 theme-accent-soft（读 --color-accent-soft）');
    assert.match(src, /theme-accent-text/, '上传/下载按钮的文字应走 theme-accent-text（读 --color-accent-text）');
  });

  it('顶栏区域不得再出现写死的灰阶（进度条轨道曾写死 bg-gray-200 / dark:bg-slate-700）', () => {
    const src = read('src/components/sync/SyncButton.tsx');
    const header = headerOf(src);
    assert.ok(header.length > 0, 'SyncButton 里找不到顶栏区域（模态框锚点）');
    assert.doesNotMatch(
      header,
      /\b(?:bg|text|border)-(?:gray|slate|zinc|neutral|stone)-\d+/,
      '顶栏又出现了写死的灰阶 —— 固定灰在暖色主题（creamy/claude）里色相不属于主题；进度条轨道应读 --color-bg-tertiary'
    );
  });

  it('两颗同步按钮的圆角必须走主题的形状令牌（不许写死 Tailwind 圆角）', () => {
    const src = read('src/components/sync/SyncButton.tsx');
    // 只看两颗按钮自己的 className：进度条用 rounded-full 是对的（药丸形的进度条），
    // 把它一起禁掉就成了假阳性。
    const classOf = (anchor: string) => {
      const at = src.indexOf(anchor);
      assert.ok(at !== -1, `SyncButton 里找不到 ${anchor}`);
      const m = /className=\{`([^`]*)`\}/.exec(src.slice(at, at + 900));
      assert.ok(m, `找不到 ${anchor} 对应按钮的 className`);
      return m[1];
    };
    const classes = ['onClick={handleUpload}', 'onClick={handleDownload}'].map(classOf);

    // ① 写死的 Tailwind 圆角 = 固定 px，不跟主题的形状令牌走。
    //    （原先这里是 rounded-md=6px，在 6 套主题里是唯一的离群形状。）
    for (const [i, cls] of classes.entries()) {
      assert.doesNotMatch(
        cls,
        /\brounded-(?!full\b)[\w-]+/,
        `第 ${i + 1} 颗同步按钮又写死了 Tailwind 圆角（${cls}）—— 固定 px 不跟主题的形状令牌走，` +
          `同一排按钮在 6 套主题下会变成 6 个产品`
      );
    }

    // ② 圆角必须接在 --radius-btn 上。「哪些类接在 --radius-btn 上」是从
    //    global.css 里**读**出来的，不钉类名字面量 —— 改了类名守卫照样绿。
    const carriers = [
      ...GLOBAL.matchAll(/\.([\w-]+)\s*\{[^}]*border-radius:\s*var\(--radius-btn\)/g),
    ].map(m => m[1]);
    assert.ok(carriers.length, 'global.css 里没有任何类把圆角接到 --radius-btn 上');
    // 类名要**逐个 token** 比：'-' 是词边界字符，`\bbtn\b` 会命中
    // `theme-radius-btn` 里的 "btn" ⇒ 用正则搜等于没搜（变异自证 M9）。
    const tokensOf = (cls: string) => cls.split(/\s+/).filter(Boolean);
    const used = classes.map(cls => carriers.filter(c => tokensOf(cls).includes(c)));
    for (const [i, u] of used.entries()) {
      assert.ok(
        u.length > 0,
        `第 ${i + 1} 颗同步按钮的圆角没有走 --radius-btn（${classes[i]}）—— ` +
          `全站按钮的形状语言由这个令牌决定，脱离它就是离群形状`
      );
    }

    // ③ 两颗按钮必须是同一种形状。
    assert.deepEqual(
      used[0],
      used[1],
      `上传与下载的圆角机制不一致（${used[0].join('/')} / ${used[1].join('/')}）—— 同一排按钮必须是同一种形状`
    );
  });

  it('SyncButton 的上传与下载用不同的图标区分（形状/图标不同才认得出）', () => {
    const src = read('src/components/sync/SyncButton.tsx');
    // 锚在 onClick 上：handleUpload 这个名字第一次出现是**函数定义**，
    // 不是按钮（按定义切会切到两段不相干的代码，判据就没有检测力了）。
    const up = src.indexOf('onClick={handleUpload}');
    const down = src.indexOf('onClick={handleDownload}');
    assert.ok(up !== -1 && down !== -1 && down > up, '找不到顶栏的上传/下载按钮');
    const upload = src.slice(up, down);
    const download = src.slice(down, down + 1500);
    const path = (s: string) => [...s.matchAll(/ d="([^"]+)"/g)].map(m => m[1]).join('|');
    assert.ok(path(upload) && path(download), '找不到两个按钮的图标 path');
    assert.notEqual(path(upload), path(download), '上传与下载必须用不同的图标');
  });

  it('ThemeStyleSelector 不再用 Tailwind 的固定蓝焦点环', () => {
    const src = read('src/components/layout/ThemeStyleSelector.tsx');
    assert.doesNotMatch(
      src,
      /focus-visible:ring-blue-\d+|focus-visible:outline-none/,
      'ThemeStyleSelector 又把焦点环换成了 Tailwind 固定蓝 —— 全站那套 --color-focus-ring 是按 12 组逐一调过的'
    );
    assert.doesNotMatch(
      src,
      /ring-blue-\d+/,
      'ThemeStyleSelector 里还有写死的蓝 ring —— 主题选择器画出的选中圈不该是别的产品的蓝'
    );
  });
});

/* ── L-3：主题风格预览 ────────────────────────────────────────── */

describe('L-3：主题预览必须读该主题自己的令牌，并跟着明暗模式变', () => {
  const SELECTOR = read('src/components/layout/ThemeStyleSelector.tsx');

  /** 取 ThemePreviewCard 这个组件的源码（注释已剥）。 */
  const previewSource = (): string => {
    const m = /const ThemePreviewCard[\s\S]*?\n\);/.exec(SELECTOR);
    assert.ok(m, 'ThemeStyleSelector 里找不到 ThemePreviewCard');
    return m[0];
  };

  /** 取「选择器里含 marker 的那条规则」的选择器文本（主题文件里令牌块都在顶层）。 */
  const ruleSelector = (css: string, marker: string): string => {
    const at = css.indexOf(marker);
    if (at === -1) return '';
    const lineStart = css.lastIndexOf('\n', at) + 1;
    const brace = css.indexOf('{', at);
    if (brace === -1) return '';
    return css.slice(lineStart, brace).trim();
  };

  it('预览里不出现写死的色值（颜色一律走主题令牌）', () => {
    const preview = previewSource();
    // 2026-10-22 审计 L-3：预览原先画的是 6 套主题各 4 个写死的浅色 hex，
    // 切到暗色模式它还是浅色的 —— 用户看到的不是自己正在用的界面。
    assert.doesNotMatch(
      preview,
      /#[0-9a-f]{3,8}\b|rgba?\(/i,
      '主题预览里又出现了写死的色值 —— 预览必须是「这个主题的令牌」画出来的，不是写死的浅色块'
    );
    assert.doesNotMatch(
      preview,
      /\b(?:bg|text|border|from|to|via)-(?:gray|slate|zinc|neutral|stone|blue|red|green|amber|yellow|pink|purple|indigo)-?\d+/,
      '主题预览里又出现了写死的 Tailwind 调色板 —— 固定色不跟主题走'
    );
    // bg-white / text-white / text-black 这一档**不带数字**，上面那条正则抓不到，
    // 单独钉（它们同样是固定色：白底在暗色模式下是块白板）。
    assert.doesNotMatch(
      preview,
      /\b(?:bg|text|border|from|to|via)-(?:white|black)\b/,
      '主题预览里又出现了写死的黑白 —— 白底在暗色模式下是一块白板'
    );
    assert.doesNotMatch(
      SELECTOR,
      /previewColors/,
      'previewColors 又回来了 —— 那是 6 套主题各 4 个写死 hex 的旧预览色'
    );
  });

  it('预览必须自带 data-theme={主题 id}，否则读不到「那个主题」的令牌', () => {
    assert.match(
      previewSource(),
      /data-theme=\{option\.value\}/,
      '预览元素必须带上它自己的主题 id —— 主题令牌平时只挂在 html 上，' +
        '预览别的主题时读不到它的颜色'
    );
  });

  it('预览的颜色必须来自主题工具类（不是自己画一套）', () => {
    const utilities = [...previewSource().matchAll(/\btheme-[a-z-]+/g)].map(m => m[0]);
    assert.ok(
      utilities.length >= 3,
      `预览几乎没有用到主题工具类（只有 ${utilities.join('/')}）—— 颜色不会跟主题走`
    );
  });

  it('主题色圆点的底色与墨色都必须来自主题令牌（不许写死）', () => {
    // 圆点是「这个主题是什么颜色」的唯一标识：底色读**该主题自己的**
    // --color-accent（圆点自带 data-theme 作用域），墨色读 --color-accent-fg
    // （6 套主题都保证它在 accent 上 ≥4.5:1）。
    // · 写死品牌色 ⇒ 暗色模式下的圆点是一块比背景还暗的脏色；
    // · 写死白字 ⇒ creamy 那种浅棕底上只有 2.23:1（勾完全看不见）。
    assert.match(
      SELECTOR,
      /var\(--color-accent\b/,
      '主题色圆点的底色必须读该主题自己的 --color-accent（靠 data-theme 作用域拿到）'
    );
    assert.match(
      SELECTOR,
      /var\(--color-accent-fg/,
      '主题色圆点的墨色必须读 --color-accent-fg —— 写死的白字在浅色强调底上完全看不见'
    );
    assert.doesNotMatch(
      SELECTOR,
      /color:\s*['"]#/,
      '主题色圆点的墨色又写死了 —— 固定色不跟主题走'
    );
  });

  it('主题令牌必须同时挂在 html 作用域与预览作用域上', () => {
    // 选择器列表要按逗号**拆成一项一项**比，不能用 includes：
    // `html[data-theme="x"]` 这个串本身就**包含** `[data-theme="x"]`，
    // 用 includes 判会永远为真 —— 变异自证 M6（把预览作用域删掉）就是这么漏掉的。
    const parts = (sel: string) => sel.split(',').map(s => s.trim());

    for (const theme of THEMES) {
      const css = read(`src/styles/themes/${theme}.css`);
      const q = css.includes(`html[data-theme='${theme}']`) ? "'" : '"';
      const attr = `[data-theme=${q}${theme}${q}]`;

      // 浅色块：选择器列表里既要能挂 html（应用本体），也要能挂预览元素。
      const lightSel = ruleSelector(css, `html[data-theme=${q}${theme}${q}]`);
      assert.ok(lightSel, `${theme}：找不到主题令牌块`);
      assert.ok(
        parts(lightSel).includes(attr),
        `${theme}：令牌块只挂在 html 上（${lightSel}）—— 设置页预览别的主题时读不到它的颜色`
      );
      // 别的守卫（audit20261019ThemeAndPromise / Round2 等）用
      // `html[data-theme="x"] {` 这个**字面量**定位主题块 ⇒ 必须保留。
      assert.ok(
        css.includes(`html[data-theme=${q}${theme}${q}] {`),
        `${theme}：主题令牌块必须保留 html[data-theme=...] { 的写法（仓库里好几个守卫靠它定位）`
      );

      // 深色块：预览元素必须能在 html.dark 下拿到本主题的深色取值。
      const darkSel = ruleSelector(css, `html.dark ${attr}`);
      assert.ok(darkSel, `${theme}：找不到主题令牌块的深色态`);
      const darkPreviewPart = parts(darkSel).find(p => p.endsWith(attr) && p.includes('.dark'));
      assert.ok(
        darkPreviewPart,
        `${theme}：深色令牌块必须同时挂在 html.dark 与预览作用域上（现在是 ${darkSel}）—— ` +
          `否则预览在暗色模式下不变`
      );
    }
  });

  it('每套主题的预览在明暗两态下必须真的不一样', () => {
    for (const theme of THEMES) {
      const css = read(`src/styles/themes/${theme}.css`);
      const light = themedBlock(css, theme, ' {');
      const dark = themedBlock(css, theme, '.dark');
      assert.ok(light && dark, `${theme}：找不到明/暗两块令牌`);
      // 预览画的就是这几样：卡片底、标题墨色、强调条。
      for (const name of ['--color-bg-secondary', '--color-text-secondary', '--color-accent']) {
        const l = token(light, name);
        const d = token(dark, name);
        assert.ok(l && d, `${theme}：${name} 在明/暗两块里必须都有取值（${l} / ${d}）`);
        assert.notEqual(
          l,
          d,
          `${theme}：${name} 明暗两态相同（${l}）—— 切到暗色模式时预览不会变，L-3 的判据就废了`
        );
      }
    }
  });
});
