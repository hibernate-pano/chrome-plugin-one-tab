/**
 * 拖拽性能测试组件
 * 用于开发环境下监控和测试拖拽性能
 */

import React, { useEffect, useState } from 'react';
import { dragPerformanceMonitor } from '@/shared/utils/dragPerformance';

interface PerformanceStats {
  totalTime: number;
  frameCount: number;
  avgFps: number;
}

export const DragPerformanceTest: React.FC = () => {
  const [stats, setStats] = useState<PerformanceStats | null>(null);
  const [isMonitoring, setIsMonitoring] = useState(false);

  useEffect(() => {
    // 只在开发环境显示
    if (process.env.NODE_ENV !== 'development') {
      return;
    }

    const handleDragStart = () => {
      dragPerformanceMonitor.startMonitoring();
      setIsMonitoring(true);
      setStats(null);
    };

    const handleDragEnd = () => {
      const result = dragPerformanceMonitor.stopMonitoring();
      setIsMonitoring(false);
      if (result) {
        setStats(result);
      }
    };

    // 监听拖拽事件
    document.addEventListener('dragstart', handleDragStart);
    document.addEventListener('dragend', handleDragEnd);

    return () => {
      document.removeEventListener('dragstart', handleDragStart);
      document.removeEventListener('dragend', handleDragEnd);
    };
  }, []);

  // 只在开发环境渲染
  if (process.env.NODE_ENV !== 'development') {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 bg-black bg-opacity-80 text-white p-3 rounded-lg text-xs font-mono z-50">
      <div className="mb-2 font-bold">拖拽性能监控</div>
      
      {isMonitoring && (
        <div className="text-green-400">
          🔄 监控中...
        </div>
      )}
      
      {stats && (
        <div className="space-y-1">
          <div>总时间: {stats.totalTime.toFixed(2)}ms</div>
          <div>帧数: {stats.frameCount}</div>
          <div className={`平均FPS: ${stats.avgFps.toFixed(1)} ${stats.avgFps < 50 ? 'text-red-400' : stats.avgFps < 55 ? 'text-yellow-400' : 'text-green-400'}`}>
            平均FPS: {stats.avgFps.toFixed(1)}
          </div>
          <div className="text-xs text-gray-400 mt-2">
            {stats.avgFps >= 55 ? '✅ 性能良好' : 
             stats.avgFps >= 50 ? '⚠️ 性能一般' : 
             '❌ 性能较差'}
          </div>
        </div>
      )}
      
      {!isMonitoring && !stats && (
        <div className="text-gray-400">
          开始拖拽以监控性能
        </div>
      )}
    </div>
  );
};
