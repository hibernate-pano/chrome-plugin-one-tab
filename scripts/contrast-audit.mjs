// 主题对比度实测（2026-10-22 审计 U-12 / U-13 / U-16 / U-01）。
//
// 口径：**自己解析主题 CSS 的真实级联**（不是复制一份令牌快照）——
//   主题文件（未分层）> global.css 的 @layer base（:root / html.dark）
// 叠色链按真实绘制顺序：页面 → 顶栏浮层 → 卡片 → 卡头 → 井/抬升。
// 颜色公式：WCAG 相对亮度（sRGB，阈值 0.03928）与对比度 (L1+0.05)/(L2+0.05)。
// 半透明前景先叠到底色上；渐变取**每一档色标**里最差的那个。
//
// 用法：node scripts/contrast-audit.mjs [--verbose]
// 退出码非 0 表示有组合不达标（可直接进 CI）。

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const THEMES = ['legacy', 'creamy', 'prism', 'claude', 'apple', 'chrome'];
const VERBOSE = process.argv.includes('--verbose');

/* ── CSS 解析 ─────────────────────────────────────────────── */

const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, ' ');

function read(rel) {
  return stripComments(readFileSync(resolve(ROOT, rel), 'utf8'));
}

/** 取某个选择器的声明块（花括号配对，@media 内的同名块也能正确切出来）。 */
function block(css, selector) {
  const at = css.indexOf(selector);
  if (at === -1) return '';
  const open = css.indexOf('{', at + selector.length - 1);
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

function token(css, name) {
  const all = [...css.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))];
  return all.length ? all[all.length - 1][1].trim() : '';
}

/* ── 颜色 ─────────────────────────────────────────────────── */

const HEX = /^#([0-9a-f]{3,8})$/i;

function parseColor(raw) {
  if (!raw) return null;
  const v = raw.trim();
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const hex = v.match(HEX);
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
  const fn = v.match(/^rgba?\(([^)]+)\)$/i);
  if (fn) {
    const p = fn[1].split(/[,/]/).map(x => parseFloat(x.trim())).filter(n => !Number.isNaN(n));
    if (p.length < 3) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  return null;
}

