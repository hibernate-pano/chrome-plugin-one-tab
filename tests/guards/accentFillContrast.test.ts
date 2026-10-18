// accent **实底**上的墨色必须与底色形成足够对比（2026-10-18 round 19）。
//
// 【要防的回归类别】主按钮的标签一直写死 `color: white`，而 `--color-accent` 是随主题
// 与明暗变的：深色主题把 accent 提亮到当**前景色**用的明度，白字就塌了。真机实测
// （6 套主题 × 明暗两态，见 round 19 的 dist 探针）：
//   奶油深色 1.67:1、chrome 深色 2.11:1、claude 深色 2.60:1、prism 深色 2.98:1、
//   苹果深色 3.65:1、legacy 深色 3.68:1 —— 全是「保存 / 确定 / 登录」这类主按钮。
// 浅色里奶油 3.19 / claude 3.12 / prism 3.66 同样低于 AA 4.5:1。
// 于是引入 `--color-accent-fg`（落在 accent 实底上的墨色，与「当墨色用的」
// `--color-accent-text` 不是一回事），各主题在自己的两个块里声明。
//
// 阈值：静止态按 WCAG AA 正文 4.5:1（按钮标签是 14px 常规字重，不是大字号）。
// hover 态取 3.5:1 —— 深色下所有主题都 ≥4.85，但三套浅色主题的 accent-hover 比 accent
// **更深**（hover 变暗是常见反馈），任何单一墨色都到不了 4.5（奶油 3.56 / prism 3.98 /
// 苹果 4.32）；要达标就得改这四套主题的品牌 hover 色，超出本问题的范围。3.5:1 仍高于
// WCAG 非文本 3:1，且这三处修前分别是 3.19 / 3.66 / 4.32（更差或持平）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
const THEMES = ['legacy', 'creamy', 'prism', 'claude', 'apple', 'chrome'] as const;

type Rgb = { r: number; g: number; b: number };

function parseColor(raw: string): Rgb | null {
  const value = raw.trim();
  const hex = value.match(/#([0-9a-f]{3}|[0-9a-f]{6})\b/i);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map(c => c + c).join('') : hex[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  const fn = value.match(/rgba?\(([^)]+)\)/i);
  if (!fn) return null;
  const p = fn[1].split(',').map(v => parseFloat(v.trim()));
  return p.length < 3 || p.some(Number.isNaN) ? null : { r: p[0], g: p[1], b: p[2] };
}

function luminance(c: Rgb): number {
  const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** 取出某个选择器的声明块。 */
function block(css: string, selector: string): string {
  const at = css.indexOf(selector);
  if (at === -1) return '';
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return open === -1 || close === -1 ? '' : css.slice(open + 1, close);
}

/** 单个 CSS 变量的值（同一块内后定义者胜，与浏览器相等）。 */
function token(css: string, name: string): string {
  const all = [...css.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))];
  return all.length ? all[all.length - 1][1].trim() : '';
}

/**
 * 主题文件里的作用域块。**两种引号都要试**：仓里 legacy/prism/claude/apple/chrome 用
 * 双引号，creamy 用单引号；漏掉一种会静默回退成整份文件，于是「明暗两态」读到同一个值。
 * 只认后面紧跟 `{` 的那一个选择器，避免把 `.dark` 块当成浅色块。
 */
function themeScope(css: string, theme: string, dark: boolean): string {
  const suffix = dark ? '.dark' : '';
  for (const q of ["'", '"']) {
    const found = block(css, `html[data-theme=${q}${theme}${q}]${suffix} {`);
    if (found) return found;
  }
  return '';
}

const GLOBAL = read('src/styles/global.css');
const GLOBAL_LIGHT = block(GLOBAL, ':root {');
const GLOBAL_DARK = block(GLOBAL, 'html.dark {');

/** 主题 × 明暗 → 三个令牌的有效值（主题块优先，回退到 global 的 :root / html.dark）。 */
function resolveTokens(theme: string, dark: boolean) {
  const css = read(`src/styles/themes/${theme}.css`);
  const scope = themeScope(css, theme, dark);
  const fallback = dark ? GLOBAL_DARK : GLOBAL_LIGHT;
  const pick = (name: string) => token(scope, name) || token(fallback, name);
  return {
    accent: parseColor(pick('--color-accent')),
    hover: parseColor(pick('--color-accent-hover')),
    fg: parseColor(pick('--color-accent-fg')),
  };
}

describe('accent 实底上的墨色：6 套主题 × 明暗两态都够读', () => {
  for (const theme of THEMES) {
    for (const dark of [false, true]) {
      const label = `${theme} / ${dark ? 'dark' : 'light'}`;
      it(`${label}：静止态 ≥ 4.5:1，hover 态 ≥ 3.5:1`, () => {
        const { accent, hover, fg } = resolveTokens(theme, dark);
        assert.ok(accent && hover && fg, `${label}：accent / accent-hover / accent-fg 三个令牌必须都读得到`);
        const resting = contrast(fg, accent);
        const hovering = contrast(fg, hover);
        assert.ok(
          resting >= 4.5,
          `${label}：accent 实底上的墨色只有 ${resting.toFixed(2)}:1 —— 主按钮的字读不清（写死白字的老问题是 1.44–3.68:1）`
        );
        assert.ok(
          hovering >= 3.5,
          `${label}：hover 实底上的墨色只有 ${hovering.toFixed(2)}:1（低于 3.5 就比修前还差）`
        );
      });
    }
  }
});

describe('压在 accent 实底上的文字都必须取这个令牌，不能写死', () => {
  const rules: Array<[string, string]> = [
    ['.btn-primary {', '主按钮'],
    ['.flat-button-primary {', '扁平主按钮'],
    ['.theme-accent-outline:hover {', '强调描边按钮的 hover 实底'],
    ['.skip-to-content {', '跳转正文链接'],
    ['.theme-cta {', '登录/注册主 CTA'],
  ];

  for (const [selector, what] of rules) {
    it(`${what}（${selector.replace(' {', '')}）取 var(--color-accent-fg)`, () => {
      const decls = block(GLOBAL, selector);
      assert.ok(decls, `global.css 里找不到 ${selector}`);
      assert.match(
        decls,
        /color:\s*var\(--color-accent-fg\)/,
        `${what}必须用随主题变的墨色：accent 在深色主题里是亮色，写死白字只有 1.4–3.7:1`
      );
      assert.ok(!/color:\s*(#fff|#ffffff|white)\b/i.test(decls), `${what}不得再写死白色`);
    });
  }

  it('登录/注册的 theme-cta 不再由调用方写死 Tailwind 的 text-white', () => {
    for (const rel of ['src/components/auth/LoginForm.tsx', 'src/components/auth/RegisterForm.tsx']) {
      const src = readFileSync(resolve(ROOT, rel), 'utf8');
      const cta = src.split('\n').filter(l => l.includes('theme-cta'));
      assert.equal(cta.length, 1, `${rel}：theme-cta 的调用点应只有一个`);
      assert.ok(
        !/text-white/.test(cta[0]),
        `${rel}：text-white 会盖掉 .theme-cta 的墨色，深色主题下主 CTA 的字会看不见`
      );
    }
  });
});
