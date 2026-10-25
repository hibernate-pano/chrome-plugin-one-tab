// 第 43 轮 · 视觉与可访问性守卫（2026-10-23 审计 V-1 / V-2 / V-3 / V-4 /
// V-5 / V-7 / V-8 / V-9 / V-10 / V-11 / V-12 / V-13 / V-14 / V-15 / V-16）。
//
// ── 2026-10-24：引导页配色回到 v1.25.1（产品负责人的决定）──────────────
// 这一轮只动 **V-1 那一节**（引导页配色），其余各节（V-2 … V-16）一条没动。
// V-1 的判据从「引导页必须跟主题」改成「引导页的色板就是 v1.25.1 那套」，
// 但**安全判据只变严、没变松**（A4：白字压主按钮底必须 ≥ 4.5:1）。
// ⇒ 退掉的是**长相**，不是安全。详见 V-1 那节开头的完整说明。
//
// ═══════════════════════════════════════════════════════════════════════════
// 【这个文件要防的回归类别】
//
// A. **界面不跟主题**（V-3 / V-7 / V-10 / V-11）
//    ⋯ 菜单内容全是固定灰阶与固定品牌蓝、Toast 弹出
//    冷白卡片、提示条永远是冷灰底、主题选择环只有 1.87:1。
//    ⇒ 六套主题换过去，**这些表面一像素都不变**。
//
//    ⚠️ V-1（引导页）**已不在这一类里**：2026-10-24 产品负责人要求
//    「界面回到 v1.25.1 的样子」⇒ 引导页的写死配色是**产品决定**，不是缺陷。
//    V-1 现在钉的是「引导页的色板就是 v1.25.1 那套」+「白字压主按钮底
//    ≥ 4.5:1」（该节开头有完整的判据变更说明）。
//
// B. **焦点环被写死成品牌蓝**（V-2）
//    组件里写 `focus-visible:outline-primary-600` 之类 ⇒ 环不跟主题；深色
//    模式下压 apple/chrome/claude 的面板只有 2.70 / 2.78 / 2.96:1（要求 3:1）。
//
// C. **命中区不足**（V-4 / V-5）
//    「显示筛选」按钮 20px 高（< WCAG 2.2 的 24px，也 < 本仓的 36px）；
//    320px 下品牌按钮塌成 2.7×20px，logo 右侧 40% 点不到。
//
// D. **读屏重复播报**（V-8 / V-12 / V-15）
//    空态图标 `role="img" aria-label={title}` 与旁边 `<h3>` 逐字重复；
//    引导页 21 个 emoji 进了朗读队列；`role="tooltip"` 没有 id、
//    也没有元素用 `aria-describedby` 指向它 ⇒ 读屏用户拿不到那段说明。
//
// E. **切主题时一半硬切**（V-9）
//    主题过渡名单里全是**死类**（零引用），而真实的菜单 / 弹窗 / 空态
//    一个都不在 ⇒ 同一次切主题里列表在渐变、菜单在闪。
//
// F. **动效节奏分裂**（V-14）：60/80/100/120/150/200/250/300/400ms 九种时长
//    混用 ⇒ 同一次点击里三颗按钮反馈速度不同。
//
// ═══════════════════════════════════════════════════════════════════════════
// 【判据原则：钉不变量，不钉字面量】
//
// 本文件**不**写「onboarding.css 里必须出现 #667eea 的反面」这种断言 ——
// 改一次措辞就红，而且它只能防住那一个具体写法。
// 它钉的是**语义不变量**：
//   · 「引导页的色板就是 v1.25.1 那套，且白字压主按钮底 ≥ 4.5:1」
//     （V-1 —— 2026-10-24 产品决定：引导页的写死配色**是产品决定**；
//      A1/A2 钉长相、A3 钉深色态成套、A4 钉安全）
//   · 「每一套主题都必须声明自己的 :focus-visible」
//   · 「组件里不得出现写死颜色的焦点环工具类」
//   · 「⋯ 菜单里不得出现固定灰阶 / 固定品牌蓝的类名」
//   · 「命中区不足 36px 的按钮不得存在」
//   · 「读屏不得被同一段文字播报两遍」
//
// 【变异自证】每一节末尾都写了「把实现改坏会怎样」。下面是**实测记录** ——
// 每一项都真的把实现改坏过一次、确认本守卫变红、再改回来（改动用 cp 备份
// 还原，全程没有 git stash / git checkout）。
//
//   编号  改坏了什么                              变红的断言数
//   M1    onboarding 主按钮首色改回 #667eea         3
//        （A1 色板 + A4 对比度。⚠️ 2026-10-24 之前这条变异是
//        「主按钮改回写死渐变」—— 判据方向已随产品决定反转）
//   M2    删掉 claude.css 的 :focus-visible 块      2
//   M3    ModalFrame 关闭按钮加回                   1
//        focus-visible:outline-primary-600
//   M4    MENU_ROW 改回 text-gray-700              2
//   M5    「显示筛选」按钮去掉 min-h-9               2
//   M6    窄屏 .app-header-brand 的 min-width: 0    1
//   M7    Tooltip 去掉 id= 与 aria-describedby      1
//   M8    EmptyState 图标改回 role="img"           2
//        + aria-label={title}
//   M9    去掉一处真实的 emoji aria-hidden          1
//   M10   apple 深色底色改回 #000000                1
//   M11   主题过渡名单去掉 .ts-panel                1
//   M12   主题过渡名单放回死类 .dropdown-menu        1
//   M13   micro-interactions 的 .btn-icon 改回 60ms  1
//   M14   global.css 的 .btn 改回                   1
//        @apply transition-all duration-150
//   M15   Toast 壳体改回 bg-white/95（5 处）        2
//   M16   Tooltip 组件去掉 tooltip 类               1
//   M17   micro-interactions 加回                   1
//        .tooltip { opacity: 0 }
//   M18   .theme-accent-ring 改回                   1
//        --color-accent-border
//   M19   删掉 global.css 的 .ts-panel 规则          1
//   M20   420px 断点去掉 justify-content: center    1
//   M21   「显示筛选」去掉 whitespace-nowrap         1
//   M22   onboarding 标题色改回 var(--color-text-primary）        2
//   M23   onboarding 卡片内层底色改回 var(--color-bg-elevated）  2
//   M24   删掉 .dark .onboarding-title（深色态半途而废）         3
//   M25   onboarding 描述色换成色板外的 #71717a                 3
//   M26   onboarding 主按钮渐变换成色板内的浅色对
//        （#764ba2→#f093fb）                                    2
//   M27   onboarding 主按钮白字换成浅灰 #d1d5db                  2
//
//   ⚠️ M26 / M27 **只让 A4 变红**（A1/A2 全绿）—— 这是「A4 有**独立**
//   检测力」的证据：主按钮是「长相」与「安全」唯一交汇的地方，
//   A2 故意**不**钉它，交给 A4 用**不变量**（白字 ≥ 4.5:1）守着。
//   ⇒ 若哪天 A4 变绿而 A1/A2 也绿，就是判据失声了。
//
//   （M22–M27 的实测记录在 2026-10-24 那一轮：变异全部在
//     /tmp 的一次性沙箱里做，**没有碰共享工作树**。）
//
// ⚠️ 有一处**首测假阴性**值得记下来：M9 第一次改的是文件头注释里那句
// 「现在每个 emoji 容器都标 `aria-hidden="true"`」⇒ 守卫没红。
// 原因不是守卫不行，是**改错了地方**（注释里的字符串不影响代码）。
// ⇒ 变异必须改**真正生效的那一行**，否则「守卫没红」什么也证明不了。
//
// ── 口径提醒（2026-10-23 审计 §5）────────────────────────────────────
// 「守卫的覆盖面 ≠ 需求的覆盖面」：hardcodedGrayTextScanned 守的是**对比度**，
// contrast-audit 守的是**令牌自身**的对比，都不管「这个元素跟不跟当前主题」。
// 本文件管的就是「跟不跟主题」这个独立维度。
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