/** 渐变 → 每一档色标；单色 → 单元素数组。 */
function parseStops(raw) {
  if (!raw) return [];
  const v = raw.trim();
  if (!/gradient\(/i.test(v)) {
    const c = parseColor(v);
    return c ? [c] : [];
  }
  const inner = v.slice(v.indexOf('(') + 1, v.lastIndexOf(')'));
  const stops = [];
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

function over(fg, bg) {
  if (!fg) return bg;
  if (fg.a >= 1) return { ...fg, a: 1 };
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

function luminance(c) {
  const f = v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/* ── 主题状态 ─────────────────────────────────────────────── */

const GLOBAL = read('src/styles/global.css');
const GLOBAL_ROOT = block(GLOBAL, ':root {');
const GLOBAL_DARK = block(GLOBAL, 'html.dark {');

function themeScope(css, theme, dark) {
  const suffix = dark ? '.dark' : '';
  for (const q of ['"', "'"]) {
    const b = block(css, `html[data-theme=${q}${theme}${q}]${suffix} {`);
    if (b) return b;
  }
  return '';
}

function loadState(theme, dark) {
  const css = read(`src/styles/themes/${theme}.css`);
  const darkScope = themeScope(css, theme, true);
  const lightScope = themeScope(css, theme, false);
  const raw = name => {
    // 级联：主题块（未分层）永远压过 global 的 @layer base；
    // 同为未分层时，主题深色块（0,2,1）压过主题浅色块（0,1,1）。
    if (dark) {
      return token(darkScope, name) || token(lightScope, name) || token(GLOBAL_DARK, name) || token(GLOBAL_ROOT, name);
    }
    // 浅色态：html.dark 那块**不匹配**（html 上没有 .dark），只有 :root 兜底。
    return token(lightScope, name) || token(GLOBAL_ROOT, name);
  };
  // 令牌值里可能还有 var(--x) 引用（例如 --color-card-head-bg: var(--color-bg-tertiary)）
  const tok = name => {
    const seen = new Set();
    const resolve = (value, depth) => {
      if (!value || depth > 6) return value;
      return value.replace(/var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]*))?\)/gi, (_, name2, fallback) => {
        if (seen.has(name2)) return fallback ? resolve(fallback, depth + 1) : '';
        seen.add(name2);
        const next = tok(name2) || (fallback ? fallback.trim() : '');
        return resolve(next, depth + 1);
      });
    };
    return resolve(raw(name), 0);
  };

  const white = { r: 255, g: 255, b: 255, a: 1 };
  const page = over(parseColor(tok('--color-bg-primary')), white);
  const card = over(parseColor(tok('--color-bg-secondary')), page);

  const cardHeadStops = parseStops(tok('--color-card-head-bg'));
  const cardHead = cardHeadStops.length
    ? cardHeadStops.map(c => over(c, card))
    : [card];
  const well = over(parseColor(tok('--color-well')), card);
  const overlay = over(parseColor(tok('--color-bg-overlay')), page);
  const elevated = over(parseColor(tok('--color-bg-elevated')), page);
  const tertiary = over(parseColor(tok('--color-bg-tertiary')), card);
  const softStops = parseStops(tok('--color-accent-soft'));
  // 卡头可能是渐变 ⇒ 强调淡染要叠在**每一档**卡头色标上（取最差的那档）。
  // 只叠第一档会漏判：prism 浅色的徽章真机实测 4.23:1，模型却算出 5.07:1
  // （真机抓出来的，模型当时漏掉了渐变的第二档色标）。
  const overEach = (stops, bases) => stops.flatMap(c => bases.map(b => over(c, b)));
  const accentSoft = overEach(softStops, cardHead);
  const accentSoftOnOverlay = softStops.map(c => over(c, overlay));
  const accentSubtle = overEach(parseStops(tok('--color-accent-subtle')), cardHead);
  const accentWash = overEach(parseStops(tok('--color-accent-wash')), cardHead);

  // 同步按钮里的不定式进度条：轨道（--color-bg-tertiary）压在按钮底
  // （accent-soft，顶栏浮层上）之上，进度条压在轨道之上。
  const trackOnSoft = over(parseColor(tok('--color-bg-tertiary')), accentSoftOnOverlay[0]);

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
      accentSoft,
      accentSoftOnOverlay,
      trackOnSoft: [trackOnSoft],
      accentSubtle,
      accentWash,
      accent: accent ? [accent] : [],
      accentHover: accentHover ? [accentHover] : [],
    },
  };
}

/* ── 判据对 ───────────────────────────────────────────────── */

const TEXT_MIN = 4.5;
const ICON_MIN = 3.0;

/** [前景令牌, 底面, 阈值, 说明] */
function pairs(state) {
  const t = state.tok;
  const s = state.surfaces;
  const c = name => parseColor(t(name));
  const list = [];

  const push = (fgToken, bgName, min, note) => list.push({ fgToken, bgName, min, note });

  // 文字层：页面 / 卡片 / 卡头 / 井 / 浮层
  for (const bg of ['page', 'card', 'cardHead', 'well', 'overlay', 'elevated']) {
    push('--color-text-primary', bg, TEXT_MIN, '正文');
    push('--color-text-secondary', bg, TEXT_MIN, '次级文字');
  }
  // 三级面：设置页「当前主题」那个 pill（theme-bg-tertiary + theme-text-secondary）
  push('--color-text-secondary', 'tertiary', TEXT_MIN, '次级文字 / 三级面（主题 pill）');
  for (const bg of ['page', 'card', 'cardHead']) {
    push('--color-text-tertiary', bg, TEXT_MIN, '三级文字（图标按钮的墨色）');
    push('--color-text-muted', bg, TEXT_MIN, '提示色（12px 小字）');
    push('--color-accent-text', bg, TEXT_MIN, '强调文字色');
  }
  // 图标 / 非文本层
  for (const bg of ['page', 'card', 'cardHead', 'tertiary']) {
    push('--color-accent', bg, ICON_MIN, '强调图标（「恢复整个会话」那颗）');
    push('--color-focus-ring', bg, ICON_MIN, '焦点环');
  }
  push('--color-accent-strong', 'accentWash', ICON_MIN, '强调图标（空态）');

  // 实底上的墨色
  list.push({ fgToken: '--color-accent-fg', bgName: 'accent', min: TEXT_MIN, note: '主按钮墨色' });
  list.push({ fgToken: '--color-accent-fg', bgName: 'accentHover', min: 3.5, note: '主按钮 hover 墨色' });

  // 数量徽章：accent 文字压在 accent-soft / accent-subtle 底上
  list.push({ fgToken: '--color-accent-text', bgName: 'accentSoft', min: TEXT_MIN, note: '徽章文字 / accent-soft 底' });
  list.push({ fgToken: '--color-accent-text', bgName: 'accentSubtle', min: TEXT_MIN, note: '强调文字 / accent-subtle 底' });

  // 顶栏上传/下载按钮（U-01）：accent 文字压在 accent-soft 底上（底是顶栏浮层）
  list.push({ fgToken: '--color-accent-text', bgName: 'accentSoftOnOverlay', min: TEXT_MIN, note: '同步按钮（U-01）' });

  // 同步进度条（U-01 附带：进度条原先写死 text-green-600 / bg-gray-200）
  // 进度条取 --color-accent-text：--color-success 在 legacy/prism/apple 浅色
  // 的轨道上只有 2.04–2.08:1（低于非文本 3:1），accent 墨色最差 4.89:1。
  list.push({ fgToken: '--color-accent-text', bgName: 'trackOnSoft', min: ICON_MIN, note: '进度条（accent 墨色）/ 轨道' });
  list.push({ fgToken: '--color-accent', bgName: 'trackOnSoft', min: ICON_MIN, note: '进度条（accent）/ 轨道' });

  return list;
}

