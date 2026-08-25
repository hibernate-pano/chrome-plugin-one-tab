import type { Middleware } from '@reduxjs/toolkit';
import { syncEngine } from '@/services/syncEngine';

// 优先级：值越大越紧急（数据删除/新建优先上传，避免本地删了云端还在）
const ACTION_PRIORITIES: Record<string, number> = {
  'tabs/deleteGroup/fulfilled': 10,
  'tabs/deleteAllGroups/fulfilled': 10,
  'tabs/restoreGroup/fulfilled': 10, // 恢复 = 覆写云端墓碑，尽快传播
  'tabs/saveGroup/fulfilled': 8,
  'tabs/importGroups/fulfilled': 8,
  'tabs/updateGroup/fulfilled': 5,
  'tabs/updateGroupNameAndSync/fulfilled': 5,
  'tabs/cleanDuplicateTabs/fulfilled': 5,
  'tabs/toggleGroupLockAndSync/fulfilled': 3,
  'tabs/moveGroupAndSync/fulfilled': 3,
  'tabs/moveTabAndSync/fulfilled': 2,
};

/**
 * 自动同步中间件。
 *
 * 监听数据变更 thunk 的 fulfilled action，按优先级防抖地调度云端上传。
 * 所有同步逻辑委托给 syncEngine.scheduleUpload()。
 * 未登录时不触发；错误型 action（rejected）不触发。
 */
export const autoSyncMiddleware: Middleware = store => next => (_action: unknown) => {
  const result = next(_action);

  const action = _action as { type?: string; error?: unknown };
  if (typeof action.type !== 'string') return result;
  if (action.error) return result;

  const priority = ACTION_PRIORITIES[action.type];
  if (priority == null) return result;

  const state = store.getState() as { auth?: { isAuthenticated?: boolean } };
  if (!state.auth?.isAuthenticated) return result;

  // 高优先级（删除/新建）1.5s，低优先级 3s
  const delayMs = priority >= 8 ? 1500 : 3000;
  syncEngine.scheduleUpload(delayMs);

  return result;
};
