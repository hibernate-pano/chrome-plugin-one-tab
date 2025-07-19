/**
 * 共享Hooks导出
 */
export {
  useMemoryOptimization,
  useDebounce,
  useThrottle,
  useMemoryMonitor,
  useSmartCache
} from './useMemoryOptimization';
export { useLocalStorage } from './useLocalStorage';
export { useAsyncOperation } from './useAsyncOperation';
export { useVirtualizationPerformance, VirtualizationPerformanceMonitor } from './useVirtualizationPerformance';
export {
  useSmartRenderOptimization,
  useConditionalRender,
  useOptimizedList,
  useDebouncedRender,
  useWhyDidYouUpdate,
  useRenderAnalysis,
  useOptimizationSuggestions
} from './useRenderOptimization';
export { useLazyLoading, useLazyImage, useInfiniteScroll } from './useLazyLoading';
export { useDataPrefetch, useRoutePrefetch, PrefetchStrategy } from './useDataPrefetch';

// 导出类型
export type { VirtualizationMetrics, PerformanceMonitorConfig } from './useVirtualizationPerformance';
export type { LazyLoadingConfig, LazyLoadingState } from './useLazyLoading';
export type { PrefetchConfig, PrefetchState } from './useDataPrefetch';
