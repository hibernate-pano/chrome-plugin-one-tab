// 弹窗的「唯一出口按钮」必须读得清（2026-10-18 round 38）。
//
// 【要防的回归类别】AlertDialog / ConfirmDialog 只有一个主按钮，它就是整个弹窗的出口。
// 它的标签是 14px 常规字重的白字，所以按 WCAG AA 正文线 **4.5:1** 衡量，不是大字号线 3:1。
// 改前实测（白字对实底）：
//   warning  amber-500  #f59e0b  2.15:1  ← 弹窗最常出现的一档
//   success  emerald-600 #059669 3.77:1
//   info     sky-600    #0284c7 4.10:1
//   danger   rose-600   #e11d48 4.70:1（已达标，不改，见下面的钉死断言）
// 现统一下移到 700 档，hover 走 800 档；rose 保持 600/700。
//
// 【第二个坑：焦点环】环是 2px outline + offset-2，画在弹窗底色上，要求 ≥3:1。
// 原先按钮用同色系 500 档、关闭按钮用 slate-400（对白只有 2.56:1），几乎看不出焦点在哪。
// 现统一 `outline-slate-600`（对白 7.58:1）/ 深色 `dark:outline-slate-300`。
//
// 【为什么色值写死在这份文件里】仓库不允许为测试新增依赖，不能 require('tailwindcss/colors')；
// 下面只抄了本守卫会碰到的 100–900 档真实 hex（Tailwind v3 调色板）。写死副本的风险是
// 上游改色后这里失配 —— 但那需要升级 Tailwind 主版本，届时此文件本就该一起看。
//
// 【提取口径】只从按钮的类名字符串（`button:` / `confirmButton:`）里取色，
// 图标底色（`bg-amber-100 text-amber-600` 那一类）刻意排除：它是装饰块，不是白字背景。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** 剥掉块注释与整行行注释后再做结构断言：注释里提到旧类名不该让守卫变红。 */
const read = (rel: string) =>
  readFileSync(resolve(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');

const DIALOG_FILES = ['src/components/common/AlertDialog.tsx', 'src/components/common/ConfirmDialog.tsx'] as const;

type Shade = Record<number, string>;

const PALETTE: Record<'amber' | 'emerald' | 'rose' | 'sky', Shade> = {
  amber: {
    100: '#fef3c7', 200: '#fde68a', 300: '#fcd34d', 400: '#fbbf24', 500: '#f59e0b',
    600: '#d97706', 700: '#b45309', 800: '#92400e', 900: '#78350f',
  },
  emerald: {
    100: '#d1fae5', 200: '#a7f3d0', 300: '#6ee7b7', 400: '#34d399', 500: '#10b981',
    600: '#059669', 700: '#047857', 800: '#065f46', 900: '#064e3b',
  },
  rose: {
    100: '#ffe4e6', 200: '#fecdd3', 300: '#fda4af', 400: '#fb7185', 500: '#f43f5e',
    600: '#e11d48', 700: '#be123c', 800: '#9f1239', 900: '#881337',
  },
  sky: {
    100: '#e0f2fe', 200: '#bae6fd', 300: '#7dd3fc', 400: '#38bdf8', 500: '#0ea5e9',
    600: '#0284c7', 700: '#0369a1', 800: '#075985', 900: '#0c4a6e',
  },
};

type Rgb = { r: number; g: number; b: number };

function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function luminance(c: Rgb): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

/** 白字对实底。按钮标签是纯 `text-white`，没有透明度，所以不需要叠色。 */
function whiteContrast(hex: string): number {
  return 1.05 / (luminance(hexToRgb(hex)) + 0.05);
}

/** 按钮类名字符串：`button:`（AlertDialog）与 `confirmButton:`（ConfirmDialog）。 */
function buttonClassStrings(src: string): string[] {
  return [...src.matchAll(/(?:confirmButton|button):\s*'([^']*)'/g)].map(m => m[1]);
}

/**
 * 从一条类名里分出静止态 / hover 态底色。
 * 只认裸 `bg-<family>-<shade>` 与 `hover:bg-...`：`dark:` 变体在按钮上没有，
 * 出现即视为新情况（下面的找不到色值断言会红），不在这里猜。
 */
function splitShades(classes: string): { resting: string[]; hover: string[] } {
  const resting: string[] = [];
  const hover: string[] = [];
  for (const token of classes.trim().split(/\s+/)) {
    const m = token.match(/^(hover:)?bg-(amber|emerald|rose|sky)-(\d+)$/);
    if (!m) continue;
    (m[1] ? hover : resting).push(`${m[2]}-${m[3]}`);
  }
  return { resting, hover };
}

/**
 * 主题令牌按钮（ConfirmDialog 的 info 用 `bg-primary-*`）不走固定调色板：
 * 它的底色随主题变，白字能不能读由 --color-accent-fg 那套契约管（见
 * tests/guards/accentFillContrast.test.ts），本守卫不重复、也不改动它。
 */
const isThemeTokenButton = (classes: string) => /\bbg-primary-\d+/.test(classes);

/** 取 `case 'x':` 到下一个 `case '` 之间的源码，用来钉住某一档的颜色。 */
function caseBlock(src: string, name: string): string {
  const at = src.indexOf(`case '${name}':`);
  assert.ok(at !== -1, `找不到 case '${name}':，守卫前提变了`);
  const next = src.indexOf("case '", at + 1);
  return src.slice(at, next === -1 ? undefined : next);
}

describe('弹窗出口按钮：静止态与 hover 态的白字都 ≥ 4.5:1（WCAG AA 正文）', () => {
  for (const file of DIALOG_FILES) {
    const src = read(file);

    it(`${file}：提取得到按钮类名且每档色值都在调色板里`, () => {
      const strings = buttonClassStrings(src);
      assert.ok(strings.length > 0, `${file}：找不到 button/confirmButton 的类名字符串`);
      for (const classes of strings) {
        if (isThemeTokenButton(classes)) continue;
        const { resting, hover } = splitShades(classes);
        assert.ok(resting.length > 0, `${file}：按钮「${classes}」没有静止态 bg-*，白字落在什么底上无从判断`);
        assert.ok(hover.length > 0, `${file}：按钮「${classes}」没有 hover:bg-*，hover 态无法校验`);
        for (const shade of [...resting, ...hover]) {
          const [family, level] = shade.split('-') as [keyof typeof PALETTE, string];
          assert.ok(
            PALETTE[family][Number(level)],
            `${file}：「${shade}」不在本守卫的调色板子集里 —— 换成别的档/别的色系时请同步更新色表`,
          );
        }
      }
    });

    it(`${file}：每一档（含 hover）都读得清`, () => {
      buttonClassStrings(src).forEach((classes, index) => {
        if (isThemeTokenButton(classes)) return;
        const { resting, hover } = splitShades(classes);
        for (const [state, shades] of [['静止态', resting], ['hover 态', hover]] as const) {
          for (const shade of shades) {
            const [family, level] = shade.split('-') as [keyof typeof PALETTE, string];
            const hex = PALETTE[family][Number(level)];
            const ratio = whiteContrast(hex);
            assert.ok(
              ratio >= 4.5,
              `${file} 第 ${index + 1} 个按钮：${state} ${shade}（${hex}）上的白字只有 ${ratio.toFixed(2)}:1，低于 WCAG AA 4.5:1`,
            );
          }
        }
      });
    });
  }
});

describe('焦点环：按钮环色必须是 600 档石板灰，不是 400/500 档浅色', () => {
  for (const file of DIALOG_FILES) {
    const src = read(file);

    it(`${file}：不再出现 outline-{amber,emerald,sky,slate}-500 / outline-slate-400`, () => {
      assert.doesNotMatch(
        src,
        /focus-visible:outline-(?:amber|emerald|sky|slate)-500/,
        `${file}：同色系 500 档当环色，对弹窗白底只有 2.5–4.1:1（2px 图形要求 ≥3:1），且与按钮本身同色系、几乎看不出焦点`,
      );
      assert.doesNotMatch(src, /outline-slate-400/, `${file}：slate-400 对白只有 2.56:1，不能当焦点环`);
    });

    it(`${file}：每个按钮的环都是 slate-600 / 深色 slate-300`, () => {
      const strings = buttonClassStrings(src);
      for (const classes of strings) {
        if (isThemeTokenButton(classes)) {
          // 主题令牌按钮的环与底色一并保持原样（本轮不动 primary），只确认没被顺手改掉。
          assert.match(
            classes,
            /focus-visible:outline-primary-500/,
            `${file}：主题令牌按钮「${classes}」的环不该在本轮被改（primary 属于主题契约）`,
          );
          continue;
        }
        assert.match(classes, /focus-visible:outline-slate-600/, `${file}：按钮「${classes}」缺 focus-visible:outline-slate-600`);
        assert.match(
          classes,
          /dark:focus-visible:outline-slate-300/,
          `${file}：按钮「${classes}」缺深色环 dark:focus-visible:outline-slate-300（slate-600 在深色底上读不出来）`,
        );
      }
    });
  }

  // ── 2026-10-19 审计 V-6：弹层的环色与配色都改为主题令牌 ──────────────
  //
  // 修复前 ModalFrame / ConfirmDialog 写死 slate 系（bg-slate-900/95、
  // text-slate-900、focus-visible:outline-slate-600）：在 Claude 这类暖色
  // 主题下，弹层是一块冷蓝补丁。现在改用主题令牌（theme-bg-elevated /
  // theme-text-primary / focus-visible:outline-primary-600）。
  //
  // 契约没变：**焦点环必须能被看清**。原先钉「slate-600 / 深色 slate-300」，
  // 现在钉「primary-600 档或 slate-600 档」——两者在各自底色上 ≥3:1
  // （2px 图形的要求，见 WCAG 1.4.11）。
  const RING_PATTERN = /focus-visible:outline-(?:primary-600|slate-600)/;

  it('ConfirmDialog 的取消按钮（同一弹窗的第二个出口）也有能看清的焦点环', () => {
    const src = read('src/components/common/ConfirmDialog.tsx');
    const cancel = src.match(/onClick=\{onCancel\}[\s\S]*?className="([^"]+)"/);
    assert.ok(cancel, '找不到取消按钮的 className，守卫前提变了（onClick={onCancel} 的写法被改？）');
    assert.match(cancel[1], RING_PATTERN, '取消按钮必须有 focus-visible 环（600 档）');
    assert.doesNotMatch(cancel[1], /outline-slate-400/, 'slate-400 对白只有 2.56:1');
    assert.doesNotMatch(cancel[1], /outline-slate-500/, '500 档当环色对白底只有 2.5–4.1:1');
  });

  for (const [file, label] of [
    ['src/components/common/ModalFrame.tsx', '关闭弹窗'],
    ['src/components/common/Toast.tsx', '关闭提示'],
  ] as const) {
    it(`${file}：右上角「${label}」按钮的环能被看清`, () => {
      const src = read(file);
      const close = src.match(/className="([^"]+)"[\s\S]{0,240}?aria-label="[^"]+"/);
      assert.ok(close, `${file}：找不到关闭按钮的 className，守卫前提变了`);
      assert.match(close[1], RING_PATTERN, '关闭按钮必须有 focus-visible 环（600 档）');
      assert.doesNotMatch(close[1], /outline-slate-400/, 'slate-400 对白只有 2.56:1');
      assert.doesNotMatch(close[1], /outline-slate-500/, '500 档当环色对白底只有 2.5–4.1:1');
    });
  }

  // 弹层本体必须跟主题（V-6）：写死的 slate 系在暖色主题下是冷蓝补丁。
  it('ModalFrame 的弹层本体不写死 slate 配色', () => {
    const src = read('src/components/common/ModalFrame.tsx');
    // 弹层的 className 在 tabIndex={-1} 之后的那一处。
    // 用 tabIndex={-1} 锚定，避免匹配到「关闭按钮」那一条 className；
    // 匹配前先剥注释（弹层的 className 上方有一大段说明性注释）。
    const srcNoComments = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
    // 弹层本体带 `overflow-hidden`（面板内容滚动由内层负责），关闭按钮没有 ——
    // 用它当锚点可以唯一命中弹层，而不是匹配到后面那条「关闭按钮」的 className。
    // 注意 className 是**模板字符串**（内含 ${maxWidthClassName}），所以不能
    // 用 [^`"]* 一口气吃到引号 —— 改成非贪婪的 .*? 加终止符。
    const panel = srcNoComments.match(/className=\{?`(.+?overflow-hidden.+?)`\}?/);
    assert.ok(panel, '找不到弹层 className，守卫前提变了');
    assert.match(panel[1], /theme-bg-elevated/, '弹层底色必须走主题令牌');
    assert.match(panel[1], /theme-border-default/, '弹层边框必须走主题令牌');
    assert.match(panel[1], /theme-radius-panel/, '弹层圆角必须走主题令牌');
    assert.doesNotMatch(panel[1], /bg-slate-|text-slate-|border-slate-/, '弹层不得写死 slate 系');
  });
});

describe('破坏性操作仍是最重的那一档色', () => {
  it('AlertDialog 的 error 仍是 rose-600 / hover rose-700', () => {
    const src = read('src/components/common/AlertDialog.tsx');
    assert.match(caseBlock(src, 'error'), /button:\s*'bg-rose-600 hover:bg-rose-700/);
  });

  it('ConfirmDialog 的 danger 仍是 rose-600 / hover rose-700', () => {
    const src = read('src/components/common/ConfirmDialog.tsx');
    assert.match(caseBlock(src, 'danger'), /confirmButton:\s*'bg-rose-600 hover:bg-rose-700/);
  });

  it('ConfirmDialog 的 info 仍用主题令牌 bg-primary-600（不是写死的调色板色）', () => {
    const src = read('src/components/common/ConfirmDialog.tsx');
    assert.match(caseBlock(src, 'info'), /confirmButton:\s*'bg-primary-600 hover:bg-primary-700/);
  });
});