/**
 * 本轮扫的样式文件（V-14 的动效节奏）。
 *
 * 为什么是这五个：`src/styles/` 下只有它们定义 transition/animation；
 * `fonts.css` 只有 @font-face，`themes/*.css` 只定义令牌（颜色/形状），
 * 不定义时长 —— 主题文件里加时长意味着「同一套节奏在六套主题里各写一遍」。
 */
const STYLE_FILES = [
  'src/styles/global.css',
  'src/styles/onboarding.css',
  'src/styles/micro-interactions.css',
  'src/styles/animations.css',
  'src/styles/drag-drop.css',
] as const;

/** 主题选择器的引号风格不统一（creamy 用单引号），两种都要试。 */
function themeFocusVisibleBlock(css: string, theme: string): string {
  for (const sel of [
    `html[data-theme="${theme}"] :focus-visible`,
    `html[data-theme='${theme}'] :focus-visible`,
  ]) {
    const at = css.indexOf(sel);
    if (at === -1) continue;
    const open = css.indexOf('{', at);
    if (open === -1) continue;
    const close = css.indexOf('}', open);
    if (close === -1) continue;
    return css.slice(open + 1, close);
  }
  return '';
}

// ═══════════════════════════════════════════════════════════════════════════
// V-1：引导页的配色回到 v1.25.1（2026-10-24 产品负责人的决定）
// ═══════════════════════════════════════════════════════════════════════════
//
// 【这一节为什么改判据】
//
// 2026-10-23 审计 V-1 主张的是「引导页必须跟主题走」：主按钮读 --color-accent、
// 卡片描边读单色 accent、标题读 --color-text-primary、卡片底读
// --color-bg-elevated ……（理由：陶土红的产品里弹出一条紫蓝渐变按钮很怪）。
//
// 2026-10-24 产品负责人要求「界面回到 v1.25.1 的样子」⇒ **这一节退掉
// 「不得有写死色」那条主张**，改成钉「引导页的色板就是 v1.25.1 那套」。
// ⇒ 退掉的是**长相**，不是安全。
//
// 【退掉的是什么 / 没退的是什么】
//   退掉：①「引导页不得有写死色」②「关键表面必须读主题令牌」
//         ③「不得有 .dark 独立配色」
//   没退：④「白字压主按钮底 ≥ 4.5:1」—— 它从「**必须用令牌实现**」改成
//         「**用任何实现都必须达标**」⇒ 安全判据反而更强了：
//         令牌法下这条由 a11yTextAndFocusTokens 兜底，写死色后由本节兜底。
//         V-2（焦点环）/ V-4/V-5（命中区）/ V-8/V-12/V-15（读屏）…… 一条没动。
//
// 【每条断言钉的是「长相」还是「安全」】
//   A1 写死色只允许是 v1.25.1 那套色板          —— 钉的是**长相**
//   A2 关键表面必须是 v1.25.1 的值                —— 钉的是**长相**
//   A3 深色态覆盖必须成套、不得半途而废          —— 钉的是**长相**（完整性）
//   A4 白字压主按钮底必须 ≥ 4.5:1                —— 钉的是**安全**

/**
 * v1.25.1 的引导页色板（2026-10-24 回退的基准）。
 *
 * 唯一一处**刻意不完全等同于 v1.25.1**：紫蓝 `#667eea` → `#5b5bd6`。
 * 原因：v1.25.1 的白字压 #667eea 只有 3.66:1（14px 粗体 ⇒ 未达 AA 4.5:1）；
 * #5b5bd6 是同一支紫（视觉几乎无差），实测白字 5.37:1 ⇒ 达标。
 * 换句话说：**没有为「回到 v1.25.1」牺牲任何一条对比度判据**。
 */
const V1251_PALETTE = [
  // 主紫（#667eea 加深刻一档）+ 彩虹描边的其余四色
  '#5b5bd6', '#764ba2', '#f093fb', '#f5576c', '#fda085',
  // 步骤点（浅 / 深）
  '#d1d5db', '#4b5563',
  // 图标底 / 版本徽章底的浅蓝紫两色 + 深色态的深蓝紫两色
  '#eff6ff', '#ede9fe', '#1e293b', '#312e81',
  // 标题 / 描述
  '#111827', '#f9fafb', '#6b7280', '#9ca3af',
  // 卡片 / 次要按钮 / 快捷键
  '#e5e7eb', '#f3f4f6', '#374151', '#1f2937',
  // 主题选择卡（选中态）
  '#1e1b4b', '#818cf8',
  // 版本徽章文字
  '#4338ca', '#a5b4fc',
] as const;

/** 解析 CSS（剥掉注释）成规则列表。 */
function cssRules(css: string): Array<{ selector: string; body: string }> {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const out: Array<{ selector: string; body: string }> = [];
  for (const m of stripped.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    out.push({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] });
  }
  return out;
}

/** 一条规则的声明块（按**完整选择器**匹配；匹配不到 ⇒ 空串）。 */
function ruleBody(css: string, selector: string): string {
  return cssRules(css).find(r => r.selector === selector)?.body ?? '';
}

/** 声明块里某条声明的值（归一化空白）。 */
function declValue(body: string, prop: string): string {
  for (const decl of body.split(';')) {
    const at = decl.indexOf(':');
    if (at === -1) continue;
    if (decl.slice(0, at).trim() !== prop) continue;
    return decl.slice(at + 1).trim().replace(/\s+/g, ' ');
  }
  return '';
}

