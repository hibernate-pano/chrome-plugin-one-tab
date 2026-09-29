/**
 * 标签排序的键盘决策（纯函数，可单测）。
 *
 * 背景：会话内的标签重排只有 react-dnd 的 HTML5Backend（鼠标）一条路，
 * 纯键盘用户完全没有重排能力。本模块把「某个键应把第几项移动到第几项」
 * 从组件里抽出来：组件只负责派发 moveTab，规则本身在这里单测。
 *
 * 约定：
 * - 返回 null = 这不是重排键，或已到边界（不消费事件、不移动）。
 *   边界返回 null 而不是「原地不动」，是为了让调用方能跳过 preventDefault，
 *   避免把边界按键吞掉影响页面其他行为。
 * - 移动是「一步一档」：到边界就不再累积，与拖拽 hover 的语义一致。
 */
export type ReorderKey = 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

const REORDER_KEYS: ReadonlySet<string> = new Set<ReorderKey>([
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
]);

/** 该键是否属于重排键。 */
export function isReorderKey(key: string): key is ReorderKey {
  return REORDER_KEYS.has(key);
}

/**
 * 把 `currentIndex` 的项移动到的新下标。
 *
 * @param key           键盘事件的 key
 * @param currentIndex  当前项下标（0 基）
 * @param itemCount     列表长度
 * @returns 目标下标；不是重排键 / 已到边界 / 列表不可动时返回 null
 */
export function nextReorderIndex(
  key: string,
  currentIndex: number,
  itemCount: number
): number | null {
  if (!isReorderKey(key)) return null;
  // 空列表 / 单项列表没有可移动的相邻项
  if (!Number.isInteger(itemCount) || itemCount < 2) return null;
  if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= itemCount) {
    return null;
  }

  switch (key) {
    case 'ArrowUp':
      return currentIndex > 0 ? currentIndex - 1 : null;
    case 'ArrowDown':
      return currentIndex < itemCount - 1 ? currentIndex + 1 : null;
    case 'Home':
      return currentIndex > 0 ? 0 : null;
    case 'End':
      return currentIndex < itemCount - 1 ? itemCount - 1 : null;
    default:
      return null;
  }
}
