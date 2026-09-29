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
