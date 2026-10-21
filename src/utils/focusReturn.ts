/**
 * 「弹层关闭后焦点去哪」的登记表 —— 纯 DOM，无框架依赖。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────────
 * 确认框由 `ToastContext` **全局渲染**（不在菜单里）。打开它时，
 * `document.activeElement` 是触发它的那个**菜单项按钮**；而菜单项会在
 * 关闭时随菜单一起被卸载 ⇒ 确认框关闭时那个按钮 `isConnected === false`
 * ⇒ `useFocusTrap` 的旧判据（`!restoreTo.isConnected` ⇒ 不还焦）拒绝还焦
 * ⇒ **焦点掉到 `<body>`**。
 *
 * 同一个弹层，**两条路径行为不一致**（实测）：
 *   · Esc 关闭 → 菜单还开着（Esc 路径不关菜单）⇒ 按钮还在 ⇒ 还焦成功；
 *   · 点「取消」→ 菜单已关 ⇒ 按钮已卸载 ⇒ 拒绝还焦 ⇒ 焦点掉到 body。
 * 同一件事取决于用户按了哪个键 —— 这本身就是缺陷。
 *
 * 修法：让「打开弹层的那个地方」**显式登记**一个**稳定落点**
 * （菜单的触发按钮 / 卡片的 summary —— 它们不会随菜单项一起消失），
 * 还焦时优先用它。
 *
 * 优先用它（而不是只在失败时降级）是让两条路径**一致**的关键：
 * 若只在失败时降级，Esc 仍会还到「菜单项按钮」而「取消」还到「触发按钮」——
 * 还是两条路径两个落点。
 */

/** 一次登记：稳定还焦落点。 */
export interface FocusReturnRegistration {
  /**
   * 稳定落点。典型是**不会随菜单卸载而消失**的那个元素：
   * 顶栏的汉堡按钮（`[data-menu-trigger]`）、卡片的 summary。
   */
  target: HTMLElement | null;
}

let registration: FocusReturnRegistration = { target: null };

/**
 * 登记「弹层关闭后焦点应该回到哪」。
 *
 * 必须在**打开弹层之前**调用。
 */
export const registerFocusReturn = (target: HTMLElement | null): void => {
  registration = { target };
};

/**
 * 读当前登记（**不清空**）。
 *
 * 不清空是刻意的：确认框可能连续开（确认 → 失败 → 再确认），
 * 清空会让第二次弹层拿不到落点。
 */
export const peekFocusReturn = (): FocusReturnRegistration => registration;

/**
 * 读当前登记并**清空**（一次性消费）。
 *
 * 由还焦方在关闭时调用：登记是**为这一个弹层**准备的，
 * 消费掉才不会影响后面无关的弹层（比如登录弹窗）。
 */
export const consumeFocusReturn = (): FocusReturnRegistration => {
  const current = registration;
  registration = { target: null };
  return current;
};
