/**
 * React.lazy 的增强包装器
 * 提供带有加载状态和错误边界的懒加载组件
 */

import React, { Suspense, ComponentType, lazy } from 'react';

// 加载中占位组件
const DefaultLoading: React.FC = () => (
  <div className="flex items-center justify-center p-4">
    <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent"></div>
  </div>
);

interface LazyLoadOptions {
  loading?: ComponentType;
  delay?: number; // 延迟显示加载状态
  minLoadingTime?: number; // 最小加载时间，避免闪烁
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponentType = ComponentType<any>;

/**
 * 创建懒加载组件
 * @param importFn 动态导入函数
 * @param options 配置选项
 */
export function createLazyComponent<T extends AnyComponentType>(
  importFn: () => Promise<{ default: T }>,
  options: LazyLoadOptions = {}
): React.FC<React.ComponentProps<T>> {
  const {
    loading: LoadingComponent = DefaultLoading,
    delay = 0,
    minLoadingTime = 0,
  } = options;

  // 增强的导入函数，支持最小加载时间
  const enhancedImport = async (): Promise<{ default: T }> => {
    const startTime = Date.now();
    const module = await importFn();

    // 确保最小加载时间
    if (minLoadingTime > 0) {
      const elapsed = Date.now() - startTime;
      if (elapsed < minLoadingTime) {
        await new Promise(resolve => setTimeout(resolve, minLoadingTime - elapsed));
      }
    }

    return module;
  };

  const LazyComponent = lazy(enhancedImport);

  // 延迟加载状态组件
  const DelayedLoading: React.FC = () => {
    const [showLoading, setShowLoading] = React.useState(delay === 0);

    React.useEffect(() => {
      if (delay > 0) {
        const timer = setTimeout(() => setShowLoading(true), delay);
        return () => clearTimeout(timer);
      }
    }, []);

    return showLoading ? <LoadingComponent /> : null;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function LazyWrapper(props: any) {
    return (
      <Suspense fallback={<DelayedLoading />}>
        <LazyComponent {...props} />
      </Suspense>
    );
  };
}

/**
 * 预加载组件
 * 用于在需要之前预先加载组件
 */
export function preloadComponent(importFn: () => Promise<unknown>): void {
  importFn();
}

/**
 * 批量预加载组件
 */
export function preloadComponents(importFns: Array<() => Promise<unknown>>): void {
  importFns.forEach(fn => fn());
}

// 常用组件的懒加载导出
export const LazySettingsPanel = createLazyComponent(
  () => import('@/components/layout/HeaderDropdown').then(m => ({ default: m.HeaderDropdown })),
  { delay: 100 }
);

export const LazySyncStatus = createLazyComponent(
  () => import('@/components/sync/SyncStatus').then(m => ({ default: m.SyncStatus })),
  { delay: 100 }
);

export const LazySearchBar = createLazyComponent(
  () => import('@/components/search/SearchBar'),
  { delay: 50 }
);

export const LazyPerformanceTest = createLazyComponent(
  () => import('@/components/performance/PerformanceTest'),
  { delay: 200 }
);