/** sRGB 相对亮度（WCAG 2.x 的定义）。 */
function relLum(hex: string): number {
  const h = hex.replace('#', '').toLowerCase();
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) / 255);
  const f = (s: number) => (s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** 两个颜色之间的对比度（WCAG 2.x 的定义）。 */
function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('V-1：引导页的配色回到 v1.25.1（2026-10-24 产品决定）', () => {
  const CSS = read('src/styles/onboarding.css');

  it('A1 引导页的写死色只允许是 v1.25.1 那套色板（钉的是**长相**）', () => {
    // 遮罩 `.onboarding-overlay` 的 rgba(0,0,0,.5) / .dark 的 rgba(0,0,0,.7)
    // 是**刻意**保留的：遮罩的作用就是压暗背景，主题化会让它在某些浅色
    // 主题下失效。⇒ 把这两条规则排除掉。
    const withoutOverlay = CSS.replace(/\.onboarding-overlay\s*\{[^}]*\}/g, ' ').replace(
      /\.dark\s+\.onboarding-overlay\s*\{[^}]*\}/g,
      ' ',
    );
    // 另一条例外：`mask` / `-webkit-mask` 里的 `#fff` 是**遮罩的镂空形状**
    // （纯白 = 全不透明 = 保留那块），不是「画出来的颜色」⇒ 不算写死的配色。
    const withoutMask = withoutOverlay.replace(
      /-?(?:webkit-)?mask\s*:[^;]*;/g,
      ' ',
    );
    const hexes = [...new Set(
      [...withoutMask.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0].toLowerCase()),
    )];
    const allowed = new Set<string>(V1251_PALETTE);
    const bad = hexes.filter(h => !allowed.has(h));
    assert.deepEqual(
      bad,
      [],
      `引导页里出现了 v1.25.1 色板之外的写死颜色 ${bad.join('、')} —— ` +
        '2026-10-24 的产品决定是「引导页配色就是 v1.25.1 那套」，' +
        '不是「可以随便加新颜色」。',
    );
  });

  it('A2 引导页的关键表面必须是 v1.25.1 的值（钉的是**长相**）', () => {
    // ⚠️ 这一条**故意钉字面量**：它钉的就是「长相」——
    //   产品负责人已经拍板「界面回到 v1.25.1 的样子」，
    //   引导页的色板因此是**冻结**的（动它 = 改产品决定，不是改实现）。
    //   唯一例外是主紫：v1.25.1 的 #667eea 加深刻一档成 #5b5bd6
    //   （白字 3.66:1 → 5.37:1，见 A4 与文件头说明）。
    //
    // ⚠️ **主按钮不在这一条的清单里** —— 那是 A4（安全）的地盘。
    //   理由：主按钮是「长相」与「安全」**唯一交汇**的地方
    //   （白字压紫蓝渐变）。把它交给 A4，A4 才有**独立的**检测力：
    //   换成色板内的浅色渐变（例：#764ba2→#f093fb）时 A1/A2 全绿，
    //   只有 A4 会红 —— 那才是「安全判据在独立工作」的证据。
    const cases: Array<[string, string, string]> = [
      ['.onboarding-card::before', 'background',
       'linear-gradient(135deg, #5b5bd6 0%, #764ba2 25%, #f093fb 50%, #f5576c 75%, #fda085 100%)'],
      ['.onboarding-card-inner', 'background', 'rgba(255, 255, 255, 0.97)'],
      ['.dark .onboarding-card-inner', 'background', 'rgba(30, 30, 40, 0.97)'],
      ['.onboarding-title', 'color', '#111827'],
      ['.dark .onboarding-title', 'color', '#f9fafb'],
      ['.onboarding-description', 'color', '#6b7280'],
      ['.dark .onboarding-description', 'color', '#9ca3af'],
      ['.onboarding-dot.active', 'background', 'linear-gradient(135deg, #5b5bd6, #764ba2)'],
      ['.onboarding-dot.completed', 'background', '#5b5bd6'],
      ['.onboarding-icon-wrapper', 'background', 'linear-gradient(135deg, #eff6ff, #ede9fe)'],
      ['.onboarding-version-badge', 'color', '#4338ca'],
      ['.onboarding-version-badge', 'background', 'linear-gradient(135deg, #eff6ff, #ede9fe)'],
    ];
    for (const [selector, prop, expected] of cases) {
      const body = ruleBody(CSS, selector);
      assert.ok(body, `onboarding.css 里找不到规则 ${selector} —— 判据锚点丢了`);
      const actual = declValue(body, prop);
      assert.equal(
        actual,
        expected,
        `${selector} 的 ${prop} 应当是 v1.25.1 的「${expected}」，现在是「${actual}」`,
      );
    }
  });

  it('A3 深色态的覆盖必须成套、不得半途而废（钉的是**长相**的完整性）', () => {
    // 引导页现在又是**写死配色**了 ⇒ 每一处浅色都必须有对应的深色覆盖，
    // 否则深色态会留下一块「浅色补丁」（在黑底上刺眼、或在浅色底上不可读）。
    // ⇒ 这里钉的是 v1.25.1 那**一整套**深色覆盖的清单：
    //   少一条 ⇒ 半途而废（红）；多一条 ⇒ 同样是改了长相（红）。
    const expected = [
      '.dark .onboarding-btn-secondary',
      '.dark .onboarding-btn-secondary:hover',
      '.dark .onboarding-btn-skip:hover',
      '.dark .onboarding-card-inner',
      '.dark .onboarding-description',
      '.dark .onboarding-dot',
      '.dark .onboarding-feature-card',
      '.dark .onboarding-feature-title',
      '.dark .onboarding-icon-wrapper',
      '.dark .onboarding-kbd',
      '.dark .onboarding-overlay',
      '.dark .onboarding-shortcut-desc',
      '.dark .onboarding-shortcut-item',
      '.dark .onboarding-spotlight-ring',
      '.dark .onboarding-theme-card',
      '.dark .onboarding-theme-card.selected',
      '.dark .onboarding-theme-name',
      '.dark .onboarding-title',
      '.dark .onboarding-version-badge',
    ];
    const actual = [
      ...new Set(
        cssRules(CSS)
          .map(r => r.selector)
          .filter(sel => sel.startsWith('.dark .onboarding-')),
      ),
    ].sort();
    assert.deepEqual(
      actual,
      expected,
      '引导页的 `.dark` 覆盖与 v1.25.1 的那一整套不一致 —— ' +
        '深色态要么半途而废（少一条）、要么被改了长相（多一条）。',
    );
  });

  it('A4 白字压主按钮底必须 ≥ 4.5:1（钉的是**安全**）', () => {
    // ⚠️ 这条**不是**长相，是**安全** —— 它没有跟着回退而变松：
    //   2026-10-23 之前它是「白字压 #667eea = 3.66:1 ⇒ 改用 --color-accent-fg」；
    //   2026-10-24 配色回到 v1.25.1 ⇒ 断言从「必须用令牌」改成
    //   「**无论怎么实现都必须达标**」⇒ 判据只变严了，没变松。
    //
    // ⚠️ 这一条**刻意不钉具体色值**，它钉的是**不变量**
    //   （白字压主按钮底 ≥ 4.5:1）⇒ 将来色板若再被打开（换紫、换渐变两端、
    //   把白字换成浅灰），这一条依然有效 —— 它是 A1/A2（长相）之外的兜底。
    //
    //   渐变的**每一端**都可能出现 ⇒ 取较差的那端算。
    const body = ruleBody(CSS, '.onboarding-btn-primary');
    assert.ok(body, 'onboarding.css 里找不到 .onboarding-btn-primary —— 判据锚点丢了');
    assert.equal(
      declValue(body, 'color'),
      'white',
      '主按钮的文字应当是白字（v1.25.1 的口径）',
    );
    const bg = declValue(body, 'background');
    const stops = [...bg.matchAll(/#[0-9a-fA-F]{3,8}/g)].map(m => m[0]);
    assert.ok(stops.length > 0, '主按钮的底色应当是渐变（至少要有一个色标）');
    const worst = Math.min(...stops.map(s => contrastRatio('#ffffff', s)));
    assert.ok(
      worst >= 4.5,
      `白字压主按钮底只有 ${worst.toFixed(2)}:1（最差的一端 ${stops.join('、')}）—— ` +
        '14px 粗体正文要 4.5:1（WCAG AA）。v1.25.1 的 #667eea 只有 3.66:1，' +
        '所以那一端必须用加深刻一档的 #5b5bd6。',
    );
  });

  it('引导页用的每个主题令牌都必须在 global.css 里定义过', () => {
    const global = read('src/styles/global.css');
    const used = [...CSS.matchAll(/var\((--color-[\w-]+)\)/g)].map(m => m[1]);
    assert.ok(
      used.length > 0,
      '引导页应当至少有一处用主题令牌（2026-10-20 的两处对比度修复走的就是令牌）',
    );
    for (const name of new Set(used)) {
      assert.ok(
        global.includes(`${name}:`),
        `引导页用了 ${name}，但 global.css 里没有定义它 —— 浏览器会当成无效值，颜色会继承父色`,
      );
    }
  });

  // ── 实测变异（2026-10-24 那一轮，编号见文件头的表）──────────────────
  // M1  主按钮首色改回 #667eea        ⇒ A1 + A4 变红（对比度 3.66:1）
  // M2  标题色改回 var(--color-text-primary)  ⇒ A2 变红
  // M3  卡片内层底色改回 var(--color-bg-elevated) ⇒ A2 变红
  // M4  删掉 .dark .onboarding-title   ⇒ A2 + A3 变红（深色态半途而废）
  // M5  描述色换成色板外的 #71717a     ⇒ A1 + A2 变红
  // M6  主按钮渐变换成色板内的浅色对    ⇒ **只有 A4** 变红
  // M7  主按钮白字换成浅灰 #d1d5db     ⇒ **只有 A4** 变红
  // ⇒ M6 / M7 是 A4 **独立**检测力的证据（主按钮不钉在 A2 里）。
});

