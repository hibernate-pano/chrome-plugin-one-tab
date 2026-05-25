import type { Middleware } from '@reduxjs/toolkit';
import { scheduleAutoSync } from '@/utils/syncHelpers';

const ACTION_PRIORITIES: Record<string, number> = {
  'tabs/deleteGroup/fulfilled': 10,
  'tabs/deleteAllGroups/fulfilled': 10,
  'tabs/deleteTabAndSync/fulfilled': 10,
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
 * 自动同步中间件
 * 监听数据变更 thunk 的 fulfilled action，带优先级防抖地触发云端上传。
 * 手动同步（smartSyncService）会在触发前调用 cancelPendingSync() 避让。
 */
export const autoSyncMiddleware: Middleware = store => next => (_action: unknown) => {
  const result = next(_action);

  const action = _action as { type?: string; error?: unknown };
  if (typeof action.type !== 'string') return result;
  if (action.error) return result;

  const priority = ACTION_PRIORITIES[action.type];
  if (priority == null) return result;

  const state = store.getState() as any;
  if (!state.auth?.isAuthenticated) return result;

  scheduleAutoSync(store.dispatch as any, priority);

  return result;
};
