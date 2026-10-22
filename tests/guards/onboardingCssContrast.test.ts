// 引导页 CSS 的文字对比度（2026-10-20 真机巡检发现）。
//
// ── 这个文件要防的回归类别 ────────────────────────────────────────────────
//
// 用户引导是「装扩展 → 第一次打开管理页」就会出现的东西 —— 它是**新用户
// 的第一印象**，而这张印象发生在**真实 popup 尺寸（400×600）**里。
//
// 真机巡检（scripts/prod-onboarding-narrow.mjs）实测发现：引导页的特性卡片
// 说明文字（**10px**，本仓最小号的正文）在浅色态的对比度只有 **2.43:1**
// （#9ca3af 叠在 #f9fafb 上），「跳过」按钮的 12px 字只有 **2.54:1**
// （#9ca3af 叠在引导卡的近白底 rgba(255,255,255,.97) 上）——
// 都远低于 WCAG AA 的正文线 4.5:1。
//
// 「跳过」两个字尤其要紧：它是用户**放弃引导**的入口，却最看不清。
//
// ── 为什么这类缺陷此前没人守 ─────────────────────────────────────────────
//
// ① 引导页的 CSS（src/styles/onboarding.css）**自成一套**，完全没用主题令牌
//    ⇒ 它的颜色不跟主题走 ⇒ 六套主题下都一样 ⇒ 换主题救不了它。
// ② 仓库里那些对比度守卫盯的是 **className**（Tailwind 类），
//    而这里的颜色写死在 **CSS 规则里** ⇒ 那些守卫扫不到。
//
// ── 判据：从 CSS 里读事实，不写死期望值 ──────────────────────────────────
//
// ① **扫全文件**的每一条 `color:` 声明（不只我修过的那几处）——
//    否则「再加一条规则」这个动作本身就会造出一个新的盲区
//    （与 tests/guards/hardcodedGrayTextScanned.test.ts 同一个道理：
//    守卫要钉事实，不该钉「已知的坏文件」）。
// ② 底色从**同一条规则**里取（background-color / background）。
//    没有底色 ⇒ 按「引导卡内层」的底色算：
//    浅色 rgba(255,255,255,.97)、深色 rgba(30,30,40,.97)。
// ③ 渐变底取**两端里较差的那个** —— 渐变的任何位置都可能出现，
//    两端都达标才算达标。
// ④ 令牌（`var(--color-*)`）**不参与本守卫** —— 它们的达标性由
//    tests/guards/a11yTextAndFocusTokens.test.ts 单独钉死
//    （6 套主题 × 明暗 × 6 种表面色全部 ≥ 4.5:1）。
//    但本守卫会**要求**：文字色若是令牌，就必须真的定义过。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CSS = readFileSync(resolve(ROOT, 'src/styles/onboarding.css'), 'utf8');
const GLOBAL = readFileSync(resolve(ROOT, 'src/styles/global.css'), 'utf8');

type Rgb = { r: number; g: number; b: number; a: number };

