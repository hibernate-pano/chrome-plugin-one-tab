/**
 * 错误报告中间件
 * 自动捕获和报告Redux action中的错误
 */
import { Middleware, AnyAction } from '@reduxjs/toolkit';
import { logger } from '@/shared/utils/logger';
import { errorHandler } from '@/shared/utils/errorHandler';

export const errorReportingMiddleware: Middleware = () => (next) => (action: unknown) => {
  const typedAction = action as AnyAction;
  try {
    // 记录action执行
    if (typedAction.type && !typedAction.type.includes('@@')) {
      logger.debug('Redux Action执行', { 
        type: typedAction.type,
        payload: typedAction.payload ? 'present' : 'none',
      });
    }

    const result = next(action);

    // 检查rejected actions
    if (typedAction.type && typedAction.type.endsWith('/rejected')) {
      const error = typedAction.payload || typedAction.error;
      const actionType = typedAction.type.replace('/rejected', '');
      
      const friendlyError = errorHandler.handleAsyncError(
        error instanceof Error ? error : new Error(error?.message || 'Unknown error'),
        {
          component: 'Redux',
          action: actionType,
          extra: {
            actionType: typedAction.type,
            meta: typedAction.meta,
          },
        }
      );

      logger.error('Redux Action被拒绝', error, {
        actionType,
        friendlyError,
      });
    }

    return result;
  } catch (error) {
    // 捕获中间件本身的错误
    logger.error('Redux中间件错误', error, {
      actionType: typedAction.type,
      action,
    });

    // 继续传递action，不要中断Redux流程
    return next(action);
  }
};