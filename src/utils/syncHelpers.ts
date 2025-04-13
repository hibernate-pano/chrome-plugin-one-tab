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
  // 使用 setTimeout 将同步操作推迟到下一个事件循环
  // 这样可以确保用户界面操作不会被阻塞
  return new Promise((resolve) => {
    setTimeout(async () => {
      try {
        const { auth } = getState();

        // 如果用户已登录，自动同步到云端
        if (auth.isAuthenticated) {
          try {
            // 使用 background: true 确保同步在后台运行
            await dispatch(syncTabsToCloud({ background: true }));
            // 仅在调试模式下输出日志
            if (process.env.NODE_ENV === 'development') {
              console.log(`${operationType}已自动同步到云端`);
            }
            resolve(true);
          } catch (error) {
            // 仅在调试模式下输出错误
            if (process.env.NODE_ENV === 'development') {
              console.error(`${operationType}同步到云端失败:`, error);
            }
            resolve(false);
          }
        } else {
          resolve(false);
        }
      } catch (e) {
        // 捕获所有异常，确保不会影响用户体验
        if (process.env.NODE_ENV === 'development') {
          console.error('同步过程中发生异常:', e);
        }
        resolve(false);
      }
    }, 0); // 使用 0 毫秒的延迟，将操作推到下一个事件循环
  });
}
