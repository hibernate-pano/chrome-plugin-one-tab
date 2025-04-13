import { syncTabsToCloud } from '@/store/slices/tabSlice';
import { ThunkDispatch, UnknownAction } from '@reduxjs/toolkit';

// 防抖计时器
let syncDebounceTimer: NodeJS.Timeout | null = null;
// 最后一次同步的时间
let lastSyncTime = 0;
// 防抖延迟时间
const SYNC_DEBOUNCE_DELAY = 500; // 0.5秒，减少延迟但仍能有效防抖

/**
 * 通用的同步辅助函数，用于将本地数据变更同步到云端
 * @param dispatch Redux dispatch 函数
 * @param getState Redux getState 函数
 * @param operationType 操作类型，用于日志记录
 * @returns 同步是否成功
 */
// 操作优先级定义
const OPERATION_PRIORITIES: Record<string, number> = {
  '删除标签组': 10,
  '删除所有标签组': 10,
  '更新标签组': 5,
  '新标签组': 5,
  '标签组名称更新': 3,
  '标签组锁定状态更新': 3,
  '标签组顺序更新': 3,
  '标签页移动': 3,
  '导入标签组': 5,
  '本地更改': 1
};

// 当前正在进行的同步操作信息
let currentSyncOperation: { type: string; priority: number } | null = null;

export async function syncToCloud<T>(
  dispatch: ThunkDispatch<T, any, UnknownAction>,
  getState: () => any,
  operationType: string
): Promise<boolean> {
  // 获取当前操作的优先级
  const priority = OPERATION_PRIORITIES[operationType] || 1;

  // 使用防抖机制，确保在快速连续操作时只执行最后一次同步
  return new Promise((resolve) => {
    // 如果当前有正在进行的同步操作，判断是否需要取消
    if (currentSyncOperation && syncDebounceTimer) {
      // 如果新操作的优先级高于当前操作，取消当前操作
      if (priority > currentSyncOperation.priority) {
        if (process.env.NODE_ENV === 'development') {
          console.log(`新操作 ${operationType} 优先级(${priority})高于当前操作 ${currentSyncOperation.type} 优先级(${currentSyncOperation.priority})，取消当前操作`);
        }
        clearTimeout(syncDebounceTimer);
        syncDebounceTimer = null;
      } else if (priority < currentSyncOperation.priority) {
        // 如果新操作的优先级低于当前操作，忽略新操作
        if (process.env.NODE_ENV === 'development') {
          console.log(`新操作 ${operationType} 优先级(${priority})低于当前操作 ${currentSyncOperation.type} 优先级(${currentSyncOperation.priority})，忽略新操作`);
        }
        resolve(true); // 返回成功，不影响用户体验
        return;
      } else {
        // 如果优先级相同，取消当前操作，执行新操作
        clearTimeout(syncDebounceTimer);
        syncDebounceTimer = null;
      }
    }

    // 更新当前同步操作信息
    currentSyncOperation = { type: operationType, priority };

    // 设置新的定时器
    syncDebounceTimer = setTimeout(async () => {
      try {
        const { auth } = getState();
        const now = Date.now();

        // 如果用户已登录，自动同步到云端
        if (auth.isAuthenticated) {
          // 检查距离上次同步的时间是否足够
          if (now - lastSyncTime > SYNC_DEBOUNCE_DELAY) {
            try {
              // 更新最后同步时间
              lastSyncTime = now;

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
            } finally {
              // 清除当前同步操作信息
              currentSyncOperation = null;
            }
          } else {
            // 距离上次同步时间太短，跳过本次同步
            if (process.env.NODE_ENV === 'development') {
              console.log(`距离上次同步时间太短，跳过 ${operationType} 的同步`);
            }
            currentSyncOperation = null;
            resolve(true); // 返回成功，不影响用户体验
          }
        } else {
          currentSyncOperation = null;
          resolve(false);
        }
      } catch (e) {
        // 捕获所有异常，确保不会影响用户体验
        if (process.env.NODE_ENV === 'development') {
          console.error('同步过程中发生异常:', e);
        }
        currentSyncOperation = null;
        resolve(false);
      }
    }, priority >= 10 ? 100 : SYNC_DEBOUNCE_DELAY); // 高优先级操作使用更短的延迟
  });
}
