/**
 * 应用根Store配置
 * 整合所有功能模块的Redux store
 */
import { configureStore } from '@reduxjs/toolkit';
import { logger } from '@/shared/utils/logger';

// 功能模块reducers
import { tabsReducer, tabGroupsReducer, dragOperationsReducer } from '@/features/tabs/store';
import { syncReducer } from '@/features/sync';
import { authReducer } from '@/features/auth';
import { settingsReducer } from '@/features/settings';
import { batchOperationsReducer } from '@/features/batch-operations';
import { advancedSearchReducer } from '@/features/advanced-search';
import onboardingReducer from '@/features/onboarding/store/onboardingSlice';

// 中间件
import { errorReportingMiddleware } from './middleware/errorReporting';
import { performanceMiddleware } from './middleware/performance';

// 创建根reducer
const rootReducer = {
  // 功能模块
  tabs: tabsReducer,
  tabGroups: tabGroupsReducer,
  dragOperations: dragOperationsReducer,
  sync: syncReducer,
  auth: authReducer,
  settings: settingsReducer,
  batchOperations: batchOperationsReducer,
  advancedSearch: advancedSearchReducer,
  onboarding: onboardingReducer,
};

// 配置store
export const store = configureStore({
  reducer: rootReducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        // 忽略这些action类型的序列化检查
        ignoredActions: [
          'persist/PERSIST',
          'persist/REHYDRATE',
          'persist/PAUSE',
          'persist/PURGE',
          'persist/REGISTER',
        ],
        // 忽略这些路径的序列化检查
        ignoredPaths: [
          'auth.session.expiresAt',
          'tabs.lastSyncTime',
          'sync.lastSyncTime',
        ],
      },
      thunk: {
        extraArgument: {
          // 这里可以注入额外的依赖
          logger,
        },
      },
    })
    .concat([
      errorReportingMiddleware,
      performanceMiddleware,
    ]),
  devTools: process.env.NODE_ENV === 'development',
  preloadedState: undefined,
});

// 导出类型
export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

// 热重载支持
if (process.env.NODE_ENV === 'development' && (module as any).hot) {
  (module as any).hot.accept('./store', () => {
    logger.debug('重新加载Redux store');
    // 这里可以添加热重载逻辑
  });
}

// Store初始化日志
logger.debug('Redux store已配置', {
  reducers: Object.keys(rootReducer),
  middleware: ['errorReporting', 'performance', 'thunk', 'serializableCheck'],
  devTools: process.env.NODE_ENV === 'development',
});

export default store;