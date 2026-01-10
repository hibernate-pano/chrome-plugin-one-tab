/**
 * 类型守卫工具
 * 提供运行时类型检查和验证
 */

import { Tab, TabGroup, User, UserSettings } from '@/types/tab';

/**
 * 检查是否为有效的Tab对象
 */
export function isTab(value: unknown): value is Tab {
  if (!value || typeof value !== 'object') return false;

  const tab = value as Partial<Tab>;

  return (
    typeof tab.id === 'string' &&
    typeof tab.url === 'string' &&
    typeof tab.title === 'string' &&
    typeof tab.createdAt === 'string' &&
    typeof tab.lastAccessed === 'string'
  );
}

/**
 * 检查是否为有效的TabGroup对象
 */
export function isTabGroup(value: unknown): value is TabGroup {
  if (!value || typeof value !== 'object') return false;

  const group = value as Partial<TabGroup>;

  return (
    typeof group.id === 'string' &&
    typeof group.name === 'string' &&
    Array.isArray(group.tabs) &&
    group.tabs.every(isTab) &&
    typeof group.createdAt === 'string' &&
    typeof group.updatedAt === 'string' &&
    typeof group.isLocked === 'boolean'
  );
}

/**
 * 检查是否为有效的User对象
 */
export function isUser(value: unknown): value is User {
  if (!value || typeof value !== 'object') return false;

  const user = value as Partial<User>;

  return (
    typeof user.id === 'string' &&
    typeof user.email === 'string' &&
    typeof user.lastLogin === 'string'
  );
}

/**
 * 检查是否为有效的UserSettings对象
 */
export function isUserSettings(value: unknown): value is UserSettings {
  if (!value || typeof value !== 'object') return false;

  const settings = value as Partial<UserSettings>;

  return (
    typeof settings.groupNameTemplate === 'string' &&
    typeof settings.showFavicons === 'boolean' &&
    typeof settings.showTabCount === 'boolean' &&
    typeof settings.confirmBeforeDelete === 'boolean' &&
    typeof settings.allowDuplicateTabs === 'boolean' &&
    typeof settings.syncEnabled === 'boolean' &&
    typeof settings.showNotifications === 'boolean'
  );
}

/**
 * 检查是否为有效的URL
 */
export function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查是否为有效的Email
 */
export function isValidEmail(email: string): boolean {
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return emailRegex.test(email);
}

/**
 * 检查是否为有效的ISO日期字符串
 */
export function isISODateString(value: string): boolean {
  const date = new Date(value);
  return !isNaN(date.getTime()) && value === date.toISOString();
}

/**
 * 验证并清理Tab对象
 */
export function validateTab(tab: unknown): Tab | null {
  if (!isTab(tab)) return null;

  // 验证URL格式
  if (!isValidUrl(tab.url)) {
    console.warn(`无效的URL: ${tab.url}`);
    return null;
  }

  // 确保日期字符串有效
  if (!isISODateString(tab.createdAt) || !isISODateString(tab.lastAccessed)) {
    console.warn(`无效的日期字符串: ${tab.createdAt}, ${tab.lastAccessed}`);
    return null;
  }

  return tab;
}

/**
 * 验证并清理TabGroup对象
 */
export function validateTabGroup(group: unknown): TabGroup | null {
  if (!isTabGroup(group)) return null;

  // 验证所有标签页
  const validTabs = group.tabs.map(validateTab).filter((tab): tab is Tab => tab !== null);

  if (validTabs.length !== group.tabs.length) {
    console.warn(`标签组 ${group.name} 包含 ${group.tabs.length - validTabs.length} 个无效标签页`);
  }

  return {
    ...group,
    tabs: validTabs,
  };
}

/**
 * 批量验证TabGroup数组
 */
export function validateTabGroups(groups: unknown[]): TabGroup[] {
  if (!Array.isArray(groups)) {
    console.error('groups 不是数组');
    return [];
  }

  const validGroups = groups
    .map(validateTabGroup)
    .filter((group): group is TabGroup => group !== null);

  if (validGroups.length !== groups.length) {
    console.warn(`过滤了 ${groups.length - validGroups.length} 个无效标签组`);
  }

  return validGroups;
}

/**
 * 深度克隆并验证Tab对象
 */
export function cloneTab(tab: Tab): Tab {
  return {
    ...tab,
    // 确保不共享引用
    createdAt: tab.createdAt,
    lastAccessed: tab.lastAccessed,
  };
}

/**
 * 深度克隆并验证TabGroup对象
 */
export function cloneTabGroup(group: TabGroup): TabGroup {
  return {
    ...group,
    tabs: group.tabs.map(cloneTab),
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}

/**
 * 安全的JSON解析，带有类型验证
 */
export function safeJSONParse<T>(
  json: string,
  validator: (value: unknown) => value is T
): T | null {
  try {
    const value = JSON.parse(json);
    return validator(value) ? value : null;
  } catch (error) {
    console.error('JSON解析失败:', error);
    return null;
  }
}

/**
 * 创建默认的Tab对象
 */
export function createDefaultTab(overrides: Partial<Tab> = {}): Tab {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    url: 'about:blank',
    title: '新标签页',
    createdAt: now,
    lastAccessed: now,
    ...overrides,
  };
}

/**
 * 创建默认的TabGroup对象
 */
export function createDefaultTabGroup(overrides: Partial<TabGroup> = {}): TabGroup {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: '新标签组',
    tabs: [],
    createdAt: now,
    updatedAt: now,
    isLocked: false,
    version: 1,
    displayOrder: 0,
    ...overrides,
  };
}

/**
 * 断言函数 - 用于TypeScript的类型收窄
 */
export function assertIsTab(value: unknown): asserts value is Tab {
  if (!isTab(value)) {
    throw new Error('值不是有效的Tab对象');
  }
}

export function assertIsTabGroup(value: unknown): asserts value is TabGroup {
  if (!isTabGroup(value)) {
    throw new Error('值不是有效的TabGroup对象');
  }
}

/**
 * 类型安全的数组过滤
 */
export function filterTabs(tabs: unknown[]): Tab[] {
  return tabs.filter(isTab);
}

export function filterTabGroups(groups: unknown[]): TabGroup[] {
  return groups.filter(isTabGroup);
}