// ═══════════════════════════════════════════════════════════════════════════
// V-2：焦点环归主题
// ═══════════════════════════════════════════════════════════════════════════

describe('V-2：焦点环的环色由主题给，组件里不得写死', () => {
  const RING_FILES = [
    'src/components/common/ModalFrame.tsx',
    'src/components/common/ConfirmDialog.tsx',
    'src/components/common/AlertDialog.tsx',
    'src/options/OptionsPage.tsx',
    'src/components/sync/SyncButton.tsx',
    'src/components/auth/AuthModal.tsx',
    'src/components/common/Toast.tsx',
  ] as const;

  it('组件里不得出现任何写死颜色的焦点环工具类', () => {
    const bad = /focus-visible:outline-(?:primary|slate|gray|amber|emerald|rose|sky|red|blue|green|yellow|indigo|violet|purple|pink|teal|cyan|lime|orange|fuchsia)-\d+/;
    for (const file of RING_FILES) {
      const src = read(file);
      assert.doesNotMatch(
        src,
        bad,
        `${file}：又出现了写死颜色的焦点环工具类 —— 环色必须由主题的 --color-focus-ring 给`,
      );
    }
  });

  it('组件里也不得出现 focus-visible:outline-none（那会把环整条吃掉）', () => {
    for (const file of RING_FILES) {
      const src = read(file);
      assert.doesNotMatch(
        src,
        /focus-visible:outline-none/,
        `${file}：focus-visible:outline-none 展开成 ` + '`outline: 2px solid transparent`' + ' ⇒ 焦点环整条消失',
      );
    }
  });

  for (const theme of THEMES) {
    it(`${theme}.css 声明自己的 :focus-visible（未分层），环色读 --color-focus-ring`, () => {
      const raw = readFileSync(resolve(ROOT, `src/styles/themes/${theme}.css`), 'utf8');
      const block = themeFocusVisibleBlock(raw, theme);
      assert.ok(
        block,
        `${theme}.css 里没有自己的 :focus-visible —— 环色会落到 global.css 的 @layer base 兜底，` +
          '被 Tailwind utilities 层压过（这正是 V-2 的根因）',
      );
      assert.match(
        block,
        /outline:\s*2px solid var\(--color-focus-ring\)/,
        `${theme} 的 :focus-visible 必须画 2px 实色环，环色读 --color-focus-ring`,
      );
      assert.match(
        block,
        /outline-offset:\s*2px/,
        `${theme} 的 :focus-visible 必须有正 offset（offset=0 时环贴在按钮填充上，同色就看不见）`,
      );
    });
  }

  it('主题的 :focus-visible 必须**未分层**（在 @layer 里会被 utilities 层压过）', () => {
    for (const theme of THEMES) {
      const raw = readFileSync(resolve(ROOT, `src/styles/themes/${theme}.css`), 'utf8');
      // 找到那条规则之前最近的 `@layer` 开头，若有 ⇒ 它被分层了。
      const at = raw.indexOf(`html[data-theme="${theme}"] :focus-visible`);
      const atSingle = raw.indexOf(`html[data-theme='${theme}'] :focus-visible`);
      const pos = at !== -1 ? at : atSingle;
      assert.ok(pos !== -1, `${theme}.css 找不到 :focus-visible 规则`);
      const before = raw.slice(0, pos);
      const layerAt = before.lastIndexOf('@layer');
      // 「最近的 @layer 之后没有闭合的 @layer 块」⇒ 这条规则在层内。
      // 简化判定：从最后一个 @layer 往后数花括号平衡。
      if (layerAt !== -1) {
        const tail = before.slice(layerAt);
        const opens = (tail.match(/\{/g) ?? []).length;
        const closes = (tail.match(/\}/g) ?? []).length;
        assert.ok(
          opens <= closes,
          `${theme}.css 的 :focus-visible 落在 @layer 里 —— 分层后会被 Tailwind utilities 层压过，` +
            '这条规则必须未分层（audit 报告 §V-2 给的写法就是未分层的）',
        );
      }
    }
  });

  // ── 实测变异 ────────────────────────────────────────────────────────
  // ① 把 claude.css 的 `html[data-theme="claude"] :focus-visible` 整块删掉
  //    ⇒ 「声明自己的 :focus-visible」变红。
  // ② 把 apple.css 那条的 outline 改成 `2px solid var(--color-accent)`
  //    ⇒ 「环色读 --color-focus-ring」变红。
  // ③ 把 ModalFrame 的关闭按钮加回 `focus-visible:outline-primary-600`
  //    ⇒ 「组件里不得写死颜色的焦点环工具类」变红。
});

// ═══════════════════════════════════════════════════════════════════════════
// V-3：⋯ 菜单的内容必须跟主题
// ═══════════════════════════════════════════════════════════════════════════

describe('V-3：⋯ 菜单的内容不得写死灰阶 / 固定品牌蓝', () => {
  const SRC = read('src/components/layout/HeaderDropdown.tsx');

  it('菜单里不得出现写死的 Tailwind 灰阶', () => {
    const offenders = [...SRC.matchAll(/\b(?:dark:)?text-gray-(?:100|300|400|500|600|700|800|900)\b/g)].map(
      m => m[0],
    );
    assert.deepEqual(
      [...new Set(offenders)],
      [],
      `菜单里还有写死的灰阶：${[...new Set(offenders)].join('、')} —— ` +
        '面板跟主题、里头的内容不跟主题，是「半成品」的观感来源。' +
        '修法：theme-text-primary / theme-text-muted。',
    );
  });

  it('菜单里不得出现写死的灰阶边框', () => {
    assert.doesNotMatch(
      SRC,
      /\b(?:dark:)?border-gray-\d+\b/,
      '菜单里还有写死的灰阶边框 —— 改用 theme-border-default',
    );
  });

  it('菜单里不得出现固定品牌蓝（text-primary-*）', () => {
    assert.doesNotMatch(
      SRC,
      /\b(?:dark:)?text-primary-\d+\b/,
      '菜单里还有固定品牌蓝 —— claude 的品牌色是陶土红，固定蓝是「别家产品的蓝」。改用 theme-accent-text。',
    );
  });

  it('（事实来源）菜单行确实走了主题令牌', () => {
    const menuRow = SRC.match(/const MENU_ROW\s*=\s*"([^"]+)"/);
    assert.ok(menuRow, '找不到 MENU_ROW 常量');
    assert.match(menuRow[1], /theme-text-primary/, '菜单行的文字必须走 theme-text-primary');
  });

  // ── 实测变异 ────────────────────────────────────────────────────────
  // ① 把 MENU_ROW 里的 `theme-text-primary` 换回 `text-gray-700 dark:text-gray-300`
  //    ⇒ 「菜单里不得出现写死的 Tailwind 灰阶」变红。
  // ② 把「去登录」的 `theme-accent-text` 换回 `text-primary-600`
  //    ⇒ 「不得出现固定品牌蓝」变红。
});

