// 小字对比度与焦点环令牌（2026-10-20 审计 D-1 / D-2 / D-3）。
//
// 【本文件要防的回归类别】
//
// D-1 页脚版本号（12px 小字）低于 WCAG AA：
//   `src/components/app/MainApp.tsx` 的 footer 写着 `text-gray-600 dark:text-gray-400`
//   —— 硬编码 Tailwind 灰阶，不跟主题走。2026-10-19 审计 C-8 说这条「已修」，
//   其实只把**容器**换成了 theme-shell，**文字色**还是写死的。
//   根因还有一层：Tailwind 的 `dark:` 变体编译成 `:is(.dark *)` 后特异性 (0,3,0)，
//   会盖过 `.theme-text-muted` 的 (0,1,0) —— 所以硬编码灰阶必须**删掉**，
//   只"再补一个主题类"是不生效的。
//
// D-2 设置页 5 处说明文字低于 AA：写死的 gray-400/500（2.54:1）、安全告警
//   用的 amber-600（3.19:1）、「清除配置」红字（3.76:1）。
//
// D-3 焦点环用硬编码近黑色，而且 `--color-focus-ring` 这个令牌**压根没定义过**
//   （getComputedStyle(...).getPropertyValue('--color-focus-ring') 返回空串）。
//   同时 `.input:focus` 里的 `@apply outline-none` 把全局 :focus-visible 的环
//   整条吃掉 ⇒ 搜索框聚焦时只剩一圈约 1.1:1 的半透明柔光，等于没有焦点指示。
//
// 【判据】
//   · 令牌取值从**主题文件本身**读出来再算对比度 —— 不写死常量副本，
//     否则改坏了规则守卫照样绿。半透明底色先叠到父表面上再算。
//   · 文字令牌按 WCAG 2.2 正文线 4.5:1；焦点环按非文本对比 3:1（1.4.11）。
//
// 注：图层叠色/对比度算法与 tests/guards/focusRingVisibility.test.ts 同一套。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** 剥掉块注释与整行行注释后再做结构断言：注释里提到旧类名不该让守卫变红。
 *  （与 tests/guards/dialogButtonContrast.test.ts 同一口径。） */
