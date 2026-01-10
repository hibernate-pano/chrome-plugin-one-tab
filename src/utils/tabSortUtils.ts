/**
 * 标签组排序工具 (兼容层)
 * 重新导出 groupSortUtils 并添加便捷函数
 */

import { TabGroup } from '@/types/tab';
import {
  sortGroupsByCreatedAt,
  filterActiveGroups,
} from './groupSortUtils';

// 重新导出主要函数
export { sortGroupsByCreatedAt, filterActiveGroups };

/**
 * 过滤并排序活跃的标签组
 */
export function getActiveGroupsSorted(groups: TabGroup[]): TabGroup[] {
  const activeGroups = filterActiveGroups(groups);
  return sortGroupsByCreatedAt(activeGroups, 'desc');
}

/**
 * 合并并排序标签组
 */
export function mergeAndSortGroups(
  existingGroups: TabGroup[],
  newGroups: TabGroup[]
): TabGroup[] {
  const mergedGroups = [...newGroups, ...existingGroups];
  return sortGroupsByCreatedAt(mergedGroups, 'desc');
}
