import React, { useState, useEffect, useCallback } from 'react';
import { perfMonitor } from '@/app/store/middleware/performance';
import { logger } from '@/shared/utils/logger';

interface MemoryStats {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
  timestamp: number;
}

/**
 * 内存监控面板
 * 仅在开发环境下显示，用于监控应用的内存使用情况
 */
export const MemoryMonitorPanel: React.FC = () => {
  const [isVisible, setIsVisible] = useState(false);
  const [memoryHistory, setMemoryHistory] = useState<MemoryStats[]>([]);
  const [performanceStats, setPerformanceStats] = useState<any>(null);

  // 获取内存信息
  const getMemoryInfo = useCallback((): MemoryStats | null => {
    if ('memory' in performance) {
      const memory = (performance as any).memory;
      return {
        usedJSHeapSize: memory.usedJSHeapSize,
        totalJSHeapSize: memory.totalJSHeapSize,
        jsHeapSizeLimit: memory.jsHeapSizeLimit,
        timestamp: Date.now(),
      };
    }
    return null;
  }, []);

  // 更新内存统计
  const updateStats = useCallback(() => {
    const memoryInfo = getMemoryInfo();
    if (memoryInfo) {
      setMemoryHistory(prev => {
        const newHistory = [...prev, memoryInfo];
        // 只保留最近50个记录
        return newHistory.slice(-50);
      });
    }

    // 获取性能统计
    const perfStats = perfMonitor.getPerformanceStats();
    setPerformanceStats(perfStats);
  }, [getMemoryInfo]);

  // 定期更新统计信息
  useEffect(() => {
    if (!isVisible) return;

    updateStats();
    const interval = setInterval(updateStats, 2000); // 每2秒更新一次

    return () => clearInterval(interval);
  }, [isVisible, updateStats]);

  // 格式化字节数
  const formatBytes = (bytes: number): string => {
    const mb = bytes / 1024 / 1024;
    return `${mb.toFixed(2)} MB`;
  };

  // 计算内存使用率
  const getMemoryUsagePercentage = (used: number, total: number): number => {
    return (used / total) * 100;
  };

  // 获取内存状态颜色
  const getMemoryStatusColor = (percentage: number): string => {
    if (percentage < 50) return 'text-green-600';
    if (percentage < 80) return 'text-yellow-600';
    return 'text-red-600';
  };

  // 清理内存历史
  const clearHistory = () => {
    setMemoryHistory([]);
    logger.debug('内存监控历史已清理');
  };

  // 触发垃圾回收（如果可用）
  const triggerGC = () => {
    if ('gc' in window && typeof (window as any).gc === 'function') {
      (window as any).gc();
      logger.debug('手动触发垃圾回收');
      setTimeout(updateStats, 100); // 延迟更新统计
    } else {
      logger.warn('垃圾回收功能不可用');
    }
  };

  if (process.env.NODE_ENV !== 'development') {
    return null;
  }

  const latestMemory = memoryHistory[memoryHistory.length - 1];
  const usagePercentage = latestMemory 
    ? getMemoryUsagePercentage(latestMemory.usedJSHeapSize, latestMemory.totalJSHeapSize)
    : 0;

  return (
    <>
      {/* 切换按钮 */}
      <button
        onClick={() => setIsVisible(!isVisible)}
        className="fixed bottom-4 right-4 z-50 bg-blue-600 text-white p-2 rounded-full shadow-lg hover:bg-blue-700 transition-colors"
        title="内存监控"
      >
        📊
      </button>

      {/* 监控面板 */}
      {isVisible && (
        <div className="fixed bottom-16 right-4 z-50 bg-white border border-gray-300 rounded-lg shadow-xl p-4 w-80 max-h-96 overflow-y-auto">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-gray-800">内存监控</h3>
            <button
              onClick={() => setIsVisible(false)}
              className="text-gray-500 hover:text-gray-700"
            >
              ✕
            </button>
          </div>

          {/* 当前内存状态 */}
          {latestMemory && (
            <div className="mb-4 p-3 bg-gray-50 rounded">
              <h4 className="font-medium text-sm mb-2">当前内存使用</h4>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between">
                  <span>已使用:</span>
                  <span className={getMemoryStatusColor(usagePercentage)}>
                    {formatBytes(latestMemory.usedJSHeapSize)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>总分配:</span>
                  <span>{formatBytes(latestMemory.totalJSHeapSize)}</span>
                </div>
                <div className="flex justify-between">
                  <span>限制:</span>
                  <span>{formatBytes(latestMemory.jsHeapSizeLimit)}</span>
                </div>
                <div className="flex justify-between">
                  <span>使用率:</span>
                  <span className={getMemoryStatusColor(usagePercentage)}>
                    {usagePercentage.toFixed(1)}%
                  </span>
                </div>
              </div>

              {/* 内存使用进度条 */}
              <div className="mt-2">
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full transition-all duration-300 ${
                      usagePercentage < 50 ? 'bg-green-500' :
                      usagePercentage < 80 ? 'bg-yellow-500' : 'bg-red-500'
                    }`}
                    style={{ width: `${Math.min(usagePercentage, 100)}%` }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* 性能统计 */}
          {performanceStats && (
            <div className="mb-4 p-3 bg-gray-50 rounded">
              <h4 className="font-medium text-sm mb-2">Redux性能</h4>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between">
                  <span>总Actions:</span>
                  <span>{performanceStats.totalActions}</span>
                </div>
                <div className="flex justify-between">
                  <span>平均耗时:</span>
                  <span>{performanceStats.avgDuration}ms</span>
                </div>
                <div className="flex justify-between">
                  <span>最大耗时:</span>
                  <span className={performanceStats.maxDuration > 100 ? 'text-red-600' : 'text-green-600'}>
                    {performanceStats.maxDuration}ms
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>慢Actions:</span>
                  <span className={performanceStats.slowActions > 0 ? 'text-red-600' : 'text-green-600'}>
                    {performanceStats.slowActions}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* 内存历史图表（简化版） */}
          {memoryHistory.length > 1 && (
            <div className="mb-4">
              <h4 className="font-medium text-sm mb-2">内存使用趋势</h4>
              <div className="h-16 bg-gray-100 rounded relative overflow-hidden">
                <svg className="w-full h-full">
                  <polyline
                    fill="none"
                    stroke="#3b82f6"
                    strokeWidth="2"
                    points={memoryHistory.map((stat, index) => {
                      const x = (index / (memoryHistory.length - 1)) * 100;
                      const y = 100 - (stat.usedJSHeapSize / stat.jsHeapSizeLimit) * 100;
                      return `${x},${y}`;
                    }).join(' ')}
                    vectorEffect="non-scaling-stroke"
                    style={{ transform: 'scale(1, 0.8) translateY(10%)' }}
                  />
                </svg>
              </div>
            </div>
          )}

          {/* 操作按钮 */}
          <div className="flex space-x-2">
            <button
              onClick={clearHistory}
              className="flex-1 px-2 py-1 text-xs bg-gray-200 text-gray-700 rounded hover:bg-gray-300 transition-colors"
            >
              清理历史
            </button>
            <button
              onClick={triggerGC}
              className="flex-1 px-2 py-1 text-xs bg-blue-200 text-blue-700 rounded hover:bg-blue-300 transition-colors"
            >
              触发GC
            </button>
          </div>

          <div className="mt-2 text-xs text-gray-500 text-center">
            每2秒更新 • 仅开发环境
          </div>
        </div>
      )}
    </>
  );
};
