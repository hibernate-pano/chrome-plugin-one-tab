import React from 'react';

/**
 * 引导页的**线性图标集**（2026-11-06 替换 emoji）。
 *
 * ── 为什么不再用 emoji ─────────────────────────────────────────────────
 *
 * 上一版每个特性卡片头上挂一个 emoji（💾 🔍 🚀 🪟 📌 🔒 🗂️ ⏱️ 🌐 ↕️ 🪄 📍 🕘 🔄 📤 🛟 ✅）。
 * 问题不在「丑」，在**不受控**：
 *   · emoji 是字体渲染的彩色位图 ⇒ 画风由用户的系统决定
 *     （Apple / Noto / Segoe 是三套完全不同的插画），产品界面里像贴纸；
 *   · 同一个语义用了两个字形（「保存」在欢迎页是 💾、在第二步是 🪟），
 *     没有系统性；「恢复」是 🚀 和 🪄 —— 两者都不描述「恢复」这件事；
 *   · 它们随字号缩放时与旁边的 1.5px 描边图标族完全不成比例。
 *
 * ⇒ 换成**一套自己画的线性 glyph**：24px 视框、1.5px 描边、只用 currentColor
 *   （颜色交给 CSS 的 accent 令牌 ⇒ 六套主题自动跟随）。
 *
 * ── 为什么手写 SVG 而不是引一个图标库 ──────────────────────────────────
 *
 * 引导页只需要 12 个字形，一次性、不随产品演进。引一个图标库会为了这 12 个
 * 字形把整库（或一套 tree-shaking 配置）拖进扩展包 —— 本仓有 bundle 体积
 * 守卫（`pnpm check:bundle`），而引导页是**首屏**的一部分。
 *
 * ── 可访问性 ────────────────────────────────────────────────────────────
 *
 * 每个 glyph 都 `aria-hidden="true"` + `focusable="false"`：它们**旁边**的
 * 标题已经说了同一件事（「保存」「搜索」…），读屏再念一遍图标只是噪音。
 * 容器（`.onboarding-icon-wrapper` / `.onboarding-feature-icon`）也各自标了
 * aria-hidden —— 守卫见 tests/guards/audit20261023UiVisual.test.ts 的 V-12。
 */
export type GlyphName =
  | 'stack'
  | 'save'
  | 'search'
  | 'open'
  | 'window'
  | 'pin'
  | 'lock'
  | 'group'
  | 'clock'
  | 'globe'
  | 'sort'
  | 'cloud'
  | 'sync'
  | 'import'
  | 'shield'
  | 'check';

/**
 * 字形表：key → 路径数据。
 *
 * 口径（与仓里既有的图标族一致：TabGroup / Header 里那些 `strokeWidth={1.5}`
 * 的 24 视框图标）：
 *   · 视框 0 0 24 24；
 *   · `strokeLinecap="round"` + `strokeLinejoin="round"`；
 *   · 只画轮廓，不填充。
 */
