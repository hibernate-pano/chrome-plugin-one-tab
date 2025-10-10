import { TabGroup } from '@/types/tab';

/**
 * 版本号辅助函数
 * 用于统一管理标签组的版本号递增逻辑
 */

/**
 * 递增标签组的版本号
 * @param group 标签组
 * @returns 新的版本号
 */
export function incrementVersion(group: TabGroup): number {
  const currentVersion = group.version || 1;
  return currentVersion + 1;
}

/**
 * 为标签组添加版本号和更新时间
 * @param group 标签组
 * @param additionalFields 额外要更新的字段
 * @returns 更新后的标签组
 */
export function updateGroupWithVersion<T extends Partial<TabGroup>>(
  group: TabGroup,
  additionalFields: T = {} as T
): TabGroup & T {
  const currentVersion = group.version || 1;
  const updatedAt = new Date().toISOString();

  return {
    ...group,
    ...additionalFields,
    version: currentVersion + 1,
    updatedAt,
  } as TabGroup & T;
}

/**
 * 批量更新标签组的 displayOrder
 * @param groups 标签组数组（已排序）
 * @returns 更新后的标签组数组
 */
export function updateDisplayOrder(groups: TabGroup[]): TabGroup[] {
  return groups.map((group, index) => ({
    ...group,
    displayOrder: index,
    version: (group.version || 1) + 1,
    updatedAt: new Date().toISOString(),
  }));
}

/**
 * 初始化标签组的版本号和显示顺序（用于数据迁移）
 * @param group 标签组
 * @param index 在数组中的索引
 * @returns 初始化后的标签组
 */
export function initializeVersionFields(group: TabGroup, index: number): TabGroup {
  return {
    ...group,
    version: group.version || 1,
    displayOrder: group.displayOrder ?? index,
  };
}
