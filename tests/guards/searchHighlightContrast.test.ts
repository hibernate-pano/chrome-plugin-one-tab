// 搜索高亮的墨色/底色必须形成足够对比（2026-10-18 round 8）。
//
// 【要防的回归类别】同一个 `.search-highlight` 在仓里有 4 处实现：global.css 的基础
// 规则、animations.css 的写死蓝色、以及 legacy / creamy / prism 三套主题各自的覆盖。
// 覆盖是**可选的装饰**，兜底才是安全边界 —— 新加的 claude / apple / chrome 三套主题
// 没有自己的覆盖，于是落到兜底上。而兜底原本是「accent 墨 + accent-subtle 底」，
// 这对颜色本身就只有 3–4:1（accent 与 accent-subtle 是同色系的两个明度），
// 真机实测命中词只有 2.31:1（claude 浅色）/ 2.61:1（apple 深色）—— 用户搜出结果却
// 看不出命中的是哪几个字。prism 的覆盖犯了同一个错（用 var(--color-accent) 当墨色，3.1:1）。
//
// 本守卫按主题逐一算对比度：有覆盖用覆盖，没覆盖用基础规则；rgba 底色分别叠在
// bg-primary / bg-secondary 上取**较差**的那个（卡片底色在两者之间）。
// 阈值取 WCAG AA 正文线 4.5:1 —— 命中词是 14px 正文，不是大字号。
//
// 另一个不变量：animations.css 只管「淡入」，不得再写死颜色。它原本把底色从
// rgba(37,99,235,.32) 呼吸到 .18，于是 legacy / creamy 的琥珀色高亮在首帧会闪一下蓝。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');

const THEMES = ['legacy', 'creamy', 'prism', 'claude', 'apple', 'chrome'] as const;

type Rgb = { r: number; g: number; b: number; a: number };

function parseColor(raw: string): Rgb | null {
  const value = raw.trim();
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map(c => c + c).join('') : hex[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  const fn = value.match(/^rgba?\(([^)]+)\)$/i);
  if (fn) {
    const p = fn[1].split(',').map(v => parseFloat(v.trim()));
    if (p.length < 3 || p.some(Number.isNaN)) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  return null;
}

function over(fg: Rgb, bg: Rgb): Rgb {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

function luminance(c: Rgb): number {
  const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** 取出某个选择器的声明块（该选择器在本仓 CSS 里都是单块、单行选择器）。 */
function block(css: string, selector: string): string {
  const at = css.indexOf(selector);
  if (at === -1) return '';
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return open === -1 || close === -1 ? '' : css.slice(open + 1, close);
}

/** 单个 CSS 变量的值（同一文件内后定义者胜，与浏览器相等）。 */
function token(css: string, name: string): string {
  const all = [...css.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))];
  return all.length ? all[all.length - 1][1].trim() : '';
}

/** 取声明块里某条属性的值（按属性名精确匹配 —— `background-color` 里也含 `color`）。 */
function declaration(blockCss: string, prop: string): string {
  for (const decl of blockCss.split(';')) {
    const at = decl.indexOf(':');
    if (at !== -1 && decl.slice(0, at).trim() === prop) return decl.slice(at + 1).trim();
  }
  return '';
}

/** 声明里的颜色候选：单色取一个，渐变取全部色标（逐个都要够对比）。 */
function colorsIn(declaration: string): Rgb[] {
  const found = declaration.match(/#[0-9a-fA-F]{3,6}\b|rgba?\([^)]*\)/g) ?? [];
  return found.map(parseColor).filter((c): c is Rgb => !!c);
}

const GLOBAL = read('src/styles/global.css');
const ANIMATIONS = read('src/styles/animations.css');

/** 基础规则的底色/墨色令牌（global.css 里不带主题前缀的那条）。 */
const baseRule = block(GLOBAL, '.search-highlight {');
assert.ok(baseRule, 'global.css 里找不到 .search-highlight 基础规则');

describe('搜索高亮：6 套主题 × 明暗两态都够对比', () => {
  for (const theme of THEMES) {
    const css = read(`src/styles/themes/${theme}.css`);

    for (const dark of [false, true]) {
      it(`${theme} / ${dark ? 'dark' : 'light'}`, () => {
        const scope = block(css, dark ? `html[data-theme="${theme}"].dark` : `html[data-theme="${theme}"] {`);
        const scopeCss = scope || css;
        const bgPrimary = parseColor(token(scopeCss, '--color-bg-primary') || token(css, '--color-bg-primary'));
        const bgSecondary = parseColor(token(scopeCss, '--color-bg-secondary') || token(css, '--color-bg-secondary'));
        assert.ok(bgPrimary && bgSecondary, `${theme} 的底色令牌读不到，守卫前提变了`);

        // 主题自己的覆盖（legacy / creamy / prism 有；claude / apple / chrome 没有）
        const own = block(
          css,
          dark ? `html[data-theme="${theme}"].dark .search-highlight` : `html[data-theme="${theme}"] .search-highlight`
        );

        let ink: Rgb | undefined;
        if (own) {
          const resolved = declaration(own, 'color').replace(
            /var\((--[\w-]+)\)/g,
            (_, name: string) => token(scopeCss, name) || token(css, name)
          );
          ink = colorsIn(resolved)[0];
        } else {
          const tokenName = declaration(baseRule, 'color').match(/var\((--[\w-]+)\)/)?.[1] ?? '';
          ink = parseColor(token(scopeCss, tokenName) || token(css, tokenName)) ?? undefined;
        }
        assert.ok(ink, `${theme}/${dark ? 'dark' : 'light'} 的墨色解析不出来，守卫前提变了`);

        const tint = own
          ? colorsIn(declaration(own, 'background-color') || declaration(own, 'background'))[0]
          : parseColor(token(scopeCss, '--color-accent-subtle'));
        assert.ok(tint, `${theme}/${dark ? 'dark' : 'light'} 的高亮底色解析不出来，守卫前提变了`);

        const worst = [bgPrimary as Rgb, bgSecondary as Rgb]
          .map(bg => Math.round(contrast(over(ink, over(tint, bg)), over(tint, bg)) * 100) / 100)
          .sort((a, b) => a - b)[0];

        assert.ok(
          worst >= 4.5,
          `${theme}/${dark ? 'dark' : 'light'} 命中词只有 ${worst}:1（< 4.5:1）—— ` +
            `墨色须取深/浅墨（如 --color-text-primary），不能与底色同色系`
        );
      });
    }
  }
});

describe('animations.css 只管淡入，不再写死颜色', () => {
  it('高亮规则与关键帧里没有写死的蓝色', () => {
    const at = ANIMATIONS.indexOf('@keyframes highlight-enter');
    assert.ok(at !== -1, '找不到高亮淡入动画（detail 不是可省的）');
    const ruleAt = ANIMATIONS.indexOf('.search-highlight', at);
    assert.ok(ruleAt !== -1, '找不到高亮规则');
    const section = ANIMATIONS.slice(at, ANIMATIONS.indexOf('}', ruleAt) + 1);
    assert.doesNotMatch(
      section,
      /#2563eb|rgba\(37, 99, 235|rgba\(59, 130, 246/,
      '写死的蓝底会在琥珀主题里闪一下蓝，也会让没覆盖的主题落到蓝底上'
    );
  });
});
