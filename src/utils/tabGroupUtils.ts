import { TabGroup } from '@/types/tab';

/**
 * 检查标签组是否为空且未锁定，符合自动删除条件
 * @param group 要检查的标签组
 * @returns 如果标签组为空且未锁定则返回 true，否则返回 false
 */
export const shouldAutoDeleteGroup = (group: TabGroup): boolean => {
  // 检查标签组是否为空
  const isEmpty = !group.tabs || group.tabs.length === 0;
  
  // 检查标签组是否未锁定
  const isNotLocked = !group.isLocked;
  
  // 只有当标签组为空且未锁定时才应该自动删除
  return isEmpty && isNotLocked;
};

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
  
  // 计算删除指定标签页后剩余的标签页数量
  const remainingTabsCount = group.tabs.filter(tab => tab.id !== tabIdToDelete).length;
  
  // 如果删除后没有剩余标签页，则应该自动删除标签组
  return remainingTabsCount === 0;
};

/**
 * 检查标签组在删除多个标签页后是否应该被自动删除
 * @param group 标签组
 * @param tabIdsToDelete 要删除的标签页ID数组
 * @returns 如果删除标签页后标签组应该被自动删除则返回 true
 */
export const shouldAutoDeleteAfterMultipleTabRemoval = (group: TabGroup, tabIdsToDelete: string[]): boolean => {
  // 如果标签组被锁定，不应该自动删除
  if (group.isLocked) {
    return false;
  }
  
  // 计算删除指定标签页后剩余的标签页数量
  const remainingTabsCount = group.tabs.filter(tab => !tabIdsToDelete.includes(tab.id)).length;
  
  // 如果删除后没有剩余标签页，则应该自动删除标签组
  return remainingTabsCount === 0;
};

/**
 * 从标签组数组中过滤掉应该自动删除的空标签组
 * @param groups 标签组数组
 * @returns 过滤后的标签组数组（移除了空的未锁定标签组）
 */
export const filterAutoDeleteGroups = (groups: TabGroup[]): TabGroup[] => {
  return groups.filter(group => !shouldAutoDeleteGroup(group));
};

/**
 * 获取应该自动删除的空标签组列表
 * @param groups 标签组数组
 * @returns 应该被自动删除的标签组数组
 */
export const getAutoDeleteGroups = (groups: TabGroup[]): TabGroup[] => {
  return groups.filter(group => shouldAutoDeleteGroup(group));
};

/**
 * 统计信息：获取空标签组的数量
 * @param groups 标签组数组
 * @returns 包含总数、空标签组数、锁定的空标签组数、可自动删除的空标签组数的统计信息
 */
export const getEmptyGroupsStats = (groups: TabGroup[]) => {
  const emptyGroups = groups.filter(group => !group.tabs || group.tabs.length === 0);
  const lockedEmptyGroups = emptyGroups.filter(group => group.isLocked);
  const autoDeleteGroups = emptyGroups.filter(group => !group.isLocked);
  
  return {
    totalGroups: groups.length,
    emptyGroups: emptyGroups.length,
    lockedEmptyGroups: lockedEmptyGroups.length,
    autoDeleteGroups: autoDeleteGroups.length,
  };
};
