/**
 * 「应用菜单」可用高度的**判定口径**（单源，纯函数）。
 *
 * ── 问题 ────────────────────────────────────────────────────────────────
 *
 * 2026-10-20 真机实测（400×600）：菜单容器写的是 `max-h-[70vh]` = 420px，
 * 菜单顶边在 y=54 ⇒ 菜单底边 474，而最后一项「删除所有会话（N）」的底边
 * 在 **487** —— **比菜单的底边还低 13px**，被 `overflow-y-auto` 裁在可视区外。
 * 用户必须先滚动才发现「删除所有会话」这颗核按钮的存在。
 *
 * 根因不是「70vh 太小」，是**参照系错了**：菜单的高度上限被绑定到
 * *视口比例*，而不是「菜单顶边到视口底边之间还剩多少空间」。
 * 顶栏是 sticky 的，菜单顶边几乎恒定在视口上方 ~54px 处，
 * 视口有多高才是「还能显示多少」的决定因素。
 *
 * ── 修法 ────────────────────────────────────────────────────────────────
 *
 * 上限 = 视口高度 − 菜单顶边 − 底部留白。菜单在 400×600 下拿到
 * 600 − 54 − 12 = 534px，而菜单内容只有 442px ⇒ **不再滚动**，
 * 「删除所有会话」整颗可见。
 */

/** 菜单底边与视口底边之间至少留出的空隙（px）。 */
export const DROPDOWN_BOTTOM_MARGIN = 12;

/**
 * 菜单能占用的最大高度：视口底边减去菜单顶边，再减去底部留白。
 *
 * 参数用「菜单顶边的视口坐标」而不是「顶栏高度」：菜单是绝对定位在
 * 菜单按钮的相对容器里，它的顶边位置随顶栏布局（单行/两行、滚动条
 * gutter）而变，量出来最准。
 */
export function remainingViewportHeight(params: {
  viewportHeight: number;
  menuTop: number;
  bottomMargin?: number;
}): number {
  const { viewportHeight, menuTop } = params;
  const bottomMargin = params.bottomMargin ?? DROPDOWN_BOTTOM_MARGIN;
  if (!Number.isFinite(viewportHeight) || !Number.isFinite(menuTop)) return 0;
  return Math.max(0, viewportHeight - menuTop - bottomMargin);
}
