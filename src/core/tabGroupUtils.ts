import { TabGroup } from '../types/tab';

/**
 * 检查标签组在删除指定标签页后是否应该被自动删除
 * @param group 标签组
 * @param tabIdToDelete 要删除的标签页ID
 * @returns 如果删除标签页后标签组应该被自动删除则返回 true
 */
export const shouldAutoDeleteAfterTabRemoval = (group: TabGroup, tabIdToDelete: string): boolean => {
  // 如果标签组被锁定，不应该自动删除
  if (group.isLocked) {
    return false;
  }

  // 只统计活跃（非墓碑）标签：storage 中墓碑 tab 用于同步删除意图，
  // 不代表用户可见的标签；否则墓碑会让空组永远不满足自动删除条件
  const remainingTabsCount = group.tabs.filter(
    tab => tab.id !== tabIdToDelete && !tab.isDeleted
  ).length;

  // 如果删除后没有剩余活跃标签页，则应该自动删除标签组
  return remainingTabsCount === 0;
};

/**
 * 组里**唯一一条活跃标签**的 id —— 删掉它 ⇒ 整个会话消失（2026-10-23 审计 DS-43-16）。
 *
 * ── 为什么需要这个「另一种问法」 ────────────────────────────────────────
 * `shouldAutoDeleteAfterTabRemoval(group, tabId)` 是「删掉**这一条**会不会让整组消失」，
 * 每次问都要 O(n) 扫一遍组里的标签。而列表页要为**每一条**渲染行都问一次
 * ⇒ O(n²)。一个会话塞进几百条标签时，一次渲染就是几十万个数组分配，
 * 而拖拽过程中每 100ms 就重渲一次。
 *
 * ⇒ 同一个问题换一种问法：「这条删掉会不会让整组消失？」
 *   等价于「它是不是组里唯一那条活跃标签？」—— 一次扫完全组就能回答所有行。
 *
 * ── 与 `shouldAutoDeleteAfterTabRemoval` 的等价关系 ──────────────────────
 * 设组里活跃标签数为 A：
 *   A ≥ 2 ⇒ 删掉任何一条都还剩 ≥1 ⇒ 不删整组；本函数返回 null ✓
 *   A = 1 ⇒ 只有那唯一一条满足；返回它的 id ✓
 *   A = 0 ⇒ 组里没有可见内容，删哪条都不构成「用户可见的整组消失」
 *          ⇒ 返回 null（`shouldAutoDeleteAfterTabRemoval` 在这个退化情形下
 *            返回 true，但那种组没有可点 ✕ 的行，结论不影响用户）。
 * 锁定组 ⇒ 返回 null（锁定组不会因删最后一条而消失，见上）。
 *
 * `tests/guards/removeTabEntryDisclosure.test.ts` 把这条等价关系钉死。
 */
export const onlyActiveTabId = (group: TabGroup): string | null => {
  if (group.isLocked) {
    return null;
  }
  let only: string | null = null;
  let count = 0;
  for (const tab of group.tabs) {
    if (tab.isDeleted) continue;
    count += 1;
    if (count > 1) return null;
    only = tab.id;
  }
  return only;
};