const GLYPHS: Record<GlyphName, React.ReactNode> = {
  // 一摞层叠的卡片 = 「把东西收成一叠」（会话列表本身）
  stack: (
    <>
      <path d="M4 7.5 12 3l8 4.5-8 4.5L4 7.5Z" />
      <path d="M4 12.5 12 17l8-4.5" />
      <path d="M4 17.5 12 22l8-4.5" />
    </>
  ),
  // 抽屉 + 向下的箭头 = 收进去
  save: (
    <>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5v-13Z" />
      <path d="M12 8v7" />
      <path d="M8.5 11.5 12 15l3.5-3.5" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 4.5 4.5" />
    </>
  ),
  // 方框 + 框内的向右箭头 = 「在当前窗口打开」（与 TabGroup 那颗主按钮同形）
  open: (
    <>
      <path d="M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v11A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-11Z" />
      <path d="M8 12h7" />
      <path d="M12.5 8.5 16 12l-3.5 3.5" />
    </>
  ),
  // 窗口（带标题栏）—— 与 open 区分：这里没有箭头
  window: (
    <>
      <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h14A1.5 1.5 0 0 1 20.5 6.5v11A1.5 1.5 0 0 1 19 19H5A1.5 1.5 0 0 1 3.5 17.5v-11Z" />
      <path d="M3.5 9.5h17" />
      <path d="M6.5 7.25h.01M9 7.25h.01" />
    </>
  ),
  // 图钉（固定标签页）
  pin: (
    <>
      <path d="M9 3.5h6l-1 5 3 3v1.5H7V11.5l3-3-1-5Z" />
      <path d="M12 13v7.5" />
    </>
  ),
  // 闭锁
  lock: (
    <>
      <path d="M6.5 10.5h11A1.5 1.5 0 0 1 19 12v6A1.5 1.5 0 0 1 17.5 19.5h-11A1.5 1.5 0 0 1 5 18v-6A1.5 1.5 0 0 1 6.5 10.5Z" />
      <path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3" />
    </>
  ),
  // 分组（虚线框里一叠）= 结果按会话归组
  group: (
    <>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h4" />
      <path d="M14.5 4h4A1.5 1.5 0 0 1 20 5.5v3" />
      <path d="M20 15v3.5A1.5 1.5 0 0 1 18.5 20h-4" />
      <path d="M9.5 20h-4A1.5 1.5 0 0 1 4 18.5V15" />
      <path d="M9 10.5h6M9 13.5h6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M12 8v4.5l3 1.75" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M4.5 12h15" />
      <path d="M12 4.5c2 2 3 4.75 3 7.5s-1 5.5-3 7.5c-2-2-3-4.75-3-7.5s1-5.5 3-7.5Z" />
    </>
  ),
  // 上下箭头 + 两条基线 = 排序
  sort: (
    <>
      <path d="M8.5 4.5v15" />
      <path d="M5.5 7.5 8.5 4.5l3 3" />
      <path d="M15.5 19.5v-15" />
      <path d="M12.5 16.5l3 3 3-3" />
    </>
  ),
  cloud: (
    <>
      <path d="M7.5 18.5A4 4 0 0 1 7 10.6a5 5 0 0 1 9.6-1.1A3.75 3.75 0 0 1 16.9 18.5H7.5Z" />
    </>
  ),
  // 循环箭头 = 同步
  sync: (
    <>
      <path d="M20 12a8 8 0 0 1-13.6 5.7" />
      <path d="M4 12a8 8 0 0 1 13.6-5.7" />
      <path d="M17.6 3v3.5h-3.5" />
      <path d="M6.4 21v-3.5h3.5" />
    </>
  ),
  // 向下的托盘 + 箭头 = 导入
  import: (
    <>
      <path d="M4 15.5v3A1.5 1.5 0 0 0 5.5 20h13A1.5 1.5 0 0 0 20 18.5v-3" />
      <path d="M12 4v9" />
      <path d="M8.5 9.5 12 13l3.5-3.5" />
    </>
  ),
  // 盾牌 = 误删保护
  shield: (
    <>
      <path d="M12 3.5 19 6v5.5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6l7-2.5Z" />
      <path d="m9 11.5 2.25 2.25L15 10" />
    </>
  ),
  // 对勾（不是 emoji 的 ✅）
  check: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <path d="m8.5 12.25 2.5 2.5 4.5-5" />
    </>
  ),
};

export interface OnboardingGlyphProps {
  name: GlyphName;
  /** 视框边长（px）。默认 24 —— 与卡头那颗图标按钮的尺寸口径一致。 */
  size?: number;
  className?: string;
}

/**
 * 一枚引导页线性图标。
 *
 * ⚠️ 永远 `aria-hidden`：这是**装饰**，可访问名由旁边的标题提供。
 */
export const OnboardingGlyph: React.FC<OnboardingGlyphProps> = ({
  name,
  size = 24,
  className = '',
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
    className={className}
  >
    {GLYPHS[name]}
  </svg>
);

export default OnboardingGlyph;
