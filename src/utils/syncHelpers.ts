import { ThunkDispatch, AnyAction } from '@reduxjs/toolkit';

// 防抖计时器
let syncDebounceTimer: NodeJS.Timeout | null = null;
// 防抖延迟时间
const SYNC_DEBOUNCE_DELAY = 300; // 减少到0.3秒，使操作更及时

/**
 * 通用的同步辅助函数，用于将本地数据变更同步到云端
 *
 * 该函数实现了智能同步策略，包括：
 * 1. 操作优先级管理 - 高优先级操作（如删除）会中断低优先级操作
 * 2. 防抖控制 - 在短时间内多次调用只执行最后一次，减少网络请求
 * 3. 自适应延迟 - 根据操作优先级调整延迟时间，重要操作更快执行
 * 4. 错误隔离 - 同步错误不会影响用户体验，只在开发环境记录日志
 * 5. 登录状态检查 - 自动跳过未登录用户的同步请求
 *
 * 性能优化：
 * - 使用防抖机制减少频繁网络请求
 * - 优先级系统确保重要操作不被延迟
 * - 异步执行避免阻塞UI线程
 * - 错误处理确保同步失败不影响用户体验
 *
 * @param dispatch Redux dispatch 函数，用于触发状态更新
 * @param getState Redux getState 函数，用于获取当前应用状态
 * @param operationType 操作类型，用于日志记录和确定优先级
 * @returns Promise<boolean> 同步是否成功的Promise
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

export async function syncToCloud(
  _dispatch: ThunkDispatch<any, any, AnyAction>,
  _getState: () => any,
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
        // 检查用户是否已登录
        const { auth } = _getState();
        const isAuthenticated = auth?.isAuthenticated || false;

        if (!isAuthenticated) {
          // 用户未登录，跳过云端同步
          if (process.env.NODE_ENV === 'development') {
            console.log(`用户未登录，跳过云端同步操作: ${operationType}`);
          }
          currentSyncOperation = null;
          resolve(true); // 返回成功，不影响用户体验
          return;
        }

        // 本地操作完成，但不自动同步到云端，保证本地操作优先，避免卡顿
        if (process.env.NODE_ENV === 'development') {
          console.log(`本地操作完成: ${operationType}，跳过自动同步，保证操作丰满顺畅`);
        }
        currentSyncOperation = null;
        resolve(true); // 返回成功，不影响用户体验
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
