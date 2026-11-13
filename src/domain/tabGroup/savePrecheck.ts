import { collectableTabs } from './filters';
import type { FilterTabsOptions } from './filters';

/**
 * 保存前的预检结论（2026-11-12）。
 *
 * ── 为什么需要「分类」而不是一个布尔 ─────────────────────────────────────
 *
 * 上一版（2026-11-06）预检只有一个判据：`collectableTabs(...).length === 0`
 * ⇒ 失败时一律给同一句话「这个窗口里没有可保存的网页…」。
 *
 * 那句话在**一种**情况下是真的，在**另一种**情况下是**错的**：
 *
 *   场景：用户在一窗里 pin 了所有标签（工作台），设置里「保存时收集固定标签页」
 *         是**关闭**的（默认）。
 *   ⇒ `collectableTabs`（includePinned=false）返回 0。
 *   ⇒ 但这一窗**明明有可保存的网页** —— 它们只是被设置过滤掉了。
 *   ⇒ 提示却说「这个窗口里没有可保存的网页…先打开几个要收起来的网页」。
 *   ⇒ 用户照做 → 开新标签 → 提示照旧（还是 0 个可保存的）→ 界面的观感是「坏了」。
 *
 * ⚠️ **行为**上没问题：预检与 SW 保存路径同用一个 `collectableTabs`，口径一致，
 *   不会出现「这里说能存、实际存不下」。有问题的是**解释** ——
 *   而「声明 ≠ 行为」正是这批改动自己批判的那件事，不能自己犯。
 *
 * ── 判据 ────────────────────────────────────────────────────────────────
 *
 * 只存得下 0 条时，**再问一次**：如果连固定标签页都收，会不会有？
 *   · 有 ⇒ 原因不是「没有网页」，而是「能存的那些全是固定标签页，被设置挡住了」
 *           → `only-pinned-tabs`
 *   · 没有 ⇒ 这一窗真的一个可存的都没有（空窗 / 只剩管理器页 / 全是内部页）
 *           → `no-savable-tabs`
 *
 * ⚠️ `includePinned` 为 true 时不做第二次询问 —— 那种情况下固定标签页已经算进去了，
 *   仍然是 0 就说明真的没有（否则会把「开了开关还是没网页」误报成设置问题）。
 */
export type SavePrecheckKind =
  /** 这一窗有可保存的标签，可以直接保存。 */
  | 'ok'
  /** 这一窗真的一个可保存的都没有（只剩管理器页 / 内部页 / 空窗）。 */
  | 'no-savable-tabs'
  /**
   * 能保存的网页**全是固定标签页**，而设置里「保存时收集固定标签页」是关的。
   * ⇒ 卡点在设置，不在窗口。
   */
  | 'only-pinned-tabs';

export const classifySavePrecheck = (
  tabs: chrome.tabs.Tab[],
  options: FilterTabsOptions = {}
): SavePrecheckKind => {
  const includePinned = options.includePinned ?? false;

  if (collectableTabs(tabs, { includePinned }).length > 0) return 'ok';

  if (
    !includePinned &&
    collectableTabs(tabs, { includePinned: true }).length > 0
  ) {
    return 'only-pinned-tabs';
  }

  return 'no-savable-tabs';
};