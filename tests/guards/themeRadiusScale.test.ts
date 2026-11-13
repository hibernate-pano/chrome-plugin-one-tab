/**
 * 主题圆角刻度的守卫（2026-11-12）。
 *
 * ── 这个守卫在防什么 ──────────────────────────────────────────────────────
 *
 * 2026-11-12 有一处改动：**Tailwind 的 `rounded-*` 从写死值改成读 `--radius-*` 令牌**。
 *
 * 改之前：Tailwind 的 `borderRadius` 是写死的 4 / 6 / 8 / 12 / 16 / 24px ⇒
 *   同一个 `rounded-lg` 在 6 套主题里**永远是 8px** ⇒ 主题的形状语言
 *   （--radius-*）只作用在 CSS 里手写的规则上，作用不到 TSX 里最常见的那些圆角
 *   （rounded-lg 20 处 / rounded-xl 16 处 / rounded-2xl 13 处 …）。
 *   症状是「切了主题，圆角没跟着变」。
 *
 * 改之后是一次**全站视觉变更**：apple 的 `rounded-lg` 从 8px 变成 14px，
 *   全站 60+ 处一起变了 —— 而**没有任何测试知道这件事发生过**。
 *
 * ⇒ 这个守卫存在的理由：**令牌化这件事本身必须有防线**。
 *   不然下一次有人改一个 `--radius-lg`，会有一大片 UI 悄悄变形，
 *   而测试全绿、没有任何一条会红。
 *
 * ── 与 U-14 的分工（别混淆）──────────────────────────────────────────────
 *
 * `themeContrast.test.ts` 的 U-14 守的是**按钮形状**（`--radius-btn` /
 * `--radius-btn-icon`）—— 那是「6 套主题曾有 4 种按钮形状」的历史问题。
 * 本文件守的是**Tailwind 刻度**（sm → 3xl + full）—— 2026-11-12 才引入的那一组。
 * 两组令牌互不重叠，**都要有人守**。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** 剥掉注释后再做结构断言：注释里提到旧写法不该让守卫变红。 */
const read = (rel: string) =>
  readFileSync(resolve(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');

const THEMES = ['legacy', 'creamy', 'prism', 'claude', 'apple', 'chrome'] as const;

/** Tailwind 的圆角刻度（顺序 = 递进顺序）。 */
const SCALE = ['sm', 'md', 'lg', 'xl', '2xl', '3xl'] as const;
/** 全部 7 个令牌（含正圆）。 */
const ALL_TOKENS = [...SCALE, 'full'] as const;

/* ── CSS 解析 ──────────────────────────────────────────────── */

/** 取出某个选择器对应的块内容（花括号配对）。 */
function blockOf(css: string, selectorPattern: RegExp): string {
  const m = selectorPattern.exec(css);
  if (!m) return '';
  const open = css.indexOf('{', m.index);
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

/** 主题的浅色块（`[data-theme="x"], html[data-theme="x"] { … }`）。 */
function lightScope(css: string, theme: string): string {
  return blockOf(css, new RegExp(`(?:^|\\n)\\s*\\[data-theme=["']${theme}["']\\][^{]*\\{`));
}

/** 主题的深色块（`html.dark [data-theme="x"], html[data-theme="x"].dark { … }`）。 */
function darkScope(css: string, theme: string): string {
  return blockOf(css, new RegExp(`html\\.dark\\s*\\[data-theme=["']${theme}["']\\][^{]*\\{`));
}

function token(css: string, name: string): string {
  const all = [...css.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))];
  return all.length ? all[all.length - 1][1].trim() : '';
}

/** 把 `4px` / `0.375rem` 统一折成 px（rem 按根字号 16px）。 */
function toPx(value: string): number | null {
  const m = /^([\d.]+)(px|rem)$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2] === 'rem' ? n * 16 : n;
}

/* ── ① 令牌完整性 ──────────────────────────────────────────── */

describe('U-26：每套主题都必须声明全套圆角刻度（不许靠 global 兜底）', () => {
  for (const theme of THEMES) {
    it(`${theme}：声明 ${ALL_TOKENS.length} 个刻度令牌`, () => {
      const scope = lightScope(read(`src/styles/themes/${theme}.css`), theme);
      assert.ok(scope, `${theme}.css 里找不到浅色作用域块`);
      for (const t of ALL_TOKENS) {
        const value = token(scope, `--radius-${t}`);
        assert.ok(
          value,
          `${theme}.css 没有声明 --radius-${t} —— ` +
            '不声明的主题会落回 global.css 的兜底值（legacy 那套刻度），' +
            '于是「切了主题，圆角没跟着变」—— 这正是本次要消灭的缺陷',
        );
        assert.notEqual(
          toPx(value),
          null,
          `${theme} 的 --radius-${t} = "${value}"：解析不出 px/rem —— ` +
            '守卫与浏览器都读不懂这个值',
        );
      }
    });
  }

  it('global.css 的 :root 兜底也有全套（某主题漏声明时至少不是 0）', () => {
    const global = read('src/styles/global.css');
    for (const t of ALL_TOKENS) {
      assert.ok(
        token(global, `--radius-${t}`),
        `global.css 的 :root 缺 --radius-${t} —— 漏声明时 ` +
          'var(--radius-x) 会算成无效值 ⇒ border-radius 退回 0（圆角全没了）',
      );
    }
  });
});

