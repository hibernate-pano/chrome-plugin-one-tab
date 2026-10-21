/**
 * 菜单的方向键导航 —— 纯函数（可单测，不碰 DOM）。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────────
 * 菜单容器声明了 `role="menu"`，读屏就会按 APG 的菜单模型播报：
 * 「用上下方向键浏览」。若方向键不工作，用户按 ↓ 毫无反应 ——
 * **声明的交互模型与实际行为相反**。
 *
 * 而「方向键不工作」有一个反复出现的根因：**候选集里混进了不可聚焦的项**。
 * 典型是 `<label role="menuitem">`（没有 tabindex ⇒ `tabIndex === -1`）：
 * 它在 AX 树里是一个菜单项，方向键却永远聚焦不到它 ⇒ 焦点卡在上一项上，
 * 表现为「按 8 次 ↓ 焦点纹丝不动」，**它后面的所有菜单项全部不可达**。
 *
 * 所以这里把「可聚焦性过滤」和「下一项的决策」都收进纯函数：
 *   · 过滤：不可聚焦的项（tabIndex < 0 / disabled / 不可见）一律不参与导航；
 *   · 决策：给定当前项与按键，算出下一个应该聚焦的项。
 *
 * 断言钉的是**不变量**（"不可聚焦的项永远不会被选中"），
 * 而不是某个下标 —— 菜单项增删时不该让测试变红。
 */

/**
 * 菜单项的最小可聚焦性契约。
 *
 * 判据用 `tabIndex` 而不是「看起来是不是按钮」：
 * `<label role="menuitem">` 看起来完全正常，但 `tabIndex` 是 -1（不可聚焦），
 * `<button disabled>` 与 `display:none` 的项同理。三者都会让方向键卡死。
 */
export interface MenuItemCandidate {
  /** 元素的 tabIndex。原生 button/链接是 0，`<label>`/`<div>` 是 -1。 */
  tabIndex: number;
  /** disabled 的项不可聚焦。 */
  disabled?: boolean;
  /** 不可见的项不可聚焦（display:none / visibility:hidden 的子元素实测 tabIndex 仍为 0）。 */
  hidden?: boolean;
}

/**
 * 这个候选项能不能被方向键选中。
 *
 * 三条判据缺一不可：
 *   · tabIndex >= 0：不在 Tab 序列里的项（`<label>`、`<div role=menuitem>`）不能被选中；
 *   · 不 disabled；
 *   · 不 hidden。
 */
export const isFocusableMenuItem = (item: MenuItemCandidate): boolean => {
  if (item.disabled) return false;
  if (item.hidden) return false;
  return item.tabIndex >= 0;
};

/**
 * 方向键移动的方向。
 *
 * Home/End 不在这里表达 —— 它们是「跳到首/末」而不是「移动」，
 * 决策函数里单列（见 {@link resolveMenuNavigation}）。
 */
export type MenuArrowKey = 'ArrowDown' | 'ArrowUp';

/** 方向键导航的结果。 */
export type MenuNavigationDecision =
  /** 没有可聚焦的项：什么都不做（调用方不应 preventDefault）。 */
  | { kind: 'none' }
  /** 焦点还不在菜单里：进入菜单，落到第一项（↓）或最后一项（↑）。 */
  | { kind: 'enter'; index: number }
  /** 移到下一项 / 上一项。 */
  | { kind: 'move'; index: number }
  /** 跳到首项 / 末项。 */
  | { kind: 'edge'; index: number };

/**
 * 方向键 / Home / End 的落点决策（纯函数）。
 *
 * @param focusableIndices 可聚焦项在**原始列表**里的下标（已过滤掉不可聚焦的项）
 * @param currentIndex 焦点当前所在项在**原始列表**里的下标；-1 表示焦点不在菜单内
 * @param key 按下的键
 */
export const resolveMenuNavigation = (
  focusableIndices: number[],
  currentIndex: number,
  key: MenuArrowKey | 'Home' | 'End'
): MenuNavigationDecision => {
  if (focusableIndices.length === 0) return { kind: 'none' };

  const position = focusableIndices.indexOf(currentIndex);

  // 焦点不在菜单内（还停在触发按钮上）→ 上下键「进入菜单」。
  // ↑ 进入菜单时落到最后一项（与 APG 菜单约定一致）。
  if (position === -1) {
    const target = key === 'ArrowUp' || key === 'End' ? focusableIndices.length - 1 : 0;
    return { kind: 'enter', index: focusableIndices[target] };
  }

  if (key === 'Home') return { kind: 'edge', index: focusableIndices[0] };
  if (key === 'End') return { kind: 'edge', index: focusableIndices[focusableIndices.length - 1] };

  const nextPosition =
    key === 'ArrowDown'
      ? (position + 1) % focusableIndices.length
      : (position - 1 + focusableIndices.length) % focusableIndices.length;
  return { kind: 'move', index: focusableIndices[nextPosition] };
};

/**
 * 元素当前是否**渲染可见**（display:none / visibility:hidden 的项不可聚焦）。
 *
 * 不用 `offsetParent === null` 判断：那对 `position: fixed` 的元素也成立，
 * 而菜单面板恰好是 fixed —— 会把可见项误判成不可见。
 */
export const isVisibleMenuItem = (element: HTMLElement): boolean => {
  if (element.getClientRects().length === 0) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return style?.visibility !== 'hidden';
};

/**
 * 从候选项里挑出**可聚焦**的项的下标（纯函数）。
 *
 * 这一步就是「方向键卡死」的解药：不可聚焦的项（`<label role=menuitem>`、
 * disabled、隐藏的项）根本不进候选集 ⇒ 方向键永远不会停在它们身上。
 *
 * 单独抽出来（而不是只在 DOM 版本里内联）是为了让**整条链**都能被单测：
 * 候选项 → 可聚焦下标 → 方向键决策。
 */
export const collectFocusableIndices = (
  candidates: MenuItemCandidate[]
): number[] => {
  const indices: number[] = [];
  candidates.forEach((candidate, index) => {
    if (isFocusableMenuItem(candidate)) indices.push(index);
  });
  return indices;
};

/**
 * 收集一个菜单容器里**可聚焦**的菜单项下标（相对容器内所有 `[role=menuitem]`）。
 *
 * 下标是相对「全部 menuitem」而不是「可聚焦项」—— 调用方拿它去
 * `items[index]` 取元素，两边口径一致。
 */
export const collectFocusableMenuItemIndices = (root: HTMLElement): number[] => {
  const items = Array.from(root.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  return collectFocusableIndices(
    items.map(element => ({
      tabIndex: element.tabIndex,
      disabled: element.hasAttribute('disabled'),
      hidden: !isVisibleMenuItem(element),
    }))
  );
};

