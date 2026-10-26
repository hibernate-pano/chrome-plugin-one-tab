/**
 * 多条提示（toast）**上下堆叠**时的排布算式（纯函数）。
 *
 * ── 缺陷形态（2026-10-25 修「导入件冒充刚保存」时撞出来的）──────────────
 *
 * 旧实现给每条提示一个**写死**的偏移：`marginBottom: stackIndex * 76`。
 * 那个 76 是「一条**单行**提示大概这么高」的**估计值** ⇒ 一旦某条提示
 * 长了（多行），**上面那条就会压住它下面那条的下半截** ⇒
 * **用户读不到那句提示的结尾**。
 *
 * 这不是「长文本少见」的边角料：本仓有一条**必说**的长提示 ——
 * OneTab 导入的披露（「格式带不过去什么 + 后果 + 下一步」），
 * 加上 2026-10-25 的「保存时间未知」那一句之后，它有 5 行 ⇒
 * **末尾被下一条提示盖住** ⇒ 用户**看不到**「列表里显示为「导入 · …」」那半句。
 *
 * ⚠️ 这个缺陷在 2026-10-25 **之前就存在**（旧披露也有 4 行，同样被盖住），
 * 实证方式：把打包产物里的那句提示临时删短，重跑同一个探针 ⇒ 照样被盖。
 * ⇒ 本次是**顺手把根因修掉**（按实际高度堆叠），不是给长提示打补丁。
 *
 * ── 口径 ────────────────────────────────────────────────────────────────
 *
 * 提示锚在**右上角**（2026-10-26 从底部居中挪回右上角），所以偏移是
 * **离顶边的距离** ⇒ 偏移越大越靠下。
 *
 *   · 队列顺序 = **从旧到新**（与 `ToastContext` 里的数组一致）；
 *   · **最新的那条贴着顶边**（它是用户刚看到的那个，离角落最近）；
 *   · 更旧的那些排在它**下面**，偏移 = 上方各条的**实测高度之和** + 间距。
 *
 * ⇒ 不变式：**较旧那条的偏移 ≥ 较新那条的偏移 + 它的高度** ⇒ 任何一条
 *   都**不会**被遮住。这个算式与锚在顶边还是底边无关，只要偏移与锚点同向。
 *
 * ⚠️ 历史：2026-10-25 修那条遮挡缺陷时提示还锚在**底边**（`fixed bottom-4`
 *   + `marginBottom`），当时的方向是「最新的在最下面、旧的在上面」。
 *   本次换锚点后方向翻过来，**算式一字未改** —— 它算的只是「相邻两条之间
 *   要留出对方的高度 + 间距」，方向由渲染层决定。
 */

/** 还没量到高度时的兜底（= 旧实现写死的那个 76）。 */
export const DEFAULT_TOAST_HEIGHT = 76;

/** 两条提示之间的间距（px）。 */
export const TOAST_STACK_GAP = 8;

/** 队列里的一条（只要 id 与高度；高度未量到时留空）。 */
export interface ToastStackEntry {
  id: number;
  /** 实测高度（px）。未量到 / 量到 0 ⇒ 用 `DEFAULT_TOAST_HEIGHT` 兜底。 */
  height?: number;
}

/**
 * 每条提示离**顶边**多远（px）—— key 是提示的 id。
 *
 * @param queue 队列，顺序**从旧到新**（最新那条贴着顶边）。
 * @param gap 两条之间的间距。
 */
export const computeToastStackOffsets = (
  queue: ToastStackEntry[],
  gap: number = TOAST_STACK_GAP
): Map<number, number> => {
  const offsets = new Map<number, number>();
  let acc = 0;
  // 从最新（贴顶边）往旧（往下排）累加。
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    const entry = queue[i];
    offsets.set(entry.id, acc);
    const height =
      typeof entry.height === 'number' && entry.height > 0
        ? entry.height
        : DEFAULT_TOAST_HEIGHT;
    acc += height + gap;
  }
  return offsets;
};