/* ── ② 刻度本身的质量 ──────────────────────────────────────── */

describe('U-26：刻度必须递进，且正圆必须是正圆', () => {
  for (const theme of THEMES) {
    it(`${theme}：sm ≤ md ≤ lg ≤ xl ≤ 2xl ≤ 3xl`, () => {
      const scope = lightScope(read(`src/styles/themes/${theme}.css`), theme);
      const values = SCALE.map(t => toPx(token(scope, `--radius-${t}`)));
      for (let i = 0; i < values.length; i++) {
        assert.notEqual(values[i], null, `${theme} 的 --radius-${SCALE[i]} 解析不出来`);
      }
      for (let i = 1; i < values.length; i++) {
        const prev = values[i - 1] as number;
        const cur = values[i] as number;
        assert.ok(
          cur >= prev,
          `${theme} 的刻度不是递进的：--radius-${SCALE[i - 1]} = ${prev}px > ` +
            `--radius-${SCALE[i]} = ${cur}px —— 「更大的那档更圆」是离群值`,
        );
      }
    });

    it(`${theme}：--radius-full 是正圆（9999px）`, () => {
      const scope = lightScope(read(`src/styles/themes/${theme}.css`), theme);
      const value = token(scope, '--radius-full');
      assert.equal(
        toPx(value),
        9999,
        `${theme} 的 --radius-full = "${value}" —— 正圆就是正圆，` +
          '改成别的值会把药丸 / 圆形头像变成椭圆',
      );
    });
  }

  it('深色态不得把刻度改成另一套（否则同一主题切深浅色时圆角会跳）', () => {
    for (const theme of THEMES) {
      const css = read(`src/styles/themes/${theme}.css`);
      const light = lightScope(css, theme);
      const dark = darkScope(css, theme);
      assert.ok(dark, `${theme}.css 里找不到深色作用域块`);
      for (const t of ALL_TOKENS) {
        const inDark = token(dark, `--radius-${t}`);
        if (!inDark) continue; // 没重定义就继承浅色值 —— 那是允许的
        assert.equal(
          inDark,
          token(light, `--radius-${t}`),
          `${theme} 的深色态把 --radius-${t} 改成了 "${inDark}"` +
            `（浅色是 "${token(light, `--radius-${t}`)}"）—— ` +
            '同一个主题切深浅色时圆角会跳',
        );
      }
    }
  });
});

/* ── ③ 令牌化本身 ──────────────────────────────────────────── */

describe('U-26：Tailwind 的 rounded-* 必须读这些令牌（不许写死）', () => {
  it('tailwind.config.js 的 borderRadius 每一档都读 var(--radius-*)', () => {
    const config = read('tailwind.config.js');
    const block = blockOf(config, /borderRadius:\s*\{/);
    assert.ok(block, 'tailwind.config.js 里找不到 borderRadius 配置');
    for (const t of ALL_TOKENS) {
      const key = t === 'sm' ? "'sm'" : `'${t}'`;
      const line = block.split('\n').find(l => l.includes(key));
      assert.ok(line, `tailwind.config.js 的 borderRadius 里没有 '${t}' 这一档`);
      assert.match(
        line,
        new RegExp(`var\\(--radius-${t}\\)`),
        `Tailwind 的 rounded-${t} 必须读 var(--radius-${t}) —— ` +
          '写死的值等于「切了主题，圆角没跟着变」',
      );
    }
  });

  it('borderRadius 里不许出现写死的 px/rem 字面量', () => {
    const config = read('tailwind.config.js');
    const block = blockOf(config, /borderRadius:\s*\{/);
    const literals = [...block.matchAll(/:\s*['"]?([\d.]+(?:px|rem))['"]?/g)];
    assert.equal(
      literals.length,
      0,
      `borderRadius 里还有写死的值：${literals.map(m => m[1]).join(' / ')} —— ` +
        '写死 = 圆角不再跟主题走',
    );
  });

  it('DEFAULT 那一档也读令牌（`rounded` 不许绕开主题）', () => {
    const config = read('tailwind.config.js');
    const block = blockOf(config, /borderRadius:\s*\{/);
    const line = block.split('\n').find(l => l.includes('DEFAULT'));
    assert.ok(line, 'tailwind.config.js 的 borderRadius 里没有 DEFAULT');
    assert.match(line, /var\(--radius-/, '`rounded`（DEFAULT）也必须读令牌');
  });
});
