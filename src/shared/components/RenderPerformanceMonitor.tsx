import React, { useState, useEffect, useCallback, memo } from 'react';
import { renderStatsManager, generateRenderOptimizationReport } from '@/shared/utils/renderOptimizer';
import { createMemoComparison } from '@/shared/utils/performanceOptimizer';

/**
 * 渲染性能监控面板属性接口
 */
interface RenderPerformanceMonitorProps {
  show?: boolean;
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  autoRefresh?: boolean;
  refreshInterval?: number;
  onClose?: () => void;
}

/**
 * 渲染性能监控面板组件
 * 在开发环境中显示组件渲染性能统计和优化建议
 */
const RenderPerformanceMonitorComponent: React.FC<RenderPerformanceMonitorProps> = ({
  show = process.env.NODE_ENV === 'development',
  position = 'top-right',
  autoRefresh = true,
  refreshInterval = 5000,
  onClose
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [report, setReport] = useState(generateRenderOptimizationReport());
  const [selectedComponent, setSelectedComponent] = useState<string | null>(null);

  // 更新报告数据
  const updateReport = useCallback(() => {
    setReport(generateRenderOptimizationReport());
  }, []);

  // 自动刷新
  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(updateReport, refreshInterval);
    return () => clearInterval(interval);
  }, [autoRefresh, refreshInterval, updateReport]);

  // 重置统计数据
  const handleReset = useCallback(() => {
    renderStatsManager.reset();
    updateReport();
  }, [updateReport]);

  // 获取性能等级颜色
  const getPerformanceColor = (averageTime: number) => {
    if (averageTime < 8) return 'text-green-600';
    if (averageTime < 16) return 'text-yellow-600';
    if (averageTime < 33) return 'text-orange-600';
    return 'text-red-600';
  };

  // 获取性能等级
  const getPerformanceGrade = (averageTime: number) => {
    if (averageTime < 8) return 'A';
    if (averageTime < 16) return 'B';
    if (averageTime < 33) return 'C';
    return 'D';
  };

  if (!show) return null;

  const positionClasses = {
    'top-left': 'top-4 left-4',
    'top-right': 'top-4 right-4',
    'bottom-left': 'bottom-4 left-4',
    'bottom-right': 'bottom-4 right-4'
  };

  return (
    <div className={`fixed ${positionClasses[position]} z-50 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg max-w-md`}>
      {/* 标题栏 */}
      <div className="flex items-center justify-between p-3 border-b border-gray-200 dark:border-gray-600">
        <div className="flex items-center space-x-2">
          <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse"></div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
            渲染性能监控
          </h3>
        </div>
        <div className="flex items-center space-x-1">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-gray-500 dark:text-gray-400"
            title={isExpanded ? '收起' : '展开'}
          >
            <svg className={`w-4 h-4 transform transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-gray-500 dark:text-gray-400"
              title="关闭"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* 概览信息 */}
      <div className="p-3 text-xs">
        <div className="grid grid-cols-2 gap-2 mb-3">
          <div className="bg-gray-50 dark:bg-gray-700 p-2 rounded">
            <div className="text-gray-600 dark:text-gray-400">组件总数</div>
            <div className="font-bold text-gray-900 dark:text-white">{report.summary.totalComponents}</div>
          </div>
          <div className="bg-gray-50 dark:bg-gray-700 p-2 rounded">
            <div className="text-gray-600 dark:text-gray-400">慢组件</div>
            <div className={`font-bold ${report.summary.slowComponents > 0 ? 'text-red-600' : 'text-green-600'}`}>
              {report.summary.slowComponents}
            </div>
          </div>
          <div className="bg-gray-50 dark:bg-gray-700 p-2 rounded">
            <div className="text-gray-600 dark:text-gray-400">平均渲染</div>
            <div className={`font-bold ${getPerformanceColor(report.summary.averageRenderTime)}`}>
              {report.summary.averageRenderTime.toFixed(1)}ms
            </div>
          </div>
          <div className="bg-gray-50 dark:bg-gray-700 p-2 rounded">
            <div className="text-gray-600 dark:text-gray-400">总渲染次数</div>
            <div className="font-bold text-gray-900 dark:text-white">{report.summary.totalRenders}</div>
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex space-x-2 mb-3">
          <button
            onClick={updateReport}
            className="flex-1 px-2 py-1 bg-blue-500 text-white rounded text-xs hover:bg-blue-600 transition-colors"
          >
            刷新
          </button>
          <button
            onClick={handleReset}
            className="flex-1 px-2 py-1 bg-gray-500 text-white rounded text-xs hover:bg-gray-600 transition-colors"
          >
            重置
          </button>
        </div>
      </div>

      {/* 详细信息 */}
      {isExpanded && (
        <div className="border-t border-gray-200 dark:border-gray-600">
          {/* 优化建议 */}
          {report.recommendations.length > 0 && (
            <div className="p-3 border-b border-gray-200 dark:border-gray-600">
              <h4 className="text-xs font-semibold text-gray-900 dark:text-white mb-2">优化建议</h4>
              <ul className="space-y-1">
                {report.recommendations.map((recommendation, index) => (
                  <li key={index} className="text-xs text-yellow-700 dark:text-yellow-300 flex items-start">
                    <span className="mr-1">⚠️</span>
                    <span>{recommendation}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 慢组件列表 */}
          <div className="p-3">
            <h4 className="text-xs font-semibold text-gray-900 dark:text-white mb-2">
              性能较差的组件 (Top 5)
            </h4>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {report.topSlowComponents.slice(0, 5).map((component, index) => (
                <div
                  key={component.componentName}
                  className={`p-2 rounded cursor-pointer transition-colors ${
                    selectedComponent === component.componentName
                      ? 'bg-blue-100 dark:bg-blue-900'
                      : 'bg-gray-50 dark:bg-gray-700 hover:bg-gray-100 dark:hover:bg-gray-600'
                  }`}
                  onClick={() => setSelectedComponent(
                    selectedComponent === component.componentName ? null : component.componentName
                  )}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <span className={`text-xs font-bold ${getPerformanceColor(component.averageRenderTime)}`}>
                        {getPerformanceGrade(component.averageRenderTime)}
                      </span>
                      <span className="text-xs font-medium text-gray-900 dark:text-white truncate">
                        {component.componentName}
                      </span>
                    </div>
                    <span className={`text-xs ${getPerformanceColor(component.averageRenderTime)}`}>
                      {component.averageRenderTime.toFixed(1)}ms
                    </span>
                  </div>
                  
                  {selectedComponent === component.componentName && (
                    <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-600">
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div>
                          <span className="text-gray-600 dark:text-gray-400">渲染次数:</span>
                          <span className="ml-1 font-medium">{component.renderCount}</span>
                        </div>
                        <div>
                          <span className="text-gray-600 dark:text-gray-400">最大时间:</span>
                          <span className="ml-1 font-medium">{component.maxRenderTime.toFixed(1)}ms</span>
                        </div>
                        <div>
                          <span className="text-gray-600 dark:text-gray-400">最小时间:</span>
                          <span className="ml-1 font-medium">{component.minRenderTime.toFixed(1)}ms</span>
                        </div>
                        <div>
                          <span className="text-gray-600 dark:text-gray-400">慢渲染:</span>
                          <span className="ml-1 font-medium text-red-600">{component.slowRenders}</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              
              {report.topSlowComponents.length === 0 && (
                <div className="text-center py-4">
                  <div className="text-green-600 text-xs">🎉 所有组件性能良好！</div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// 使用memo优化组件性能
export const RenderPerformanceMonitor = memo(
  RenderPerformanceMonitorComponent,
  createMemoComparison([
    'show',
    'position',
    'autoRefresh',
    'refreshInterval',
    'onClose'
  ])
);

/**
 * 简化版性能指示器组件
 * 只显示关键性能指标
 */
interface PerformanceIndicatorProps {
  show?: boolean;
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
}

const PerformanceIndicatorComponent: React.FC<PerformanceIndicatorProps> = ({
  show = process.env.NODE_ENV === 'development',
  position = 'bottom-right'
}) => {
  const [report, setReport] = useState(generateRenderOptimizationReport());

  useEffect(() => {
    const interval = setInterval(() => {
      setReport(generateRenderOptimizationReport());
    }, 3000);

    return () => clearInterval(interval);
  }, []);

  if (!show) return null;

  const positionClasses = {
    'top-left': 'top-4 left-4',
    'top-right': 'top-4 right-4',
    'bottom-left': 'bottom-4 left-4',
    'bottom-right': 'bottom-4 right-4'
  };

  const getIndicatorColor = () => {
    if (report.summary.averageRenderTime < 8) return 'bg-green-500';
    if (report.summary.averageRenderTime < 16) return 'bg-yellow-500';
    if (report.summary.averageRenderTime < 33) return 'bg-orange-500';
    return 'bg-red-500';
  };

  return (
    <div className={`fixed ${positionClasses[position]} z-50`}>
      <div className="bg-black bg-opacity-75 text-white px-2 py-1 rounded text-xs font-mono">
        <div className="flex items-center space-x-2">
          <div className={`w-2 h-2 rounded-full ${getIndicatorColor()}`}></div>
          <span>{report.summary.averageRenderTime.toFixed(1)}ms</span>
          {report.summary.slowComponents > 0 && (
            <span className="text-red-400">({report.summary.slowComponents})</span>
          )}
        </div>
      </div>
    </div>
  );
};

export const PerformanceIndicator = memo(
  PerformanceIndicatorComponent,
  createMemoComparison(['show', 'position'])
);
