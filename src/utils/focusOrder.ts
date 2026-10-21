/**
 * 文档级 Tab 顺序工具 —— 纯 DOM，无框架依赖。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────────
 * 卡片「更多」菜单的面板是 `createPortal` 挂到 `document.body` **末尾**的
 * （必须 portal：会话卡带永久 transform ⇒ 每张卡都是 stacking context，
 * 面板不 portal 就被后面的卡盖住，实测「删除会话」那行点不到）。
 *
 * 但 portal 到 body 末尾 ⇒ 面板在 DOM 序上排在**所有卡片之后** ⇒
 * 键盘用户从 summary 按 Tab 要穿过整个列表才进得去菜单
 * （实测 4 标签会话 16 次 Tab、15 标签会话 37 次 Tab）。
 *
 * 修法不是把面板搬回卡内（实测会被 wrapper 的 content-visibility 裁掉，
 * 且卡片的 transform 会成为 fixed 的包含块 ⇒ 定位全错），
 * 而是**显式接管焦点**：从 summary 按 Tab 直接把焦点送进菜单第一项，
 * 菜单内 Tab 在菜单项之间循环；走到最后一项再按 Tab ⇒ 关菜单并把焦点
 * 送到 summary 在页面里的下一个可聚焦元素（与 APG「Tab 关菜单、焦点前进」
 * 的约定一致，同时不把用户困在菜单里）。
 *
 * 这个模块提供最后那一步需要的「下一个/上一个可聚焦元素」。
 */

/**
 * 文档里**可能**可聚焦的选择器。
 *
 * 刻意不排除 `tabindex="-1"`：那类元素是程序化聚焦的锚点，不是 Tab 落点。
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** 这个元素当前是否**在页面里可见**（不可见的不该成为 Tab 落点）。 */
const isRendered = (element: Element): boolean => {
  if (!(element instanceof HTMLElement)) return false;
  if (element.getClientRects().length === 0) return false;
  // <details> 收起时子元素在部分浏览器里仍报告 rect ⇒ 显式排除。
  const details = element.closest('details');
  if (details && !details.open && element !== details.querySelector('summary')) {
    return false;
  }
  return true;
};

/**
 * 找到 `anchor` 在页面 Tab 顺序里的**下一个**（direction=1）或**上一个**
 * （direction=-1）可聚焦元素，并聚焦它。
 *
 * @returns 找到并聚焦了返回 true；没找到返回 false（调用方应把焦点留在原处）
 */
export const focusTabOrderSibling = (
  anchor: HTMLElement,
  direction: 1 | -1
): boolean => {
  const doc = anchor.ownerDocument;
  const candidates = Array.from(doc.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter(isRendered);
  const index = candidates.indexOf(anchor);
  if (index === -1) return false;
  const target = candidates[index + direction];
  if (!target) return false;
  target.focus();
  return true;
};