function parseColor(raw: string): Rgb | null {
  const value = String(raw).trim();
  if (!value) return null;
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a,
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

function over(fg: Rgb, bg: Rgb): Rgb {
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

/** 规则块（含选择器与声明）。 */
interface Rule {
  selector: string;
  decls: Map<string, string>;
}

/** 解析 CSS（剥掉注释）成规则列表。 */
const parseRules = (css: string): Rule[] => {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const rules: Rule[] = [];
  for (const m of stripped.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const decls = new Map<string, string>();
    for (const d of m[2].matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) {
      decls.set(d[1], d[2].trim());
    }
    if (decls.size) rules.push({ selector: m[1].trim(), decls });
  }
  return rules;
};

const RULES = parseRules(CSS);

/** 引导卡内层的底色（浅 / 深）。 */
const CARD_SURFACE = {
  light: parseColor('rgba(255, 255, 255, 0.97)')!,
  dark: parseColor('rgba(30, 30, 40, 0.97)')!,
};

/** 一条规则里，文字色在两个明暗态下的最差对比度（以及它是什么）。 */
interface Finding {
  selector: string;
  colorRaw: string;
  worst: number;
  worstState: 'light' | 'dark';
  /** 令牌还是字面量（令牌由另一个守卫负责达标性）。 */
  isToken: boolean;
}

/** 从一条规则的 background 里取底色；渐变取两端。 */
const backgroundsOf = (decls: Map<string, string>): { light: Rgb[]; dark: Rgb[] } | null => {
  const raw = decls.get('background-color') ?? decls.get('background');
  if (!raw) return null;
  const light: Rgb[] = [];
  const dark: Rgb[] = [];
  // 渐变：逐个色标都算，���端取较差者
  const colorStops = [...raw.matchAll(/#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)/g)].map(m => parseColor(m[0])).filter(Boolean) as Rgb[];
  if (colorStops.length) {
    light.push(...colorStops);
    dark.push(...colorStops);
    return { light, dark };
  }
  const c = parseColor(raw);
  if (!c) return null;
  light.push(c);
  dark.push(c);
  return { light, dark };
};

/**
 * 这条规则在哪个明暗态生效。
 *
 * 【CSS 的实际语义】一条**基础**规则（如 `.onboarding-title { color: #111827 }`）
 * 在两个态都生效，但深色态会被**更高特异性的 `.dark .onboarding-title` 覆盖**。
 * ⇒ 基础规则的字面量颜色**只在浅色态**参与判定（深色态生效的是那条覆盖）。
 *
 * 第一版守卫把基础规则同时算进深色态 ⇒ 7 条**假红**
 * （`#111827` 在深色底上 1.07:1 —— 但深色态那里根本不是这个颜色）。
 *
 * ⇒ 判据：
 *   · 选择器以 `.dark` 开头 ⇒ 只在深色态算；
 *   · 其余（基础规则 + `:not(.dark)`）⇒ 只在浅色态算。
 */
const appliesIn = (selector: string): 'light' | 'dark' =>
  selector.trim().startsWith('.dark') ? 'dark' : 'light';

describe('引导页 CSS：文字对比度达到 WCAG AA 正文线 4.5:1', () => {
  it('引导页里每条 color 声明都被扫到了（扫描器本身没坏）', () => {
    // ⚠️ 2026-10-23 审计 V-1：这个自证的锚点原先是「带 `color` 声明的规则条数
    // ≥ 15」。**锚点选错了** —— 它数的是「规则数」，不是「颜色数」。
    // V-1 把引导页的写死颜色全部换成主题令牌（`var(--color-*)`）之后，
    // 规则总数自然从 20+ 掉到 13 ⇒ 守卫**假红**（"扫描器坏了"），可扫描器
    // 一点没坏。
    //
    // ⇒ 改成数「**真正带颜色值**的规则」：字面量或主题令牌都算 ——
    // 这才是「扫描器扫到了东西」这件事本身的判据。
    // 「引导页不得有写死的品牌色」由 tests/guards/audit20261023UiVisual.test.ts
    // 单独钉（那是 V-1 的语义不变量，与本守卫的对比度职责分工）。
    const withColor = RULES.filter(r => r.decls.has('color'));
    const withColorValue = withColor.filter(r => {
      const c = r.decls.get('color') ?? '';
      return (
        c.startsWith('var(--') ||
        /^#[0-9a-fA-F]{3,8}$/.test(c) ||
        /^rgba?\(/.test(c) ||
        c === 'transparent'
      );
    });
    assert.ok(
      withColorValue.length >= 13,
      `只扫到 ${withColorValue.length} 条真正带颜色值的规则（带 color 声明的共 ${withColor.length} 条），扫描器可能坏了`
    );
    // 抽查一条：我们知道它有 color
    assert.ok(
      RULES.some(r => r.selector.includes('.onboarding-feature-desc')),
      '规则列表里必须有 .onboarding-feature-desc'
    );
    // 抽查：同一个「带 color 声明」但**解析不出颜色**的规则不该被算进来 ——
    // 否则「扫描器扫到了东西」就退化成一个计数游戏。
    assert.equal(
      withColorValue.length,
      withColor.length,
      '每条带 color 声明的规则都应当解析得出颜色值 —— 有解析不出来的，说明扫描器的解析分支变了'
    );
  });

  it('字面量颜色在引导卡底色上必须 ≥ 4.5:1（浅深两态都算）', () => {
    const findings: Finding[] = [];
    for (const rule of RULES) {
      const colorRaw = rule.decls.get('color');
      if (!colorRaw) continue;
      if (colorRaw.startsWith('var(')) continue; // 令牌由另一个守卫负责
      const fg = parseColor(colorRaw);
      if (!fg) continue;

      const bg = backgroundsOf(rule.decls);
      const states: Array<{ state: 'light' | 'dark'; surfaces: Rgb[] }> = bg
        ? [
            { state: 'light', surfaces: bg.light },
            { state: 'dark', surfaces: bg.dark },
          ]
        : [
            { state: 'light', surfaces: [CARD_SURFACE.light] },
            { state: 'dark', surfaces: [CARD_SURFACE.dark] },
          ];

      for (const { state, surfaces } of states) {
        // 一条规则只在一个态生效（见 appliesIn 的说明）
        if (appliesIn(rule.selector) !== state) continue;

        for (const surface of surfaces) {
          const base = state === 'light' ? CARD_SURFACE.light : CARD_SURFACE.dark;
          const bgSolid = surface.a < 1 ? over(surface, base) : surface;
          const fgSolid = fg.a < 1 ? over(fg, bgSolid) : fg;
          const r = contrast(fgSolid, bgSolid);
          findings.push({
            selector: rule.selector,
            colorRaw,
            worst: r,
            worstState: state,
            isToken: false,
          });
        }
      }
    }

    const bad = findings.filter(f => f.worst < 4.5);
    assert.equal(
      bad.length,
      0,
      `引导页有 ${bad.length} 处文字低于 WCAG AA 正文线 4.5:1 —— ` +
        `引导是**新用户的第一印象**，而且发生在 400×600 的真实面板里。\n` +
        bad
          .map(f => `  · ${f.selector} — color:${f.colorRaw}（${f.worstState} 态 ${f.worst.toFixed(2)}:1）`)
          .join('\n')
    );
  });

  it('文字色若是主题令牌，该令牌必须在 global.css 里定义过', () => {
    const tokenUses = RULES.filter(r => {
      const c = r.decls.get('color');
      return c?.startsWith('var(--color-');
    });
    assert.ok(tokenUses.length > 0, '引导页应当至少有一处用主题令牌（否则颜色不跟主题走）');

    for (const rule of tokenUses) {
      const name = rule.decls.get('color')!.match(/var\((--[\w-]+)\)/)![1];
      assert.ok(
        GLOBAL.includes(`${name}:`),
        `${rule.selector} 用了 ${name}，但 global.css 里没有定义它 —— 浏览器会当成无效值，文字会继承父色（对比度未知）`
      );
    }
  });

  it('（事实来源）引导页的「跳过」按钮与说明文字确实走主题令牌', () => {
    // 这两条是本轮真机巡检直接抓出来的两处（2.54:1 与 2.43:1）。
    // 钉住它们走令牌 ⇒ 令牌本身的达标性由 a11yTextAndFocusTokens 负责。
    const skip = RULES.find(r => r.selector.trim() === '.onboarding-btn-skip');
    assert.ok(skip, '找不到 .onboarding-btn-skip 规则');
    assert.match(
      skip!.decls.get('color') ?? '',
      /var\(--color-text-muted\)/,
      '「跳过」按钮应当走主题令牌（原先 #9ca3af 在近白底上只有 2.54:1）'
    );

    const desc = RULES.find(r => r.selector.trim() === '.onboarding-feature-desc');
    assert.ok(desc, '找不到 .onboarding-feature-desc 规则');
    assert.match(
      desc!.decls.get('color') ?? '',
      /var\(--color-text-muted\)/,
      '特性卡片说明应当走主题令牌（原先 #9ca3af 在浅色卡片底上只有 2.43:1）'
    );
  });
});
