// 按钮焦点环必须画在按钮外面（2026-10-18 round 13）。
//
// 【本文件要防的回归类别】`.btn:focus-visible` 原本是
//   `outline: none; box-shadow: 0 0 0 2px var(--color-accent)`
// 而 `.btn-primary` 的底色**就是** `var(--color-accent)`：
// 环与填充同色、且 `box-shadow` 的 spread 紧贴边框盒 ⇒ 像素上只表现为
// 「按钮大了一圈」，形状略变，而不是「这里有一圈焦点环」。
// 真机实测（改前 vs 改后，同一按钮同一主题，3 倍缩放截图）：
//   改前 claude/light 主按钮聚焦：毫无焦点痕迹（computed outline-style: none）；
//   改后：按钮外出现一圈由页面底色隔开的焦点环。
// 键盘用户因此在 claude / apple / chrome 三套主题下完全看不出焦点在哪
// （WCAG 2.4.7 Focus Visible 失败）。legacy / creamy / prism 三套主题各自有
// `:focus-visible` 覆盖（outline + outline-offset），所以它们没暴露这个毛病。
//
// 【判据为什么是「有正 offset」+「环色对页面底色的对比度」】
// 环一旦被 offset 推到按钮外面，环与填充之间就隔了一条页面底色 —— 视觉上
// 无论环色是否等于按钮底色都能分辨（这正是三套老主题的做法）。
// 于是需要保证的是「环色 vs 页面底色 ≥ 3:1」（WCAG 2.2 非文本对比），
// 它才是可读的那一环。反之若 offset = 0，环就贴在填充上、与填充同色时不可见 ——
// 本守卫用「必须声明正 offset」把那种写法挡在门外。
//
// 注：图层叠色/对比度算法与 tests/guards/searchHighlightContrast.test.ts 同一套。

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

function luminance(c: Rgb): number {
  const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function block(css: string, selector: string): string {
  const at = css.indexOf(selector);
  if (at === -1) return '';
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return open === -1 || close === -1 ? '' : css.slice(open + 1, close);
}

/** 主题选择器的引号风格不统一（creamy 用单引号），两种都要试。 */
function themedBlock(css: string, theme: string, suffix: string): string {
  return block(css, `html[data-theme="${theme}"]${suffix}`) || block(css, `html[data-theme='${theme}']${suffix}`);
}

function token(css: string, name: string): string {
  const all = [...css.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))];
  return all.length ? all[all.length - 1][1].trim() : '';
}

function declaration(blockCss: string, prop: string): string {
  for (const decl of blockCss.split(';')) {
    const at = decl.indexOf(':');
    if (at !== -1 && decl.slice(0, at).trim() === prop) return decl.slice(at + 1).trim();
  }
  return '';
}

const GLOBAL = read('src/styles/global.css');
const BTN_FOCUS = block(GLOBAL, '.btn:focus-visible');
assert.ok(BTN_FOCUS, 'global.css 里找不到 .btn:focus-visible（兜底规则被删了？）');

describe('按钮焦点环：兜底规则必须把环画在按钮外面', () => {
  it('兜底用 outline + 正 offset，而不是贴边的 box-shadow', () => {
    const offset = parseFloat(declaration(BTN_FOCUS, 'outline-offset'));
    assert.ok(Number.isFinite(offset) && offset > 0,
      `outline-offset 必须是正数（当前 ${declaration(BTN_FOCUS, 'outline-offset')}）：offset=0 时环贴在按钮填充上，与填充同色就完全看不见`);
    assert.match(declaration(BTN_FOCUS, 'outline'), /solid|auto/,
      '必须有一条实际画出来的 outline（outline: none + 贴边 box-shadow 就是本次修的形态）');
    assert.doesNotMatch(BTN_FOCUS, /outline:\s*none/,
      'outline: none 会让浏览器默认焦点环也不出现 ⇒ 主按钮彻底没有焦点指示');
  });

  it('.btn-primary 的填充色就是 accent（这正是环必须 offset 的原因）', () => {
    // ⚠️ 不能用 block(GLOBAL, '.btn-primary')：文件里 `.btn-primary,`（选择器列表）
    // 比真正的规则更早出现，会取到别的块。这里按「声明块里含 background-color」
    // 找那条真正的规则。
    const at = GLOBAL.indexOf('.btn-primary {');
    assert.ok(at !== -1, '找不到 .btn-primary 基础规则');
    const primary = GLOBAL.slice(GLOBAL.indexOf('{', at) + 1, GLOBAL.indexOf('}', at));
    const bg = declaration(primary, 'background-color');
    const focusColor = declaration(BTN_FOCUS, 'outline').match(/^[^\s]+\s+[^\s]+\s+(.+)$/)?.[1]?.trim() ?? '';
    assert.match(bg, /var\(--color-accent\)/, '.btn-primary 底色应当仍是 accent');
    assert.notEqual(
      focusColor,
      'var(--color-accent)',
      '环色不能取 --color-accent：它就是按钮填充色，且作为墨色对比度不足（claude 浅色只有 2.69:1）',
    );
    assert.match(focusColor, /var\(--color-focus-ring\)/,
      '环色取专用的焦点环令牌 --color-focus-ring（2026-10-20 新增：6 套主题 × 明暗都必须显式定义它，'
      + '否则某个主题忘了定义就会掉成浏览器默认近黑色。各主题取值与其 --color-accent-text 相同）');
  });

  it('.btn 里不得再有 focus-visible:outline-none（它会与兜底规则同特异性抢声明）', () => {
    const btn = block(GLOBAL, '.btn {');
    assert.doesNotMatch(
      btn,
      /focus-visible:outline-none/,
      'Tailwind 的 outline-none 会展开成 `outline: 2px solid transparent`，与兜底规则同特异性、靠源码顺序决定胜负 —— 一旦顺序变化焦点环就变透明',
    );
  });
});