describe('V-3 连带：MENU_ROW 常量本身不得被改形状（守卫靠它区分菜单行与内联链接）', () => {
  it('MENU_ROW 仍然存在且仍带 theme-text-primary', () => {
    const SRC = read('src/components/layout/HeaderDropdown.tsx');
    assert.match(
      SRC,
      /const MENU_ROW\s*=/,
      'MENU_ROW 常量被删了 —— tests/guards/audit20261019Ui.test.ts 的 C-7 守卫靠它区分菜单行与状态卡里的内联链接',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// V-4 / V-5：命中区
// ═══════════════════════════════════════════════════════════════════════════

describe('V-4：「显示筛选」按钮的命中区必须达到 36px', () => {
  const SRC = read('src/components/search/SearchFilterPanel.tsx');

  it('按钮的类名带 min-h-9 min-w-9（= 2.25rem = 36px）', () => {
    const btn = SRC.match(/onClick=\{toggleFilters\}[\s\S]{0,400}?className="([^"]+)"/);
    assert.ok(btn, '找不到「显示筛选」按钮的 className，守卫前提变了');
    assert.match(
      btn[1],
      /\bmin-h-9\b/,
      `「显示筛选」按钮缺 min-h-9 —— 实测只有 20px 高（< WCAG 2.2 的 24px，也 < 本仓的 36px）：${btn[1]}`,
    );
    assert.match(
      btn[1],
      /\bmin-w-9\b/,
      `「显示筛选」按钮缺 min-w-9：${btn[1]}`,
    );
  });

  it('按钮不得折行（320px 下实测折成两行，图标孤零零落在两行文字中间）', () => {
    const btn = SRC.match(/onClick=\{toggleFilters\}[\s\S]{0,400}?className="([^"]+)"/);
    assert.ok(btn, '找不到「显示筛选」按钮的 className，守卫前提变了');
    assert.match(
      btn[1],
      /\bwhitespace-nowrap\b/,
      `「显示筛选」按钮缺 whitespace-nowrap —— 320px 下会折成两行：${btn[1]}`,
    );
  });

  it('（事实来源）命中区口径本身是 36px', () => {
    // 别自己发明一套标准：判据的唯一来源是 components/layout/hitTarget.ts。
    const hitTarget = read('src/components/layout/hitTarget.ts');
    assert.match(
      hitTarget,
      /export const MIN_HIT_TARGET_PX = 36;/,
      '命中区下限不是 36px —— 若要改，先改 hitTarget.ts（它是单源口径）',
    );
  });

  // ── 实测变异 ────────────────────────────────────────────────────────
  // ① 把「显示筛选」按钮的 `min-h-9 min-w-9` 去掉 ⇒ 变红。
  // ② 把 `whitespace-nowrap` 去掉 ⇒ 变红。
});

describe('V-5：窄屏下品牌按钮必须保住 36px 命中区', () => {
  const CSS = read('src/styles/global.css');

  it('≤640px 的 .app-header-brand 有 min-width: 36px', () => {
    const at = CSS.indexOf('@media (max-width: 640px)');
    assert.ok(at !== -1, 'global.css 里找不到 @media (max-width: 640px)');
    const media = CSS.slice(at, CSS.indexOf('\n}', at));
    const brand = media.match(/\.app-header-brand\s*\{[^}]*\}/);
    assert.ok(brand, '窄屏媒体查询里找不到 .app-header-brand');
    assert.match(
      brand[0],
      /min-width:\s*36px/,
      '窄屏下 .app-header-brand 缺 min-width: 36px —— 实测 320px 时品牌盒塌成 2.7×20px，' +
        'logo 的右侧 40% 根本点不到（命中的是旁边那颗按钮）',
    );
  });

  it('≤420px（品牌名隐藏）时品牌按钮居中', () => {
    const at = CSS.indexOf('@media (max-width: 420px)');
    assert.ok(at !== -1, 'global.css 里找不到 @media (max-width: 420px)');
    const media = CSS.slice(at, CSS.indexOf('\n}', at));
    const brand = media.match(/\.app-header-brand\s*\{[^}]*\}/);
    assert.ok(brand, '420px 媒体查询里找不到 .app-header-brand');
    assert.match(
      brand[0],
      /justify-content:\s*center/,
      '品牌名隐藏后品牌按钮必须居中（它退化成一个正方形图标按钮）',
    );
  });

  // ── 实测变异 ────────────────────────────────────────────────────────
  // ① 把窄屏的 `min-width: 36px` 改回 `min-width: 0` ⇒ 变红。
  // ② 把 420px 断点的 `justify-content: center` 删掉 ⇒ 变红。
});

// ═══════════════════════════════════════════════════════════════════════════
// V-7：Toast 的壳体必须跟主题
// ═══════════════════════════════════════════════════════════════════════════

describe('V-7：Toast 的壳体与文字必须跟主题（类型色是语义色，可以保留）', () => {
  const SRC = read('src/components/common/Toast.tsx');

  it('壳体不得写死 bg-white / text-slate（那是不跟主题的冷白卡片）', () => {
    assert.doesNotMatch(
      SRC,
      /\bbg-white\/95\b/,
      'Toast 壳体又写死了 bg-white/95 —— 6 套主题 × 明暗实测无一组跟主题走',
    );
    assert.doesNotMatch(
      SRC,
      /\btext-slate-800\b|\bdark:text-slate-100\b|\bdark:bg-slate-900\/95\b/,
      'Toast 壳体又写死了 slate 系 —— 主题令牌会自动翻面，不需要 dark: 变体',
    );
  });

  it('壳体必须走 theme-bg-elevated + theme-text-primary', () => {
    assert.match(
      SRC,
      /theme-bg-elevated/,
      'Toast 壳体必须走 theme-bg-elevated（主题的弹层底色）',
    );
    assert.match(
      SRC,
      /theme-text-primary/,
      'Toast 壳体的文字必须走 theme-text-primary',
    );
  });

  it('（事实来源）类型色仍保留（危险=红是通用约定，不是「某品牌的配色」；成功=绿已撤）', () => {
    // 2026-10-25「安静的成功」：提示层**不再有「成功」这一档**
    // （成功是状态，不是事件）⇒ 绿色那一档连同对勾图标一起撤了。
    //
    // ⇒ 这条判据按新规则**收窄**（不是删除）：
    //   · 危险=红 —— 保留（通用约定）；
    //   · 成功=绿 —— 从「必须是绿」翻成「**不许再有绿**」——
    //     比原来还硬：谁把绿色加回来就变红。
    assert.match(SRC, /rose/, '错误态仍应是红色系');
    assert.doesNotMatch(
      SRC,
      /emerald/,
      '提示层不再有「成功=绿」那一档 —— 成功是状态不是事件',
    );
  });

  // ── 实测变异 ────────────────────────────────────────────────────────
  // ① 把 shell 里的 `theme-bg-elevated` 换回 `bg-white/95` ⇒ 变红。
  // ② 把 `theme-text-primary` 换回 `text-slate-800` ⇒ 变红。
});

// ═══════════════════════════════════════════════════════════════════════════
// V-8 / V-12 / V-15：读屏不该被同一段文字播报两遍
// ═══════════════════════════════════════════════════════════════════════════

describe('V-8：空态图标是纯装饰，不得与 <h3> 重复播报', () => {
  const SRC = read('src/components/common/EmptyState.tsx');

  it('图标容器没有 role="img" + aria-label={title} 的组合', () => {
    assert.doesNotMatch(
      SRC,
      /role="img"/,
      '空态图标又带 role="img" —— 它旁边的 <h3> 已经念了同一个标题，读屏会播报两遍',
    );
    assert.doesNotMatch(
      SRC,
      /aria-label=\{title\}/,
      '空态图标的 aria-label={title} 与 <h3>{title}</h3> 逐字相同 ⇒ 读屏播报两遍',
    );
  });

  it('图标容器标了 aria-hidden="true"', () => {
    assert.match(
      SRC,
      /aria-hidden="true"/,
      '空态图标容器必须标 aria-hidden="true"（它是纯装饰，名字由 <h3> 给）',
    );
  });

  // ── 实测变异 ────────────────────────────────────────────────────────
  // ① 把 aria-hidden="true" 换回 `role="img" aria-label={title}` ⇒ 变红。
});

describe('V-12：引导页的 emoji 是装饰，不得进朗读队列', () => {
  const SRC = read('src/components/onboarding/OnboardingSteps.tsx');

  it('每个 emoji 容器都标了 aria-hidden="true"', () => {
    const containers = [...SRC.matchAll(/<(div|span)[^>]*className="([^"]*(?:onboarding-icon-wrapper|onboarding-feature-icon|onboarding-confetti)[^"]*)"[^>]*>/g)];
    assert.ok(containers.length >= 10, `只找到 ${containers.length} 个 emoji 容器，扫描器可能坏了`);
    for (const m of containers) {
      assert.match(
        m[0],
        /aria-hidden="true"/,
        `emoji 容器「${m[0]}」缺 aria-hidden="true" —— 它是一个有内容的文本节点，读屏会把它当文字念出来`,
      );
    }
  });

  it('引导页里没有裸露的 emoji 文本节点（每个 emoji 都在容器里）', () => {
    // 扫描器本身的自证：改造码里至少还有 10 个 emoji。
    const emoji = SRC.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) ?? [];
    assert.ok(emoji.length >= 10, `只找到 ${emoji.length} 个 emoji，扫描器可能坏了`);
  });

  // ── 实测变异 ────────────────────────────────────────────────────────
  // ① 把某一处 `aria-hidden="true"` 删掉 ⇒ 变红。
});

