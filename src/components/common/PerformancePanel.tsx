import React, { useState, useEffect } from 'react';
import { performanceMonitor, usePerformanceMonitor } from '@/utils/performanceMonitor';

/**
 * 性能监控面板组件
 * 显示应用的性能指标和优化建议
 */

interface PerformancePanelProps {
  isVisible?: boolean;
  onClose?: () => void;
  className?: string;
}

export const PerformancePanel: React.FC<PerformancePanelProps> = ({
  isVisible = false,
  onClose,
  className = '',
}) => {
  const { metrics, getReport } = usePerformanceMonitor();
  const [report, setReport] = useState<any>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  useEffect(() => {
    if (isVisible && !report) {
      setReport(getReport());
    }
  }, [isVisible, report, getReport]);

  if (!isVisible) return null;

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatTime = (ms: number): string => {
    return ms < 1 ? `${(ms * 1000).toFixed(1)}μs` : `${ms.toFixed(1)}ms`;
  };

  const getMemoryUsageColor = (usage: number, limit: number): string => {
    const ratio = usage / limit;
    if (ratio > 0.9) return 'text-red-600 dark:text-red-400';
    if (ratio > 0.7) return 'text-yellow-600 dark:text-yellow-400';
    return 'text-green-600 dark:text-green-400';
  };

  const getFpsColor = (fps: number): string => {
    if (fps < 30) return 'text-red-600 dark:text-red-400';
    if (fps < 50) return 'text-yellow-600 dark:text-yellow-400';
    return 'text-green-600 dark:text-green-400';
  };

  return (
    <div
      className={`fixed top-4 right-4 z-50 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 ${className}`}
    >
      {/* 标题栏 */}
      <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <svg
            className="w-5 h-5 text-blue-600 dark:text-blue-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
            />
          </svg>
          <h3 className="font-semibold text-gray-900 dark:text-white">性能监控</h3>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            title={isExpanded ? '收起' : '展开'}
          >
            <svg
              className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              title="关闭"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* 主要指标 */}
      <div className="p-4 space-y-4">
        {metrics && (
          <>
            {/* 内存使用 */}
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600 dark:text-gray-400">内存使用</span>
              <span
                className={`text-sm font-mono ${getMemoryUsageColor(metrics.memory.used, metrics.memory.limit)}`}
              >
                {formatBytes(metrics.memory.used)} / {formatBytes(metrics.memory.limit)}
              </span>
            </div>

            {/* 渲染性能 */}
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600 dark:text-gray-400">渲染FPS</span>
              <span className={`text-sm font-mono ${getFpsColor(metrics.rendering.fps)}`}>
                {metrics.rendering.fps.toFixed(1)} FPS
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600 dark:text-gray-400">平均渲染时间</span>
              <span className="text-sm font-mono text-gray-900 dark:text-white">
                {formatTime(metrics.rendering.averageRenderTime)}
              </span>
            </div>

            {/* 长任务数量 */}
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600 dark:text-gray-400">长任务 (&gt;50ms)</span>
              <span className="text-sm font-mono text-gray-900 dark:text-white">
                {metrics.rendering.longTasks}
              </span>
            </div>

            {/* 存储性能 */}
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600 dark:text-gray-400">存储大小</span>
              <span className="text-sm font-mono text-gray-900 dark:text-white">
                {formatBytes(metrics.storage.size)}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600 dark:text-gray-400">存储操作</span>
              <span className="text-sm font-mono text-gray-900 dark:text-white">
                {metrics.storage.operations} 次
              </span>
            </div>
          </>
        )}
      </div>

      {/* 展开的详细信息 */}
      {isExpanded && report && (
        <div className="border-t border-gray-200 dark:border-gray-700 p-4 space-y-4">
          {/* 优化建议 */}
          {report.recommendations.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-gray-900 dark:text-white mb-2">优化建议</h4>
              <ul className="space-y-1">
                {report.recommendations.map((rec: string, index: number) => (
                  <li
                    key={index}
                    className="text-xs text-gray-600 dark:text-gray-400 flex items-start gap-2"
                  >
                    <span className="text-blue-500 dark:text-blue-400 mt-0.5">•</span>
                    <span>{rec}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 性能条目统计 */}
          <div>
            <h4 className="text-sm font-semibold text-gray-900 dark:text-white mb-2">最近活动</h4>
            <div className="text-xs space-y-1">
              {['render', 'storage', 'memory', 'sync'].map(type => {
                const count = report.entries.filter((e: any) => e.type === type).length;
                return (
                  <div key={type} className="flex justify-between">
                    <span className="text-gray-600 dark:text-gray-400 capitalize">{type}:</span>
                    <span className="font-mono text-gray-900 dark:text-white">{count}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 操作按钮 */}
          <div className="flex gap-2 pt-2">
            <button
              onClick={() => {
                performanceMonitor.cleanup();
                setReport(getReport());
              }}
              className="flex-1 px-3 py-1 text-xs bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded transition-colors"
            >
              清理数据
            </button>
            <button
              onClick={() => {
                const data = JSON.stringify(report, null, 2);
                const blob = new Blob([data], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `performance-report-${Date.now()}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
              }}
              className="flex-1 px-3 py-1 text-xs bg-blue-100 dark:bg-blue-900 hover:bg-blue-200 dark:hover:bg-blue-800 text-blue-700 dark:text-blue-300 rounded transition-colors"
            >
              导出报告
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * 简化的性能指示器组件
 * 显示基本的性能状态
 */
export const PerformanceIndicator: React.FC<{
  className?: string;
  showDetails?: boolean;
}> = ({ className = '', showDetails = false }) => {
  const { metrics } = usePerformanceMonitor();
  const [isPanelVisible, setIsPanelVisible] = useState(false);

  if (!metrics) return null;

  const memoryRatio = metrics.memory.used / metrics.memory.limit;
  const memoryColor =
    memoryRatio > 0.8 ? 'text-red-500' : memoryRatio > 0.6 ? 'text-yellow-500' : 'text-green-500';
  const fpsColor =
    metrics.rendering.fps < 30
      ? 'text-red-500'
      : metrics.rendering.fps < 50
        ? 'text-yellow-500'
        : 'text-green-500';

  return (
    <>
      <button
        onClick={() => setIsPanelVisible(true)}
        className={`fixed bottom-4 right-4 z-40 p-2 bg-white dark:bg-gray-800 rounded-full shadow-lg border border-gray-200 dark:border-gray-700 hover:shadow-xl transition-shadow ${className}`}
        title="性能监控"
      >
        <div className="flex items-center gap-1">
          <svg
            className="w-4 h-4 text-gray-600 dark:text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
            />
          </svg>
          {showDetails && (
            <div className="flex items-center gap-1 text-xs">
              <span className={fpsColor}>{metrics.rendering.fps.toFixed(0)}</span>
              <span className={memoryColor}>{(memoryRatio * 100).toFixed(0)}%</span>
            </div>
          )}
        </div>
      </button>

      <PerformancePanel isVisible={isPanelVisible} onClose={() => setIsPanelVisible(false)} />
    </>
  );
};
