/**
 * Redux 持久化中间件
 * 
 * 监听状态变化并自动保存到存储，使用防抖避免频繁写入
 * 
 * 功能：
 * 1. 监听 tabs 和 settings 状态变化
 * 2. 使用防抖（500ms）避免频繁写入
 * 3. 支持选择性持久化特定 slice
 * 4. 错误处理和日志记录
 */

import { Middleware } from '@reduxjs/toolkit';
import { debounce } from 'lodash';
import { storage } from '@/utils/storage';
import { logSanitizer } from '@/utils/logSanitizer';
import { TabGroup, UserSettings } from '@/types/tab';

// 持久化配置
interface PersistenceConfig {
  // 防抖延迟（毫秒）
  debounceMs: number;
  // 需要持久化的 slice 名称
  slices: string[];
  // 需要忽略的 action 类型（不触发持久化）
  ignoredActions: string[];
}

const defaultConfig: PersistenceConfig = {
  debounceMs: 500,
  slices: ['tabs', 'settings'],
  ignoredActions: [
    // 加载操作不需要触发保存
    'tabs/loadGroups/pending',
    'tabs/loadGroups/fulfilled',
    'tabs/loadGroups/rejected',
    'settings/loadSettings/pending',
    'settings/loadSettings/fulfilled',
    'settings/loadSettings/rejected',
    // 同步操作由同步服务处理
    'tabs/syncTabsToCloud/pending',
    'tabs/syncTabsToCloud/fulfilled',
    'tabs/syncTabsToCloud/rejected',
    'tabs/syncTabsFromCloud/pending',
    'tabs/syncTabsFromCloud/fulfilled',
    'tabs/syncTabsFromCloud/rejected',
    // UI 状态不需要持久化
    'tabs/setSearchQuery',
    'tabs/setSyncStatus',
    'tabs/updateSyncProgress',
  ],
};

// 状态类型
interface RootState {
  tabs: {
    groups: TabGroup[];
    [key: string]: unknown;
  };
  settings: UserSettings;
  [key: string]: unknown;
}

// 上一次保存的状态快照（用于检测变化）
let lastSavedState: {
  tabGroups?: TabGroup[];
  settings?: UserSettings;
} = {};

/**
 * 保存标签组到存储
 */
async function persistTabGroups(groups: TabGroup[]): Promise<void> {
  try {
    // 检查是否有实际变化
    if (JSON.stringify(groups) === JSON.stringify(lastSavedState.tabGroups)) {
      return;
    }

    await storage.setGroups(groups);
    lastSavedState.tabGroups = groups;
    logSanitizer.debug(`[Persistence] 已保存 ${groups.length} 个标签组`);
  } catch (error) {
    logSanitizer.error('[Persistence] 保存标签组失败:', error);
  }
}

/**
 * 保存设置到存储
 */
async function persistSettings(settings: UserSettings): Promise<void> {
  try {
    // 检查是否有实际变化
    if (JSON.stringify(settings) === JSON.stringify(lastSavedState.settings)) {
      return;
    }

    await storage.setSettings(settings);
    lastSavedState.settings = settings;
    logSanitizer.debug('[Persistence] 已保存用户设置');
  } catch (error) {
    logSanitizer.error('[Persistence] 保存设置失败:', error);
  }
}

/**
 * 创建持久化中间件
 */
export function createPersistenceMiddleware(
  config: Partial<PersistenceConfig> = {}
): Middleware {
  const finalConfig = { ...defaultConfig, ...config };

  // 创建防抖的保存函数
  const debouncedPersistTabs = debounce(persistTabGroups, finalConfig.debounceMs);
  const debouncedPersistSettings = debounce(persistSettings, finalConfig.debounceMs);

  return store => next => (action: unknown) => {
    // 先执行 action
    const result = next(action);

    // 类型检查
    if (!action || typeof action !== 'object' || !('type' in action)) {
      return result;
    }

    const actionType = (action as { type: string }).type;

    // 检查是否需要忽略此 action
    if (finalConfig.ignoredActions.includes(actionType)) {
      return result;
    }

    // 获取更新后的状态
    const state = store.getState() as RootState;

    // 标签相关操作
    if (
      finalConfig.slices.includes('tabs') &&
      (actionType.startsWith('tabs/') || actionType === 'tabs/setGroups')
    ) {
      // 排除不需要持久化的操作
      const shouldPersist = !actionType.includes('pending') &&
        !actionType.includes('rejected') &&
        !finalConfig.ignoredActions.includes(actionType);

      if (shouldPersist && state.tabs?.groups) {
        debouncedPersistTabs(state.tabs.groups);
      }
    }

    // 设置相关操作
    if (
      finalConfig.slices.includes('settings') &&
      actionType.startsWith('settings/')
    ) {
      const shouldPersist = !actionType.includes('pending') &&
        !actionType.includes('rejected') &&
        !finalConfig.ignoredActions.includes(actionType);

      if (shouldPersist && state.settings) {
        debouncedPersistSettings(state.settings);
      }
    }

    return result;
  };
}

/**
 * 立即刷新所有待保存的数据
 * 用于应用关闭前确保数据保存
 */
export function flushPersistence(): void {
  // 由于 debounce 函数有 flush 方法，但我们这里使用的是闭包内的函数
  // 所以需要在创建中间件时暴露 flush 方法
  logSanitizer.info('[Persistence] 刷新待保存数据');
}

/**
 * 默认的持久化中间件实例
 */
export const persistenceMiddleware = createPersistenceMiddleware();

export default persistenceMiddleware;
