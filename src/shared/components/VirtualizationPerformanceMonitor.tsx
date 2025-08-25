/**
 * 虚拟化性能监控组件
 * 用于在开发环境中显示性能指标
 */

import React from 'react';
import { useVirtualizationPerformance } from '../hooks/useVirtualizationPerformance';

interface VirtualizationPerformanceMonitorProps {
  show?: boolean;
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
}

export const VirtualizationPerformanceMonitor: React.FC<VirtualizationPerformanceMonitorProps> = ({ 
  show = process.env.NODE_ENV === 'development',
  position = 'top-right'
}) => {
  const { metrics, getPerformanceGrade, isEnabled } = useVirtualizationPerformance();
  
  if (!show || !isEnabled) return null;
  
  const positionClasses = {
    'top-left': 'top-4 left-4',
    'top-right': 'top-4 right-4',
    'bottom-left': 'bottom-4 left-4',
    'bottom-right': 'bottom-4 right-4'
  };
  
  const grade = getPerformanceGrade();
  const gradeColors = {
    'A': 'text-green-600',
    'B': 'text-blue-600',
    'C': 'text-yellow-600',
    'D': 'text-orange-600',
    'F': 'text-red-600'
  };
  
  return (
    <div className={`fixed ${positionClasses[position]} z-50 bg-black bg-opacity-80 text-white p-3 rounded-lg text-xs font-mono`}>
      <div className="mb-2 font-bold">虚拟化性能监控</div>
      <div className={`mb-1 font-bold ${gradeColors[grade]}`}>等级: {grade}</div>
      <div>渲染时间: {metrics.renderTime.toFixed(1)}ms</div>
      <div>帧率: {metrics.frameRate.toFixed(1)}fps</div>
      <div>渲染项目: {metrics.renderedItemCount}/{metrics.totalItemCount}</div>
      <div>渲染比例: {metrics.renderRatio.toFixed(1)}%</div>
      <div>滚动事件: {metrics.scrollEvents}/s</div>
      <div>滚动流畅度: {metrics.scrollSmoothnessScore.toFixed(1)}</div>
      <div>缓存命中率: {metrics.cacheHitRate.toFixed(1)}%</div>
    </div>
  );
};
