// 筛选项的「可用性」判定 —— 2026-10-20 审计 A-5。
//
// ── 缺陷 ────────────────────────────────────────────────────────────────
//
// 搜索面板里一直挂着「固定标签页」筛选器（全部 / 仅固定 / 排除固定）。
// 但 `collectPinnedTabs`（设置里的「保存固定标签页」）**默认是关的**，
// 而这个设置决定了存进会话的标签带不带 `pinned` 标记：
//
//   · 设置关闭 ⇒ 存进去的标签 `pinned` 恒为 `false`
//   · ⇒「仅固定」永远筛不出任何东西
//   · ⇒「排除固定」等价于「全部」
//
// 也就是说，**默认配置下这个筛选项是一个纯粹的死控件** ——
// 摆在用户面前，还占着筛选面板的一行。
//
// 而空态提示里那句「可结合域名、保存时间和固定标签筛选」还在
// **无条件**承诺它 —— 用户照着提示去找，找不到。
//
// ── 判定口径 ────────────────────────────────────────────────────────────
//
// 两件事必须同时成立，才算「这个筛选项存在」：
//
//   1. **看得见**：UI 里要渲染这个 select（默认配置下不渲染）
//   2. **算数**：筛选条件要真的参与过滤（否则就是隐形筛掉结果）
//
// 第 2 点容易被忽略：设置页在**另一个标签页**里被改动时，
// 本页会收到 storage 变更 ⇒ 用户可能
// 「开启过固定标签筛选 → 设了条件 → 再关掉设置」，
// 此时 UI 已经把 select 藏了，但条件还在生效 ⇒
// 用户**看不到筛选项，却被它筛掉了结果**。这是最坏的一种隐形行为。
//
// 所以本模块只负责第 2 点（纯函数，可测）；第 1 点在组件里，
// 由 `tests/pinnedFilterAvailability.test.ts` 钉住。
//
// UI 侧的直接判据就是 `collectPinnedTabs` 本身 —— 可见性与有效性
// 由同一个开关决定，不会出现「看得见但不生效」或「不生效但还在筛」。
import type { SearchFilters } from '@/utils/search';

/**
 * 计算**真正参与过滤**的筛选条件。
 *
 * @param filters 用户当前设置的筛选条件
 * @param collectPinnedTabs 设置里的「保存固定标签页」是否开启
 * @returns 关闭固定标签收集时移除 `pinned` 条件的筛选条件
 */
export const resolveEffectiveSearchFilters = (
  filters: SearchFilters,
  collectPinnedTabs: boolean
): SearchFilters => {
  if (collectPinnedTabs) return filters;
  if (filters.pinned === undefined) return filters;
  return { ...filters, pinned: undefined };
};
