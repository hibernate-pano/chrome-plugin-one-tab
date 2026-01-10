/**
 * 标签组排序工具
 * 统一处理标签组的排序逻辑,避免重复代码
 */

import { TabGroup } from '@/types/tab';

/**
 * 按创建时间倒序排序标签组(最新的在前面)
 */
export function sortGroupsByCreatedAt(groups: TabGroup[]): TabGroup[] {
  return [...groups].sort((a, b) => {
    const dateA = new Date(a.createdAt).getTime();
    const dateB = new Date(b.createdAt).getTime();
    return dateB - dateA;
  });
}

/**
 * 过滤并排序活跃的标签组
 */
export function getActiveGroupsSorted(groups: TabGroup[]): TabGroup[] {
  const activeGroups = groups.filter(g => !g.isDeleted);
  return sortGroupsByCreatedAt(activeGroups);
}

/**
 * 合并并排序标签组
 */
export function mergeAndSortGroups(
  existingGroups: TabGroup[],
  newGroups: TabGroup[]
): TabGroup[] {
  const mergedGroups = [...newGroups, ...existingGroups];
  return sortGroupsByCreatedAt(mergedGroups);
}
