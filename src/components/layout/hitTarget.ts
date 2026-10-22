/**
 * 命中区（可点击目标）尺寸的**判定口径**（单源，纯函数）。
 *
 * ── 这份文件是什么、不是什么（2026-10-22 架构审计 D2 更正）─────────────────
 *
 * **是什么**：这份规则的**判据实现**（可被 node:test 直接断言）。
 * **不是什么**：它**不是**生产代码在运行时调用的校验器 ——
 * `meetsHitTarget()` 在生产代码里**零调用点**（2026-10-22 实测：全仓唯一的
 * **代码**引用在 `tests/guards/headerGeometry.test.ts`，`src/` 下只有注释提到它）。
 *
 * 规则在生产里的落地形态是**两处**：
 *   1. CSS：`.btn-icon { min-width/min-height: 2.25rem }`（`src/styles/global.css`）
 *      —— 这条是**无条件**的（2026-10-22 审计 U-02 之前它被关在
 *      `@media (max-width: 640px)` 里，等于「桌面端不受约束」）；
 *   2. 类名约定：小按钮带 `min-w-9 min-h-9`（= 2.25rem = 36px）。
 *
 * ⇒ **想改这条规则，要改三个地方**：这里的常量、CSS 里的 `2.25rem`、
 *   以及带 `min-w-9 min-h-9` 的类名。只改常量**不会有任何生产变化** ——
 *   `tests/guards/headerGeometry.test.ts` 里那条「`.btn-icon` 的 CSS 下限不得低于
 *   同一个数」会把改动挡在测试阶段（它读 CSS 的 rem 值与本常量比对），
 *   所以**不会**出现「改了常量、界面没变、测试还全绿」的情况。
 *
 * 判据做成纯函数：Tailwind 的类名 → 像素值，才能被 node:test 直接测，
 * 不必真的渲染一个按钮再量。
 *
 * ── 选了哪个标准 ────────────────────────────────────────────────────────
 *
 * WCAG 2.2 有两条相关条款：
 *   · SC 2.5.8 Target Size (Minimum) —— **AA**，下限 24×24 CSS px
 *   · SC 2.5.5 Target Size (Enhanced) —— **AAA**，44×44 CSS px
 *
 * 本项目取 **36×36（2.25rem）**：
 *   · 远超 AA 的 24px 下限（余量 50%），顶栏所有小图标按钮统一到这个尺寸；
 *   · 达不到 AAA 的 44px：在 400px 宽的顶栏里，操作区已经占掉 280px，
 *     再给两颗按钮各加 8px 就得从搜索框或品牌名里扣 —— 那是拿可用性换标准。
 *   · 36px 正是顶栏 `.btn-icon` 早就采用的尺寸（`min-width/min-height: 2.25rem`），
 *     同步按钮此前只是**没被这条规则覆盖**（用的是自己的 `px-2 py-1.5`）。
 */

/** 命中区最小边长（px）。见文件头：AA 下限 24，本项目取 36。 */
export const MIN_HIT_TARGET_PX = 36;

/** 浏览器默认根字号（px）。Tailwind 的 rem 换算按 16px 计。 */
export const ROOT_FONT_SIZE_PX = 16;

/** Tailwind 间距刻度：n → n × 0.25rem。 */
const TAILWIND_SPACING_STEP_REM = 0.25;

export interface MinSize {
  minWidthPx: number;
  minHeightPx: number;
}

function parseAxis(className: string, prefix: 'min-w' | 'min-h'): number {
  // 形如 `min-w-9` / `min-h-9`（刻度）或 `min-w-[36px]`（任意值）。
  const numeric = new RegExp(`(?:^|\\s)${prefix}-(\\d+(?:\\.\\d+)?)(?=\\s|$)`).exec(className);
  if (numeric) {
    return parseFloat(numeric[1]) * TAILWIND_SPACING_STEP_REM * ROOT_FONT_SIZE_PX;
  }
  const arbitrary = new RegExp(`(?:^|\\s)${prefix}-\\[(\\d+(?:\\.\\d+)?)px\\](?=\\s|$)`).exec(className);
  if (arbitrary) {
    return parseFloat(arbitrary[1]);
  }
  // `min-w-0` 已被上面的数字分支覆盖；`min-w-px` / `min-w-full` / `min-h-screen`
  // 都不是「固定像素下限」，对命中区判定没有意义 ⇒ 视为没有约束。
  return 0;
}

/**
 * 从 className 里解析出 `min-w-*` / `min-h-*` 施加的最小尺寸（px）。
 *
 * 只认**显式的最小尺寸约束**：`px-2 py-1.5` 决定的是内容盒尺寸，
 * 真正决定「点得到多大」的是 min-* —— 按钮被 flex 压缩时，内容会溢出，
 * 但 min-* 会把它撑住。
 */
export function parseTailwindMinSize(className: string): MinSize {
  return {
    minWidthPx: parseAxis(className, 'min-w'),
    minHeightPx: parseAxis(className, 'min-h'),
  };
}

/** 这组类名施加的命中区是否达到了 {@link MIN_HIT_TARGET_PX}。 */
export function meetsHitTarget(className: string): boolean {
  const { minWidthPx, minHeightPx } = parseTailwindMinSize(className);
  return minWidthPx >= MIN_HIT_TARGET_PX && minHeightPx >= MIN_HIT_TARGET_PX;
}