describe('V-15：提示条必须被读屏引用到（aria-describedby）', () => {
  const SRC = read('src/components/common/Tooltip.tsx');

  it('提示条有稳定的 id', () => {
    assert.match(
      SRC,
      /useId\(\)/,
      'Tooltip 必须用 useId() 生成稳定的 id —— 没有 id 就没法被 aria-describedby 引用',
    );
    assert.match(
      SRC,
      /id=\{tooltipId\}/,
      '提示条元素必须挂上那个 id（role="tooltip" 却没有 id ⇒ 读屏拿不到它）',
    );
  });

  it('触发元素被挂上 aria-describedby', () => {
    assert.match(
      SRC,
      /aria-describedby/,
      'Tooltip 必须把 aria-describedby 挂到**触发元素**上（挂在不可聚焦的包装层上等于没挂）',
    );
  });

  it('已有 aria-describedby 必须合并而不是覆盖', () => {
    // TabGroup 的会话标题已经带 aria-describedby（指向一条 sr-only 说明）
    // ⇒ 覆盖掉它会让那条说明消失。
    assert.match(
      SRC,
      /\.filter\(Boolean\)/,
      'Tooltip 合并 aria-describedby 时必须过滤空值并用空格连接，不能覆盖子元素已有的 id',
    );
    assert.match(
      SRC,
      /\.join\(' '\)/,
      'Tooltip 合并 aria-describedby 时必须用空格连接多个 id',
    );
  });

  // ── 实测变异 ────────────────────────────────────────────────────────
  // ① 把 `id={tooltipId}` 删掉 ⇒ 变红。
  // ② 把 aria-describedby 那段换成直接覆盖（不 join） ⇒ 变红。
});

// ═══════════════════════════════════════════════════════════════════════════
// V-9：主题过渡名单
// ═══════════════════════════════════════════════════════════════════════════

