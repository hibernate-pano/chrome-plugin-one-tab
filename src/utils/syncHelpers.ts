import { syncTabsToCloud } from '@/store/slices/tabSlice';
import { ThunkDispatch, UnknownAction } from '@reduxjs/toolkit';

/**
 * 通用的同步辅助函数，用于将本地数据变更同步到云端
 * @param dispatch Redux dispatch 函数
 * @param getState Redux getState 函数
 * @param operationType 操作类型，用于日志记录
 * @returns 同步是否成功
 */
export async function syncToCloud<T>(
  dispatch: ThunkDispatch<T, any, UnknownAction>,
  getState: () => any,
  operationType: string
): Promise<boolean> {
  const { auth } = getState();

  // 如果用户已登录，自动同步到云端
  if (auth.isAuthenticated) {
    try {
      await dispatch(syncTabsToCloud({ background: true }));
      console.log(`${operationType}已自动同步到云端`);
      return true;
    } catch (error) {
      console.error(`${operationType}同步到云端失败:`, error);
      return false;
    }
  }

  return false;
}
