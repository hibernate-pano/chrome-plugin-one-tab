import { TabGroup } from '@/types/tab';

/**
 * 统一的排序工具函数
 * 消除代码中的重复排序逻辑
 */

// 排序方向
export type SortDirection = 'asc' | 'desc';

/**
 * 按创建时间排序标签组
 * @param groups 标签组数组
 * @param direction 排序方向，默认为倒序（最新的在前面）
 * @returns 排序后的数组
 */
export function sortGroupsByCreatedAt(
  groups: TabGroup[],
  direction: SortDirection = 'desc'
): TabGroup[] {
  return [...groups].sort((a, b) => {
    const dateA = new Date(a.createdAt).getTime();
    const dateB = new Date(b.createdAt).getTime();
    return direction === 'desc' ? dateB - dateA : dateA - dateB;
  });
}

/**
 * 按更新时间排序标签组
 * @param groups 标签组数组
 * @param direction 排序方向，默认为倒序（最新的在前面）
 * @returns 排序后的数组
 */
export function sortGroupsByUpdatedAt(
  groups: TabGroup[],
  direction: SortDirection = 'desc'
): TabGroup[] {
  return [...groups].sort((a, b) => {
    const dateA = new Date(a.updatedAt).getTime();
    const dateB = new Date(b.updatedAt).getTime();
    return direction === 'desc' ? dateB - dateA : dateA - dateB;
  });
}

/**
 * 智能排序：优先使用 displayOrder，回退到 createdAt
 * @param groups 标签组数组
 * @returns 排序后的数组
 */
export function sortGroupsSmart(groups: TabGroup[]): TabGroup[] {
  return groups.sort((a, b) => {
    // 优先使用 displayOrder
    const orderA = a.displayOrder;
    const orderB = b.displayOrder;

    if (orderA !== undefined && orderB !== undefined) {
      return orderA - orderB;
    }

    // 如果只有一个有 displayOrder，有的排在前面
    if (orderA !== undefined) return -1;
    if (orderB !== undefined) return 1;

    // 都没有 displayOrder，按创建时间倒序
    const dateA = new Date(a.createdAt).getTime();
    const dateB = new Date(b.createdAt).getTime();
    return dateB - dateA;
  });
}

/**
 * 过滤活跃的标签组（排除已软删除的）
 * @param groups 标签组数组
 * @returns 过滤后的活跃标签组
 */
export function filterActiveGroups(groups: TabGroup[]): TabGroup[] {
  return groups.filter(g => !g.isDeleted);
}

/**
 * 过滤已删除的标签组
 * @param groups 标签组数组
 * @returns 已删除的标签组
 */
export function filterDeletedGroups(groups: TabGroup[]): TabGroup[] {
  return groups.filter(g => g.isDeleted);
}

/**
 * 查找标签组
 * @param groups 标签组数组
 * @param groupId 要查找的标签组ID
 * @returns 找到的标签组或 undefined
 */
export function findGroupById(groups: TabGroup[], groupId: string): TabGroup | undefined {
  return groups.find(g => g.id === groupId);
}

/**
 * 查找标签组索引
 * @param groups 标签组数组
 * @param groupId 要查找的标签组ID
 * @returns 找到的索引或 -1
 */
export function findGroupIndex(groups: TabGroup[], groupId: string): number {
  return groups.findIndex(g => g.id === groupId);
}

/**
 * 移动标签组到新位置（不修改原数组）
 * @param groups 标签组数组
 * @param fromIndex 源索引
 * @param toIndex 目标索引
 * @returns 移动后的新数组
 */
export function moveGroup(groups: TabGroup[], fromIndex: number, toIndex: number): TabGroup[] {
  if (fromIndex < 0 || fromIndex >= groups.length) {
    console.error('无效的源索引:', fromIndex);
    return groups;
  }
  if (toIndex < 0 || toIndex >= groups.length) {
    console.error('无效的目标索引:', toIndex);
    return groups;
  }

  const result = [...groups];
  const [movedGroup] = result.splice(fromIndex, 1);
  result.splice(toIndex, 0, movedGroup);
  return result;
}

/**
 * 更新标签组的 displayOrder 和 version
 * @param groups 标签组数组
 * @returns 更新后的数组
 */
export function updateDisplayOrder(groups: TabGroup[]): TabGroup[] {
  return groups.map((group, index) => ({
    ...group,
    displayOrder: index,
    version: (group.version || 1) + 1,
    updatedAt: new Date().toISOString(),
  }));
}
