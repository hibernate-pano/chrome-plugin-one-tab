// 标签行里的 URL 必须读得清（2026-10-18 round 20）。
//
// 【要防的回归类别】`.tab-item-url` 一直取 `--color-text-muted` —— 那是「提示色」的
// 亮度，不是内容墨色。URL 却是**内容**：两个标签标题相同时，用户只能靠它区分。
// 真机实测（6 套主题 × 明暗两态，dist 探针）：12 个组合里 11 个低于 AA 4.5:1 ——
//   prism 浅色 1.99、legacy 深色 2.13、legacy 浅色 2.31、奶油浅色 2.52、prism 深色 3.13、
//   claude 浅色 2.86、chrome 深色 3.28、chrome 浅色 3.31、apple 深色 3.36、apple 浅色 3.62。
// 根因是**令牌选错**（同 round 8 的搜索高亮：墨色不能取与底色同色系的强调色）。
// 现改为二级内容墨色 `--color-text-secondary`，实测 7.24–9.62:1。
//
// 【第二个坑：主题里的同值重复声明】prism.css 曾经自己写了一条
// `html[data-theme="prism"] .tab-item-url { color: var(--color-text-muted) }` ——
// 与兜底同值，但特异性更高，于是兜底改成什么都轮不到 prism。所以本守卫除了算对比度，
// 还钉住「主题文件不得自己声明 .tab-item-url 的墨色」。
//
// 【作用域查找的引号坑】主题文件混用单双引号（creamy.css 用单引号），只试一种引号会
// 静默回退成整份文件、把明暗两态读成同一个值（round 19 在 searchHighlightContrast
// 里踩到过）。这里两种都试。
//
// 阈值取 WCAG AA 正文 4.5:1 —— URL 是 12px 正文（`text-xs`），不是大字号。
// 打不开的行（`.tab-item-unopenable`）按设计要「明显弱于正常项」，但它仍是**可辨识**的
// 内容，故同样按 4.5:1 衡量（弱化交给标题删除线 + 0.85 透明度）。

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
  if (!fn) return null;
  const p = fn[1].split(',').map(v => parseFloat(v.trim()));
  if (p.length < 3 || p.some(Number.isNaN)) return null;
  return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
}

/** 半透明色叠到底色上（rgba 与 opacity 都走这里）。 */
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