describe('焦点环颜色 vs 页面底色：6 套主题 × 明暗都够对比', () => {
  // 兜底环色**从规则本身读出来**（`outline: 2px solid var(--x)` 里的 --x），
  // 不写死常量 —— 写死的话守卫就只是在钉一个副本，改坏了规则也照样绿。
  // 这与 round 8 的 searchHighlightContrast 同一口径：有覆盖用覆盖、没覆盖用兜底。
  const fallbackVar = declaration(BTN_FOCUS, 'outline').match(/var\((--[\w-]+)\)/)?.[1] ?? '';
  assert.ok(fallbackVar, '兜底规则里找不到 var() 形式的环色令牌');

  for (const theme of THEMES) {
    const css = read(`src/styles/themes/${theme}.css`);

    for (const dark of [false, true]) {
      it(`${theme} / ${dark ? 'dark' : 'light'}`, () => {
        const scope = themedBlock(css, theme, dark ? '.dark' : ' {');
        const scopeCss = scope || css;
        // 令牌查找要能回落到 global.css 的默认定义 —— 例如 --color-accent-text
        // 只在 claude/apple/chrome 与全局定义，creamy/prism 没有自己的那份。
        const tok = (name: string) => token(scopeCss, name) || token(css, name) || token(GLOBAL, name);

        const themeOverride = themedBlock(css, theme, dark ? '.dark :focus-visible' : ' :focus-visible');
        // 深色覆盖可能只写 outline-color（legacy 就是），所以两种都要看
        const overrideOutline = themeOverride ? declaration(themeOverride, 'outline') : '';
        const overrideDecl = overrideOutline || (themeOverride ? declaration(themeOverride, 'outline-color') : '');
        const overrideVar = overrideDecl.match(/var\((--[\w-]+)\)/)?.[1] ?? '';
        const fallbackDecl = declaration(BTN_FOCUS, 'outline');
        const ringRaw = themeOverride && overrideDecl
          ? parseColor(overrideDecl.match(/(#[0-9a-fA-F]{3,6}|rgba?\([^)]*\))/)?.[1] ?? '') ??
            parseColor(tok(overrideVar || '--color-accent'))
          : parseColor(tok(fallbackVar));

        const bgPrimary = parseColor(tok('--color-bg-primary'));
        const bgSecondary = parseColor(tok('--color-bg-secondary'));
        assert.ok(ringRaw && bgPrimary && bgSecondary, `${theme} 的环色 / 底色令牌读不到，守卫前提变了`);

        // 环画在按钮外，落在页面底色（或卡片底色）上 —— 取**较差**的那个
        const rPrimary = contrast(ringRaw, bgPrimary);
        const rSecondary = contrast(ringRaw, bgSecondary);
        const worst = Math.min(rPrimary, rSecondary);
        assert.ok(
          worst >= 3,
          `${theme}/${dark ? 'dark' : 'light'} 焦点环对页面底色只有 ${worst.toFixed(2)}:1（vs bg-primary ${rPrimary.toFixed(2)}、vs bg-secondary ${rSecondary.toFixed(2)}）—— 低于 WCAG 2.2 非文本对比 3:1。环色来源=${themeOverride && overrideDecl ? `主题覆盖（${overrideDecl}）` : `兜底（${fallbackDecl}）`}`,
        );
      });
    }
  }

  it('兜底环色令牌在 6 套主题里都有定义（否则 var() 解析为空、环会掉成 currentColor）', () => {
    // 2026-10-20：原先只查 claude/apple/chrome 三套「无 :focus-visible 覆盖」的主题，
    // 现在焦点环统一走 --color-focus-ring ⇒ 六套主题都必须显式定义它（明暗各一个）。
    for (const theme of THEMES) {
      const css = read(`src/styles/themes/${theme}.css`);
      assert.ok(token(css, '--color-focus-ring'), `${theme} 未定义 --color-focus-ring，兜底环色会解析失败`);
    }
  });
});