const SURFACE_LABEL = {
  page: '页面底',
  card: '卡片底',
  cardHead: '卡头底',
  well: '井底',
  overlay: '顶栏浮层',
  elevated: '抬升面',
  tertiary: '三级面',
  accent: 'accent 实底',
  accentHover: 'accent hover 实底',
  accentSoft: 'accent-soft 底（卡头上）',
  accentSoftOnOverlay: 'accent-soft 底（顶栏浮层上）',
  trackOnSoft: '进度条轨道（按钮底上）',
  accentSubtle: 'accent-subtle 底',
  accentWash: 'accent-wash 底',
};

/** 一对里取最差（渐变取最差色标）。 */
function worst(state, fgToken, bgName) {
  const fg = parseColor(state.tok(fgToken));
  if (!fg) return { ratio: null, note: '令牌缺失' };
  const bgs = state.surfaces[bgName];
  if (!bgs || !bgs.length) return { ratio: null, note: '底面缺失' };
  let min = Infinity;
  for (const bg of bgs) {
    const r = contrast(fg, bg);
    if (r < min) min = r;
  }
  return { ratio: min, note: bgs.length > 1 ? `渐变 ${bgs.length} 档取最差` : '' };
}

let failures = 0;
const worstPerState = new Map();

for (const theme of THEMES) {
  for (const dark of [false, true]) {
    const state = loadState(theme, dark);
    const rows = [];
    for (const p of pairs(state)) {
      const { ratio, note } = worst(state, p.fgToken, p.bgName);
      if (ratio === null) {
        failures++;
        rows.push(`  ✗ ${p.fgToken} / ${p.bgName}：${note}`);
        continue;
      }
      const ok = ratio >= p.min;
      if (!ok) failures++;
      rows.push(`  ${ok ? '·' : '✗'} ${p.fgToken.padEnd(24)} / ${SURFACE_LABEL[p.bgName].padEnd(16)} ${ratio.toFixed(2)}:1 (≥${p.min}) ${p.note}${note ? ' — ' + note : ''}`);
      const prev = worstPerState.get(state.key);
      if (!prev || ratio < prev.ratio) worstPerState.set(state.key, { ratio, min: p.min, label: `${p.fgToken} / ${SURFACE_LABEL[p.bgName]}` });
    }
    console.log(`\n=== ${state.key} ===`);
    if (VERBOSE) console.log(rows.join('\n'));
    else console.log(rows.filter(r => r.startsWith('  ✗')).join('\n') || '  （全部通过）');
    const w = worstPerState.get(state.key);
    console.log(`  最差：${w.label} ${w.ratio.toFixed(2)}:1（阈值 ${w.min}）`);
  }
}

console.log('\n=== 汇总：每套主题的最差值 ===');
for (const [key, w] of worstPerState) {
  console.log(`  ${key.padEnd(16)} ${w.ratio.toFixed(2)}:1  ${w.ratio >= w.min ? '✅' : '❌'}  ${w.label}`);
}
console.log(`\n不达标组合：${failures}`);
process.exit(failures === 0 ? 0 : 1);