/** 主题作用域查找：单双引号都试（见文件头「引号坑」）。 */
function scopeBlock(css: string, selector: string): string {
  return block(css, selector) || block(css, selector.replace(/"/g, "'"));
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

const GLOBAL = read('src/styles/global.css');

/** 兜底规则里 .tab-item-url 的墨色令牌名。 */
const urlRule = block(GLOBAL, '.tab-item-url {');
assert.ok(urlRule, 'global.css 里找不到 .tab-item-url 兜底规则');
const inkTokenName = declaration(urlRule, 'color').match(/var\((--[\w-]+)\)/)?.[1] ?? '';

/** 打不开的行：墨色令牌 + 透明度。 */
const unopenableRule = block(GLOBAL, '.tab-item-unopenable .tab-item-url');
assert.ok(unopenableRule, 'global.css 里找不到 .tab-item-unopenable 的墨色规则');
const unopenableTokenName = declaration(unopenableRule, 'color').match(/var\((--[\w-]+)\)/)?.[1] ?? '';
const unopenableOpacity = parseFloat(declaration(unopenableRule, 'opacity'));

/** 解析某个主题某明暗态下的墨色与「最差底色」。 */
function themeInk(theme: string, dark: boolean, tokenName: string, opacity: number) {
  const css = read(`src/styles/themes/${theme}.css`);
  const scope = scopeBlock(css, dark ? `html[data-theme="${theme}"].dark` : `html[data-theme="${theme}"] {`);
  assert.ok(scope, `${theme} 的${dark ? '深色' : '浅色'}作用域块找不到，守卫前提变了`);
  const resolve = (name: string) => parseColor(token(scope, name) || token(css, name));
  const ink = resolve(tokenName);
  assert.ok(ink, `${theme}/${dark ? 'dark' : 'light'} 的墨色令牌 ${tokenName} 读不到，守卫前提变了`);
  const bgPrimary = resolve('--color-bg-primary');
  assert.ok(bgPrimary, `${theme} 的 --color-bg-primary 读不到，守卫前提变了`);
  // 行底色可能是 bg-primary / bg-secondary / hover 的 bg-tertiary，且后两者在 prism 下是半透明的
  // ⇒ 逐个叠到 bg-primary 上再取**最差**的那个（行可能出现在其中任意一层上）。
  const backgrounds = ['--color-bg-primary', '--color-bg-secondary', '--color-bg-tertiary']
    .map(name => resolve(name))
    .filter((c): c is Rgb => !!c)
    .map(c => over(c, bgPrimary));
  const worst = Math.min(...backgrounds.map(bg => contrast(over({ ...ink, a: opacity }, bg), bg)));
  return { worst, ink, backgrounds, bgPrimary };
}

describe('标签行 URL：6 套主题 × 明暗两态都够读', () => {
  it('兜底墨色取二级内容墨色，不是提示色', () => {
    assert.ok(inkTokenName, '.tab-item-url 的墨色不是 var(--token)，守卫前提变了');
    assert.notEqual(inkTokenName, '--color-text-muted', '--color-text-muted 是提示色，当内容墨色用会读不清');
  });

  for (const theme of THEMES) {
    for (const dark of [false, true]) {
      it(`${theme} / ${dark ? 'dark' : 'light'}`, () => {
        const { worst, backgrounds } = themeInk(theme, dark, inkTokenName, 1);
        assert.ok(backgrounds.length >= 2, `${theme} 的底色令牌读不到，守卫前提变了`);
        assert.ok(
          worst >= 4.5,
          `${theme}/${dark ? 'dark' : 'light'} 的 URL 只有 ${worst.toFixed(2)}:1（< 4.5:1，` +
            `墨色 ${inkTokenName}）—— 12px 正文，用户要靠它区分同名标签`
        );
      });
    }
  }
});

describe('打不开的标签行：弱化但不隐身', () => {
  it('弱化靠透明度，墨色仍是同一个可读令牌', () => {
    assert.ok(unopenableTokenName, '.tab-item-unopenable 的墨色不是 var(--token)，守卫前提变了');
    assert.equal(unopenableTokenName, inkTokenName, '打不开的行不该换墨色来实现弱化（换色会掉到读不清）');
    assert.ok(
      unopenableOpacity > 0 && unopenableOpacity < 1,
      `透明度 ${unopenableOpacity} 不在 (0,1) 里：1 = 与正常项同亮度，0 = 等于隐藏`
    );
  });

  for (const theme of THEMES) {
    for (const dark of [false, true]) {
      it(`${theme} / ${dark ? 'dark' : 'light'}`, () => {
        const normal = themeInk(theme, dark, inkTokenName, 1);
        const dimmed = themeInk(theme, dark, unopenableTokenName, unopenableOpacity);
        assert.ok(
          dimmed.worst >= 4.5,
          `${theme}/${dark ? 'dark' : 'light'} 的打不开行只有 ${dimmed.worst.toFixed(2)}:1（< 4.5:1）` +
            `—— 设计要的是「可辨识但弱于正常项」，不是看不见`
        );
        assert.ok(
          dimmed.worst < normal.worst,
          `${theme}/${dark ? 'dark' : 'light'} 的打不开行与正常行同样清楚（${dimmed.worst.toFixed(2)} vs ` +
            `${normal.worst.toFixed(2)}），用户会以为它点下去能打开`
        );
      });
    }
  }
});

describe('主题文件不得自己声明 .tab-item-url 的墨色', () => {
  for (const theme of THEMES) {
    it(`${theme} 不覆盖 URL 墨色（同值重复声明会绕过兜底）`, () => {
      const css = read(`src/styles/themes/${theme}.css`);
      const offenders: string[] = [];
      for (const match of css.matchAll(/\.tab-item-url/g)) {
        const open = css.indexOf('{', match.index);
        const close = css.indexOf('}', open);
        if (open === -1 || close === -1) continue;
        const declared = declaration(css.slice(open + 1, close), 'color');
        if (declared) offenders.push(declared);
      }
      assert.deepEqual(offenders, [], `${theme}.css 里自己声明了 URL 墨色：${offenders.join(' / ')}`);
    });
  }
});