const read = (rel: string) =>
  readFileSync(resolve(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');

const THEMES = ['legacy', 'creamy', 'prism', 'claude', 'apple', 'chrome'] as const;

type Rgb = { r: number; g: number; b: number; a: number };

function parseColor(raw: string): Rgb | null {
  const value = String(raw).trim();
  if (!value) return null;
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map(c => c + c).join('') : hex[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  // rgba(255, 255, 255, 0.95) / rgb(0 0 0 / 0.4) 两种写法都收
  const fn = value.match(/^rgba?\(([^)]+)\)$/i);
  if (fn) {
    const p = fn[1].split(/[,/]/).map(v => parseFloat(v.trim())).filter(n => !Number.isNaN(n));
    if (p.length < 3) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  return null;
}

/** 半透明前景叠到底色上 —— 主题里的 bg-secondary/tertiary/elevated 有 rgba。 */
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

/** 一套主题在某个明暗状态下的令牌与表面色。 */
interface ThemeState {
  key: string;
  scope: string;
  tok: (name: string) => string;
  surfaces: Record<string, Rgb>;
}

const SURFACE_NAMES = ['shell', 'primary', 'secondary', 'tertiary', 'elevated', 'overlay'] as const;

function loadState(theme: string, dark: boolean): ThemeState {
  const css = read(`src/styles/themes/${theme}.css`);
  const scope = themedBlock(css, theme, dark ? '.dark' : ' {') || '';
  // 令牌要能回落到 global.css 的兜底定义（没选主题时的 html:not([data-theme])）
  const tok = (name: string) => token(scope, name) || token(css, name) || token(GLOBAL, name);

  const primary = parseColor(tok('--color-bg-primary')) ?? { r: 255, g: 255, b: 255, a: 1 };
  const layer = (name: string, parent: Rgb) => {
    const raw = parseColor(tok(name));
    return raw ? over(raw, parent) : parent;
  };
  const secondary = layer('--color-bg-secondary', primary);
  const surfaces: Record<string, Rgb> = {
    primary,
    secondary,
    tertiary: layer('--color-bg-tertiary', secondary),
    elevated: layer('--color-bg-elevated', primary),
    overlay: layer('--color-bg-overlay', primary),
    shell: layer('--color-shell', primary),
  };
  return { key: `${theme}/${dark ? 'dark' : 'light'}`, scope, tok, surfaces };
}

const STATES: ThemeState[] = THEMES.flatMap((t) => [loadState(t, false), loadState(t, true)]);

describe('D-1/D-2：提示色、警告色、危险色在 6 套主题 × 明暗都达到 WCAG AA 正文线 4.5:1', () => {
  const cases: Array<{ token: string; label: string }> = [
    { token: '--color-text-muted', label: '提示色（页脚版本号 / 占位符 / 11px 说明文字）' },
    { token: '--color-warning', label: '警告色（WebDAV 口令安全告警）' },
    { token: '--color-danger', label: '危险色（「清除配置」红字）' },
  ];

  for (const { token: name, label } of cases) {
    for (const state of STATES) {
      it(`${state.key} 的 ${name}（${label}）`, () => {
        const raw = state.tok(name);
        assert.ok(raw, `${state.key} 没有定义 ${name}`);
        const fg = parseColor(raw);
        assert.ok(fg, `${state.key} 的 ${name} = "${raw}" 解析不出颜色`);
        const ratios = SURFACE_NAMES.map((n) => contrast(fg!, state.surfaces[n]));
        const worstIdx = ratios.indexOf(Math.min(...ratios));
        const worst = ratios[worstIdx];
        assert.ok(
          worst >= 4.5,
          `${state.key} 的 ${name} = ${raw} 在 ${SURFACE_NAMES[worstIdx]} 底上只有 ${worst.toFixed(2)}:1 —— 低于 WCAG AA 正文线 4.5:1（各底：${SURFACE_NAMES.map((n, i) => `${n} ${ratios[i].toFixed(2)}`).join(' ')}）`,
        );
      });
    }
  }
});

describe('D-3：--color-focus-ring 必须存在，且对所在表面 ≥ 3:1（WCAG 2.2 非文本对比）', () => {
  for (const state of STATES) {
    it(`${state.key}`, () => {
      const raw = state.tok('--color-focus-ring');
      assert.ok(raw, `${state.key} 没有定义 --color-focus-ring —— 焦点环会掉成浏览器默认近黑色（在 claude 深色上几乎看不见）`);
      const fg = parseColor(raw);
      assert.ok(fg, `${state.key} 的 --color-focus-ring = "${raw}" 解析不出颜色`);
      // 环画在控件外面，落在页面底 / 卡片底 / 弹层底上
      const ringSurfaces = ['shell', 'primary', 'secondary', 'tertiary', 'elevated', 'overlay'] as const;
      const ratios = ringSurfaces.map((n) => contrast(fg!, state.surfaces[n]));
      const worstIdx = ratios.indexOf(Math.min(...ratios));
      const worst = ratios[worstIdx];
      assert.ok(
        worst >= 3,
        `${state.key} 的 --color-focus-ring = ${raw} 在 ${ringSurfaces[worstIdx]} 底上只有 ${worst.toFixed(2)}:1 —— 低于 WCAG 2.2 非文本对比 3:1（各底：${ringSurfaces.map((n, i) => `${n} ${ratios[i].toFixed(2)}`).join(' ')}）`,
      );
    });
  }

  it('全局兜底（没选主题时）也定义了 --color-focus-ring，且明暗各一个', () => {
    const light = block(GLOBAL, 'html:not([data-theme]) {');
    const dark = block(GLOBAL, 'html:not([data-theme]).dark {');
    assert.ok(light && dark, 'global.css 里找不到 html:not([data-theme]) 的兜底块');
    assert.ok(token(light, '--color-focus-ring'), '兜底浅色块缺 --color-focus-ring');
    assert.ok(token(dark, '--color-focus-ring'), '兜底深色块缺 --color-focus-ring');
  });
});

describe('D-3：焦点环的规则必须读 --color-focus-ring，而不是填充色 accent', () => {
  it('global.css 的全局 :focus-visible 读 --color-focus-ring', () => {
    const rule = block(GLOBAL, ':focus-visible {');
    assert.ok(rule, 'global.css 里找不到全局 :focus-visible 规则');
    const outline = declaration(rule, 'outline');
    assert.match(
      outline,
      /var\(--color-focus-ring\)/,
      `全局 :focus-visible 的 outline 应读 --color-focus-ring（当前 "${outline}"）：用 var(--color-accent) 时环与 .btn-primary 的填充同色 ⇒ 焦点环看不见`,
    );
    assert.doesNotMatch(
      outline,
      /var\(--color-accent\)/,
      '焦点环不能取 --color-accent —— 它就是按钮填充色（claude 浅色对页面底也只有 2.69:1）',
    );
  });

  it('.btn:focus-visible 读 --color-focus-ring', () => {
    const rule = block(GLOBAL, '.btn:focus-visible');
    assert.ok(rule, 'global.css 里找不到 .btn:focus-visible 规则');
    assert.match(
      declaration(rule, 'outline'),
      /var\(--color-focus-ring\)/,
      '.btn:focus-visible 的环色应统一走 --color-focus-ring 令牌',
    );
  });

  for (const theme of THEMES) {
    it(`${theme} 主题的 :focus-visible 覆盖不退回 var(--color-accent)`, () => {
      const css = read(`src/styles/themes/${theme}.css`);
      const override = themedBlock(css, theme, ' :focus-visible');
      if (!override) return; // 没有覆盖的主题吃全局兜底
      const outline = declaration(override, 'outline') || declaration(override, 'outline-color');
      assert.match(
        outline,
        /var\(--color-focus-ring\)/,
        `${theme} 的 :focus-visible 覆盖仍取 ${outline} —— 焦点环与主按钮填充同色，等于没有焦点指示`,
      );
    });
  }
});

describe('D-3：输入框不能再把焦点环吃掉', () => {
  it('.input:focus 不得再声明 outline: none / outline-none', () => {
    const rule = block(GLOBAL, '.input:focus');
    assert.ok(rule, 'global.css 里找不到 .input:focus 规则');
    assert.doesNotMatch(
      rule,
      /outline-none|outline:\s*none/,
      '`.input:focus` 里的 outline-none 会盖掉全局 :focus-visible 的焦点环 —— 搜索框聚焦时只剩 1.1:1 的半透明柔光',
    );
  });

  it('.search-bar-input / .search-clear-btn 不得再有 focus:outline-none', () => {
    for (const sel of ['.search-bar-input', '.search-clear-btn']) {
      const rule = block(GLOBAL, sel);
      assert.ok(rule, `global.css 里找不到 ${sel} 规则`);
      assert.doesNotMatch(
        rule,
        /focus:outline-none/,
        `${sel} 的 focus:outline-none 会吃掉焦点环（键盘用户看不到焦点在哪）`,
      );
    }
  });

  it('legacy 主题的 .input:focus 不得再声明 outline: none', () => {
    const css = read('src/styles/themes/legacy.css');
    const rule = block(css, 'html[data-theme="legacy"] .input:focus');
    assert.ok(rule, 'legacy.css 里找不到 .input:focus 覆盖');
    assert.doesNotMatch(
      rule,
      /outline:\s*none/,
      'legacy 的 .input:focus 特异性 (0,3,1) > :focus-visible 的 (0,1,0)，outline: none 会把焦点环整条吃掉',
    );
  });

  it('认证表单的输入框不得再有 focus:outline-none（P1-1）', () => {
    // Tailwind 的 `focus:outline-none` 展开成 `outline: 2px solid transparent`，
    // 特异性 (0,2,0) > 全局 `:focus-visible` 的 (0,1,0) ⇒ 它把焦点环整条吃掉。
    for (const file of ['src/components/auth/LoginForm.tsx', 'src/components/auth/RegisterForm.tsx']) {
      const src = read(file);
      assert.doesNotMatch(
        src,
        /focus:outline-none/,
        `${file}：输入框仍带 focus:outline-none —— apple/chrome/claude 的 --focus-ring 只是半透明柔光，键盘用户看不到焦点在哪`,
      );
    }
  });

  it('认证弹窗的激活标签页用主题令牌，不再写死 text-primary-600（P1-2）', () => {
    const src = read('src/components/auth/AuthModal.tsx');
    assert.doesNotMatch(
      src,
      /text-primary-600 border-b-2 border-primary-600/,
      'AuthModal 的激活标签页仍写死 text-primary-600（Tailwind #2563eb，在 6 个深色主题下都不变 ⇒ 实测 2.17–2.96:1）',
    );
    assert.match(
      src,
      /theme-text-primary border-b-2 theme-accent-ink-border/,
      'AuthModal 的激活标签页应改用 theme-text-primary + theme-accent-ink-border',
    );
  });

  it('.theme-accent-ink-border 工具类存在且读 --color-accent-text', () => {
    const rule = block(GLOBAL, '.theme-accent-ink-border');
    assert.ok(rule, 'global.css 里找不到 .theme-accent-ink-border');
    assert.match(rule, /var\(--color-accent-text\)/, '激活下划线应读 --color-accent-text');
  });
});

describe('P1-1：--focus-ring 必须是不透明描边（22% 的柔光只有 1.2:1）', () => {
  for (const theme of THEMES) {
    for (const dark of [false, true]) {
      it(`${theme}/${dark ? 'dark' : 'light'}`, () => {
        const css = read(`src/styles/themes/${theme}.css`);
        const scope = themedBlock(css, theme, dark ? '.dark' : ' {');
        const raw = token(scope, '--focus-ring');
        assert.ok(raw, `${theme}/${dark ? 'dark' : 'light'} 没有定义 --focus-ring`);
        // 允许的形态：实色（#rrggbb）。rgba(...) 的半透明光环叠在底上只有 ~1.2:1。
        const colors = [...raw.matchAll(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}/g)].map(m => m[0]);
        assert.ok(colors.length > 0, `--focus-ring = "${raw}" 里解析不出颜色`);
        for (const c of colors) {
          assert.doesNotMatch(
            c,
            /^rgba\(/,
            `--focus-ring = "${raw}" 用了半透明色 ${c} —— 叠在底上只有 ~1.2:1，键盘用户看不到焦点在哪（应改为不透明描边 + 内芯）`,
          );
        }
      });
    }
  }
});

describe('D-1/D-2：源码里不得再出现写死的灰阶（回归：改回 text-gray-600）', () => {
  it('MainApp 页脚用 theme-text-muted，不再写死 text-gray-600 / dark:text-gray-400', () => {
    const src = read('src/components/app/MainApp.tsx');
    const footer = src.match(/<footer[^>]*>/)?.[0] ?? '';
    assert.ok(footer, 'MainApp.tsx 里找不到 <footer>');
    assert.doesNotMatch(
      footer,
      /text-gray-\d+|dark:text-gray-\d+/,
      `页脚仍写着写死的灰阶：「${footer}」`,
    );
    assert.match(footer, /theme-text-muted/, '页脚应改用主题令牌 theme-text-muted');
  });

  it('设置页的说明文字用主题令牌，不再写死 text-gray-400/500 或 text-amber-600', () => {
    const files = [
      'src/options/OptionsPage.tsx',
      'src/components/sync/WebDavSettings.tsx',
      'src/components/layout/ThemeStyleSelector.tsx',
    ];
    for (const file of files) {
      const src = read(file);
      assert.doesNotMatch(
        src,
        /text-gray-(?:400|500)\b/,
        `${file}：仍有写死的 text-gray-400/500（不跟主题走，深浅色下都低于 AA）`,
      );
      assert.doesNotMatch(
        src,
        /text-amber-(?:500|600)\b/,
        `${file}：仍有写死的 text-amber-500/600（浅底上只有 3.19:1，而这是安全告警）`,
      );
    }
  });

  it('.theme-text-warning 工具类存在（警告色要走主题令牌）', () => {
    const rule = block(GLOBAL, '.theme-text-warning');
    assert.ok(rule, 'global.css 里找不到 .theme-text-warning');
    assert.match(rule, /var\(--color-warning\)/, '.theme-text-warning 应读 --color-warning');
  });
});

describe('P2-5：写死的浅色/主色不再直接压在小字上', () => {
  it('Toast 的类型标签与关闭按钮用 theme-text-muted（原先 text-slate-400 只有 2.55:1）', () => {
    const src = read('src/components/common/Toast.tsx');
    assert.doesNotMatch(
      src,
      /text-slate-400\b/,
      'Toast.tsx 里仍有 text-slate-400（2.55:1，12px 小字低于 AA）',
    );
    assert.match(
      src,
      /theme-text-muted/,
      'Toast 的类型标签应改用 theme-text-muted',
    );
  });

  it('Toast 的警告图标底用深琥珀（原先 bg-amber-100 + text-amber-600 只有 2.86:1）', () => {
    const src = read('src/components/common/Toast.tsx');
    assert.doesNotMatch(
      src,
      /bg-amber-100 text-amber-600/,
      'Toast 的警告图标仍是 bg-amber-100 + text-amber-600（2.86:1）',
    );
    assert.match(
      src,
      /bg-amber-100 text-amber-800/,
      'Toast 的警告图标应改用 bg-amber-100 + text-amber-800',
    );
  });

  it('ErrorBoundary 的「重试」按钮走主题 CTA（原先 bg-primary-500 text-white 只有 3.68:1）', () => {
    const src = read('src/components/common/ErrorBoundary.tsx');
    assert.doesNotMatch(
      src,
      /bg-primary-500 text-white/,
      'ErrorBoundary 的重试按钮仍写死 bg-primary-500 text-white（3.68:1）',
    );
    assert.match(src, /theme-cta/, 'ErrorBoundary 的重试按钮应改用 theme-cta');
  });

  it('认证表单的加载指示器不写死 text-white（深色主题下只有 1.67:1）', () => {
    for (const file of ['src/components/auth/LoginForm.tsx', 'src/components/auth/RegisterForm.tsx']) {
      const src = read(file);
      // 只查 spinner 那个 <svg> 上的 text-white：写在 className 里的
      // `focus-visible:outline-slate-300` 之类不在此列。
      const spinner = src.match(/<svg[^>]*className="[^"]*text-white[^"]*"/) ?? null;
      assert.equal(
        spinner,
        null,
        `${file}：spinner 上仍写死 text-white —— 深色主题的 .theme-cta 底是亮色，白字只有 1.67–3.68:1（应继承 --color-accent-fg）`,
      );
    }
  });

  it('主题色圆点的图标按底色亮度选墨色，不再一律 text-white（creamy 只有 2.23:1）', () => {
    const src = read('src/components/layout/ThemeStyleSelector.tsx');
    assert.doesNotMatch(
      src,
      /className="[^"]*\btext-white\b[^"]*"[^>]*>\s*<(?:svg|Check|span)/,
      '主题色圆点仍写死 text-white（creamy 的 #d97706 上只有 2.23:1）',
    );
    assert.match(
      src,
      /readableInkOn\(/,
      '主题色圆点应按底色亮度用 readableInkOn() 选墨色',
    );
    // 选墨色的判据本身要对：WCAG 相对亮度 0.179 分界
    const fn = src.match(/function readableInkOn[\s\S]*?\n}/)?.[0] ?? '';
    assert.match(fn, /0\.179/, 'readableInkOn 的明暗分界应取 WCAG 常用的 0.179');
    assert.match(fn, /#000000|#ffffff/, 'readableInkOn 应返回黑或白墨色');
  });
});

describe('P2-6：死的 --color-cta / .btn-cta 不得复活', () => {
  it('micro-interactions.css 里不再有 .btn-cta 规则', () => {
    const css = read('src/styles/micro-interactions.css');
    assert.doesNotMatch(
      css,
      /\.btn-cta\b/,
      'micro-interactions.css 里又有 .btn-cta —— 它引用的 --color-cta 全仓从未定义（该类在 TSX 里零引用）',
    );
  });

  it('全仓没有 --color-cta / --color-cta-hover 的定义或引用', () => {
    const files = [
      'src/styles/micro-interactions.css',
      'src/styles/global.css',
      ...THEMES.map(t => `src/styles/themes/${t}.css`),
    ];
    for (const file of files) {
      const src = read(file);
      assert.doesNotMatch(
        src,
        /--color-cta(-hover)?\s*:/,
        `${file}：又定义了 --color-cta —— 这组令牌从未被任何主题定义，引用它的规则永远拿到空值`,
      );
    }
  });
});