describe('V-9：主题过渡名单里只留**真实存在**的表面', () => {
  const CSS = read('src/styles/global.css');

  /** 主题过渡名单（第一段大选择器列表）。 */
  function transitionList(): string {
    const at = CSS.indexOf('--theme-transition-duration) var(--theme-transition-timing)');
    assert.ok(at !== -1, 'global.css 里找不到主题过渡名单');
    const listStart = CSS.lastIndexOf('{', at);
    // 往上找这一段的开始（第一个选择器）
    const head = CSS.slice(0, listStart);
    const braceStart = head.lastIndexOf('}', head.lastIndexOf('{'));
    return CSS.slice(braceStart + 1, listStart);
  }

  it('名单里没有零引用的死类', () => {
    const DEAD = [
      'dropdown-menu',
      'popup-menu',
      'modal-content',
      'dropdown-item',
      'empty-state-icon',
      'empty-state-title',
      'empty-state-description',
      'card-glass',
      'badge-accent',
      'search-result-item',
      'search-result-link',
      'search-bar-input',
      'btn-ghost',
    ];
    const list = transitionList();
    const found = DEAD.filter(c => new RegExp(`\\.${c}\\b`).test(list));
    assert.deepEqual(
      found,
      [],
      `主题过渡名单里还有 ${found.length} 个**零引用**的死类：${found.join('、')} —— ` +
        '它们一次都没生效过，却让人以为「切主题时这些表面会渐变」',
    );
  });

  it('名单里含三个真实表面（菜单 / 弹窗 / 空态）', () => {
    const list = transitionList();
    for (const cls of ['ts-panel', 'ts-dialog', 'ts-empty-state']) {
      assert.match(
        list,
        new RegExp(`\\.${cls}\\b`),
        `主题过渡名单里少了 .${cls} —— 实测「菜单面板过渡时长 = 0s」「弹窗面板过渡时长 = 0s」，` +
          '而同屏的会话卡是 0.2s ⇒ 同一次切主题里列表在渐变、菜单在闪',
      );
    }
  });

  it('这三个表面类在 CSS 里都有真规则（不是反向死类）', () => {
    for (const cls of ['ts-panel', 'ts-dialog', 'ts-empty-state']) {
      assert.match(
        CSS,
        new RegExp(`\\.${cls}\\s*\\{[^}]*\\}`),
        `.${cls} 在 CSS 里没有规则 —— 那就是「组件用了它、CSS 里什么都没有」的反向死类（V-16）`,
      );
    }
  });

  it('组件确实挂上了这三个类', () => {
    const menu = read('src/components/layout/HeaderDropdown.tsx');
    assert.match(menu, /className="ts-panel/, '菜单面板必须挂 ts-panel');
    const modal = read('src/components/common/ModalFrame.tsx');
    assert.match(modal, /ts-dialog/, '弹窗面板必须挂 ts-dialog');
    const empty = read('src/components/common/EmptyState.tsx');
    assert.match(empty, /ts-empty-state/, '空态容器必须挂 ts-empty-state');
  });

  // ── 实测变异 ────────────────────────────────────────────────────────
  // ① 把 `.ts-panel` 从名单里去掉 ⇒ 「名单里含三个真实表面」变红。
  // ② 把 `.dropdown-menu` 放回名单 ⇒ 「名单里没有零引用的死类」变红。
  // ③ 把 global.css 里的 `.ts-panel { ... }` 规则删掉 ⇒ 「三个表面类都有真规则」变红。
});

// ═══════════════════════════════════════════════════════════════════════════
// V-10：.tooltip 规则与组件必须接上
// ═══════════════════════════════════════════════════════════════════════════

describe('V-10：.tooltip 规则与 <Tooltip> 组件必须接上（不许两套并存）', () => {
  const CSS = read('src/styles/global.css');
  const COMPONENT = read('src/components/common/Tooltip.tsx');
  const MICRO = read('src/styles/micro-interactions.css');

  it('组件挂上了 tooltip 类', () => {
    assert.match(
      COMPONENT,
      /className=\{`tooltip /,
      'Tooltip 组件必须挂上 `tooltip` 类 —— 否则 global.css 的 .tooltip 规则是死规则（V-10 的根因）',
    );
  });

  it('组件不再自带写死的冷灰配色', () => {
    assert.doesNotMatch(
      COMPONENT,
      /\bbg-gray-900\b|\bdark:bg-gray-800\b|\bborder-gray-700\b|\bdark:border-gray-600\b/,
      'Tooltip 组件又写死了冷灰配色 —— 12 组主题 × 明暗实测无一组跟主题走',
    );
  });

  it('.tooltip 规则读主题令牌', () => {
    const at = CSS.indexOf('.tooltip {');
    assert.ok(at !== -1, 'global.css 里找不到 .tooltip 规则');
    const block = CSS.slice(at, CSS.indexOf('}', at));
    assert.match(block, /var\(--color-bg-elevated\)/, '.tooltip 的底色必须读 --color-bg-elevated');
    assert.match(block, /var\(--color-text-primary\)/, '.tooltip 的文字必须读 --color-text-primary');
  });

  it('.tooltip 不得 nowrap（组件要允许换行，否则 400px 下撑破视口）', () => {
    const at = CSS.indexOf('.tooltip {');
    const block = CSS.slice(at, CSS.indexOf('}', at));
    assert.doesNotMatch(
      block,
      /whitespace-nowrap/,
      '.tooltip 规则里的 whitespace-nowrap 与组件实际的 whitespace-normal break-words 相反 —— ' +
        '它会让提示语在窄屏撑破视口（V-7 的教训）',
    );
  });

  it('micro-interactions 里不再有「显隐两态」的 .tooltip 规则', () => {
    // 组件是**条件挂载**的（isVisible 时才渲染），从来没有 .show 这个类
    // ⇒ .tooltip { opacity: 0 } 会让提示条整个不可见。
    assert.doesNotMatch(
      MICRO,
      /\.tooltip\s*\{[^}]*opacity:\s*0/,
      'micro-interactions 里还有 `.tooltip { opacity: 0 }` —— 组件不挂 .show ⇒ 提示条永远不可见',
    );
    assert.doesNotMatch(
      MICRO,
      /\.tooltip\.show\s*\{/,
      'micro-interactions 里还有 `.tooltip.show` —— 组件是条件挂载的，从来没有 .show 这个类',
    );
  });

  // ── 实测变异 ────────────────────────────────────────────────────────
  // ① 把组件的 `tooltip ` 类名去掉 ⇒ 「组件挂上了 tooltip 类」变红。
  // ② 把 micro-interactions 的 `.tooltip { opacity: 0; ... }` 加回去
  //    ⇒ 「不再有显隐两态的 .tooltip 规则」变红。
});

// ═══════════════════════════════════════════════════════════════════════════
// V-11：主题选择环
// ═══════════════════════════════════════════════════════════════════════════

describe('V-11：主题选择环必须用不透明的主题墨色', () => {
  const CSS = read('src/styles/global.css');

  it('.theme-accent-ring 读 --color-accent-text（不是半透明的 --color-accent-border）', () => {
    const at = CSS.indexOf('.theme-accent-ring');
    assert.ok(at !== -1, 'global.css 里找不到 .theme-accent-ring');
    const block = CSS.slice(at, CSS.indexOf('}', at));
    assert.match(
      block,
      /var\(--color-accent-text\)/,
      '.theme-accent-ring 必须读 --color-accent-text —— --color-accent-border 是 40~45% 透明度的淡描边，' +
        '实测 8 组主题对卡底全部低于 3:1（claude 浅色只有 1.87:1）⇒ 用户看不出当前选的是哪个主题',
    );
    assert.doesNotMatch(
      block,
      /var\(--color-accent-border\)/,
      '.theme-accent-ring 又读回了 --color-accent-border（45% 透明度 ⇒ 对卡底 1.87–2.74:1）',
    );
  });

  // ── 实测变异 ────────────────────────────────────────────────────────
  // ① 把 `.theme-accent-ring` 的值改回 `var(--color-accent-border)` ⇒ 变红。
});

// ═══════════════════════════════════════════════════════════════════════════
// V-13：apple 深色不该是纯黑
// ═══════════════════════════════════════════════════════════════════════════

describe('V-13：深色主题的页面底不该是纯黑（纯黑 = 没有底色）', () => {
  it('apple 深色的 --color-bg-primary 不是 #000000', () => {
    const css = readFileSync(resolve(ROOT, 'src/styles/themes/apple.css'), 'utf8');
    const darkScope = css.slice(css.indexOf('html.dark [data-theme="apple"]'));
    const block = darkScope.slice(0, darkScope.indexOf('}'));
    assert.match(
      block,
      /--color-bg-primary:\s*(?!#000000)/,
      'apple 深色的页面底又是纯黑 #000000 —— 卡片底 #1c1c1e 与它只有 1.23:1，' +
        '8% 白描边也只有 1.26:1 ⇒ 卡片与页面之间几乎没有任何明度差',
    );
  });

  it('apple 深色的 --color-shell 与 --color-bg-primary 一致（两处不能漂移）', () => {
    const css = readFileSync(resolve(ROOT, 'src/styles/themes/apple.css'), 'utf8');
    const darkScope = css.slice(css.indexOf('html.dark [data-theme="apple"]'));
    const block = darkScope.slice(0, darkScope.indexOf('}'));
    const primary = block.match(/--color-bg-primary:\s*([^;]+);/)?.[1].trim();
    const shell = block.match(/--color-shell:\s*([^;]+);/)?.[1].trim();
    assert.ok(primary && shell, '读不到 apple 深色的底色令牌');
    assert.equal(
      shell,
      primary,
      `--color-shell（${shell}）与 --color-bg-primary（${primary}）必须一致 —— 两处漂移会让某些表面又变回纯黑`,
    );
  });

  // ── 实测变异 ────────────────────────────────────────────────────────
  // ① 把 apple 深色的 --color-bg-primary 改回 #000000 ⇒ 变红。
  // ② 把 --color-shell 改成另一个值 ⇒ 变红。
});

// ═══════════════════════════════════════════════════════════════════════════
// V-14：动效节奏
// ═══════════════════════════════════════════════════════════════════════════

describe('V-14：动效时长收敛成命名阶梯', () => {
  const CSS = read('src/styles/global.css');

  it('global.css 声明了三档 motion 令牌与一条缓动', () => {
    for (const name of ['--motion-fast', '--motion-base', '--motion-slow', '--ease-standard']) {
      assert.match(
        CSS,
        new RegExp(`${name}:`),
        `global.css 里没有声明 ${name} —— 动效时长必须收敛到命名阶梯，不能各处写死数字`,
      );
    }
  });

  it('样式层不再写死毫秒数（改读 motion 令牌）', () => {
    for (const file of STYLE_FILES) {
      const hits = hardcodedDurations(file);
      assert.deepEqual(
        hits,
        [],
        `${file} 里还有写死的时长 ${hits.join('、')} —— ` +
          '同一次点击里三颗按钮反馈速度不同（.btn-icon 60ms / .btn-primary 80ms / .btn 150ms）',
      );
    }
  });

  it('样式层不再用 Tailwind 的 duration-* 工具类（那是另一条写死的时长来源）', () => {
    // `duration-150` 展开成 `transition-duration: 150ms` —— 与写死的 150ms
    // 等价，却藏在 @apply 里 ⇒ 改节奏时最容易漏掉的一处。
    for (const file of STYLE_FILES) {
      const src = read(file);
      const hits = [...src.matchAll(/\bduration-\d+\b/g)].map(m => m[0]);
      assert.deepEqual(
        [...new Set(hits)],
        [],
        `${file} 里还有 Tailwind 的 duration-* 工具类 ${[...new Set(hits)].join('、')} —— ` +
          '改用 transition-duration: var(--motion-*)',
      );
    }
  });

  it('（事实来源）motion 阶梯本身是有序且有界的', () => {
    // 阶梯不是随便三个数：必须 fast < base < slow，且 slow ≤ 300ms
    // （超过 300ms 的过渡会让人觉得「卡」）。
    const global = read('src/styles/global.css');
    const tokenValue = (name: string) => {
      const m = global.match(new RegExp(`${name}:\\s*(\\d+)ms`));
      assert.ok(m, `global.css 里找不到 ${name}`);
      return Number(m[1]);
    };
    const fast = tokenValue('--motion-fast');
    const base = tokenValue('--motion-base');
    const slow = tokenValue('--motion-slow');
    assert.ok(fast < base && base < slow, `motion 阶梯必须递增：${fast} / ${base} / ${slow}`);
    assert.ok(slow <= 300, `--motion-slow 不得超过 300ms（现在是 ${slow}ms）`);
    assert.ok(fast >= 80, `--motion-fast 不得低于 80ms（太快会看不清反馈，现在 ${fast}ms）`);
  });

  it('（扫描器自证）hardcodedDurations 真的扫得到东西', () => {
    // 扫描器本身的自检：造一份「坏 CSS」喂给它，它必须抓得到。
    const probe = 'src/styles/_probe-not-a-real-file.css';
    void probe;
    const bad = [
      '.a { transition: all 60ms cubic-bezier(0.4, 0, 0.2, 1); }',
      '.b { animation: fadeIn 0.3s ease-out forwards; }',
      '.c { transition-duration: 150ms; }',
    ].join('\n');
    const found = extractHardcodedDurations(bad);
    assert.equal(
      found.length,
      3,
      `扫描器坏了：喂给它 3 条坏声明，只抓到 ${found.length} 条（${found.join(' | ')}）`,
    );
    // 而「合规」的写法必须一条都抓不到。
    const good = [
      '.a { transition: all var(--motion-fast) var(--ease-standard); }',
      '.b { animation: fadeIn var(--motion-slow) var(--ease-standard) forwards; }',
      '.c { transition-duration: var(--motion-base); }',
      ':root { --motion-fast: 120ms; --motion-base: 180ms; --motion-slow: 250ms; }',
      '.d { animation-delay: 0.05s; }',
      '.e { animation: pulse 1.5s infinite; }',
    ].join('\n');
    assert.deepEqual(
      extractHardcodedDurations(good),
      [],
      '扫描器把合规写法也判成违规了 —— 判据过宽',
    );
  });

  // ── 实测变异 ────────────────────────────────────────────────────────
  // ① 把 onboarding.css 里某条 `var(--motion-base)` 改回 `0.2s`
  //    ⇒ 「样式层不再写死毫秒数」变红。
  // ② 把 micro-interactions.css 里 `.btn-icon` 的 `var(--motion-fast)`
  //    改回 `60ms` ⇒ 同上。
  // ③ 把 global.css 的 `.btn` 里的 `transition-duration: var(--motion-base)`
  //    改回 `@apply transition-all duration-150` ⇒ 「不再用 duration-* 工具类」变红。
});

/**
 * 从一段 CSS 里抽出「写死的时长」声明。
 *
 * 【口径】只有**交互反馈**的时长必须读命名阶梯。下列四类**不算**：
 *   ① `--motion-*: 120ms` 这类**令牌定义本身**（它是阶梯的源头）；
 *   ② `animation-delay`（错峰出现的**编排**，不是反馈速度）；
 *   ③ `@media (prefers-reduced-motion: reduce)` 里的 0.001ms
 *      （无障碍逃生舱：用户要求减少动效时把一切压到不可见）；
 *   ④ `animation: ... infinite` 的**循环动画**（骨架屏 1.4s / 脉冲 1.5s：
 *      它们是持续的背景动画，不是「点一下多久反馈」）。
 *
 * 其余（transition / animation / transition-duration / animation-duration
 * 里出现的 60ms / 0.3s / 150ms …）一律算「写死的时长」。
 */
function extractHardcodedDurations(css: string): string[] {
  // ③ 先摘掉 prefers-reduced-motion 块。
  const withoutReducedMotion = css.replace(
    /@media\s*\(prefers-reduced-motion\s*:\s*reduce\)\s*\{[\s\S]*?\n\}/g,
    ' ',
  );
  const hits: string[] = [];
  // 逐条声明扫（不是整文件正则）：这样才能按「声明的属性能不能带时长」分类。
  for (const m of withoutReducedMotion.matchAll(
    /([-\w]+)\s*:\s*([^;{}]+)[;}]/g,
  )) {
    const prop = m[1];
    const value = m[2];
    if (prop.startsWith('--')) continue; // ① 令牌定义
    if (prop.endsWith('-delay')) continue; // ② 编排延迟
    if (prop !== 'transition' && prop !== 'animation' &&
        prop !== 'transition-duration' && prop !== 'animation-duration') {
      continue;
    }
    if (/\binfinite\b/.test(value)) continue; // ④ 循环动画
    const time = value.match(/\b\d+(?:\.\d+)?(?:ms|s)\b/);
    if (time) hits.push(`${prop}: ${time[0]}`);
  }
  return hits;
}

/** 读文件 → 抽写死的时长。 */
const hardcodedDurations = (rel: string) => extractHardcodedDurations(read(rel));
