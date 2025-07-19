import { useEffect, useRef, useCallback, useState } from 'react';
import { logger } from '@/shared/utils/logger';

/**
 * 虚拟化性能指标接口
 */
export interface VirtualizationMetrics {
  // 渲染性能
  renderTime: number; // 渲染时间 (ms)
  frameRate: number; // 帧率 (fps)
  
  // 内存使用
  renderedItemCount: number; // 当前渲染的项目数量
  totalItemCount: number; // 总项目数量
  renderRatio: number; // 渲染比例 (%)
  
  // 滚动性能
  scrollEvents: number; // 滚动事件数量
  scrollSmoothnessScore: number; // 滚动流畅度评分 (0-100)
  
  // 缓存效率
  cacheHitRate: number; // 缓存命中率 (%)
  cacheSize: number; // 缓存大小
}

/**
 * 性能监控配置接口
 */
export interface PerformanceMonitorConfig {
  enabled: boolean;
  sampleInterval: number; // 采样间隔 (ms)
  reportInterval: number; // 报告间隔 (ms)
  maxSamples: number; // 最大样本数量
}

/**
 * 默认性能监控配置
 */
const DEFAULT_CONFIG: PerformanceMonitorConfig = {
  enabled: process.env.NODE_ENV === 'development',
  sampleInterval: 100,
  reportInterval: 5000,
  maxSamples: 100
};

/**
 * 虚拟化性能监控Hook
 * 监控虚拟化列表的性能指标，帮助优化渲染性能
 */
export const useVirtualizationPerformance = (
  config: Partial<PerformanceMonitorConfig> = {}
) => {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  
  const [metrics, setMetrics] = useState<VirtualizationMetrics>({
    renderTime: 0,
    frameRate: 60,
    renderedItemCount: 0,
    totalItemCount: 0,
    renderRatio: 0,
    scrollEvents: 0,
    scrollSmoothnessScore: 100,
    cacheHitRate: 100,
    cacheSize: 0
  });

  // 性能数据收集
  const renderTimes = useRef<number[]>([]);
  const frameTimes = useRef<number[]>([]);
  const scrollEventTimes = useRef<number[]>([]);
  const lastFrameTime = useRef<number>(performance.now());
  const cacheStats = useRef({ hits: 0, misses: 0 });

  // 定时器引用
  const sampleTimer = useRef<NodeJS.Timeout>();
  const reportTimer = useRef<NodeJS.Timeout>();

  /**
   * 记录渲染开始时间
   */
  const startRenderMeasurement = useCallback(() => {
    if (!finalConfig.enabled) return () => {};
    
    const startTime = performance.now();
    
    return () => {
      const endTime = performance.now();
      const renderTime = endTime - startTime;
      
      renderTimes.current.push(renderTime);
      if (renderTimes.current.length > finalConfig.maxSamples) {
        renderTimes.current.shift();
      }
    };
  }, [finalConfig.enabled, finalConfig.maxSamples]);

  /**
   * 记录帧率
   */
  const measureFrameRate = useCallback(() => {
    if (!finalConfig.enabled) return;
    
    const now = performance.now();
    const deltaTime = now - lastFrameTime.current;
    
    if (deltaTime > 0) {
      const fps = 1000 / deltaTime;
      frameTimes.current.push(fps);
      
      if (frameTimes.current.length > finalConfig.maxSamples) {
        frameTimes.current.shift();
      }
    }
    
    lastFrameTime.current = now;
  }, [finalConfig.enabled, finalConfig.maxSamples]);

  /**
   * 记录滚动事件
   */
  const recordScrollEvent = useCallback(() => {
    if (!finalConfig.enabled) return;
    
    const now = performance.now();
    scrollEventTimes.current.push(now);
    
    // 只保留最近1秒的滚动事件
    const oneSecondAgo = now - 1000;
    scrollEventTimes.current = scrollEventTimes.current.filter(time => time > oneSecondAgo);
  }, [finalConfig.enabled]);

  /**
   * 更新渲染项目统计
   */
  const updateRenderStats = useCallback((renderedCount: number, totalCount: number) => {
    if (!finalConfig.enabled) return;
    
    setMetrics(prev => ({
      ...prev,
      renderedItemCount: renderedCount,
      totalItemCount: totalCount,
      renderRatio: totalCount > 0 ? (renderedCount / totalCount) * 100 : 0
    }));
  }, [finalConfig.enabled]);

  /**
   * 记录缓存命中
   */
  const recordCacheHit = useCallback(() => {
    if (!finalConfig.enabled) return;
    cacheStats.current.hits++;
  }, [finalConfig.enabled]);

  /**
   * 记录缓存未命中
   */
  const recordCacheMiss = useCallback(() => {
    if (!finalConfig.enabled) return;
    cacheStats.current.misses++;
  }, [finalConfig.enabled]);

  /**
   * 计算滚动流畅度评分
   */
  const calculateScrollSmoothness = useCallback(() => {
    if (frameTimes.current.length < 10) return 100;
    
    // 计算帧率的标准差，标准差越小说明越流畅
    const avgFps = frameTimes.current.reduce((sum, fps) => sum + fps, 0) / frameTimes.current.length;
    const variance = frameTimes.current.reduce((sum, fps) => sum + Math.pow(fps - avgFps, 2), 0) / frameTimes.current.length;
    const stdDev = Math.sqrt(variance);
    
    // 将标准差转换为0-100的评分，标准差越小评分越高
    const maxStdDev = 20; // 假设最大标准差为20
    const score = Math.max(0, Math.min(100, 100 - (stdDev / maxStdDev) * 100));
    
    return score;
  }, []);

  /**
   * 更新性能指标
   */
  const updateMetrics = useCallback(() => {
    if (!finalConfig.enabled) return;
    
    // 计算平均渲染时间
    const avgRenderTime = renderTimes.current.length > 0
      ? renderTimes.current.reduce((sum, time) => sum + time, 0) / renderTimes.current.length
      : 0;
    
    // 计算平均帧率
    const avgFrameRate = frameTimes.current.length > 0
      ? frameTimes.current.reduce((sum, fps) => sum + fps, 0) / frameTimes.current.length
      : 60;
    
    // 计算缓存命中率
    const totalCacheAccess = cacheStats.current.hits + cacheStats.current.misses;
    const cacheHitRate = totalCacheAccess > 0
      ? (cacheStats.current.hits / totalCacheAccess) * 100
      : 100;
    
    // 计算滚动流畅度
    const scrollSmoothness = calculateScrollSmoothness();
    
    setMetrics(prev => ({
      ...prev,
      renderTime: avgRenderTime,
      frameRate: avgFrameRate,
      scrollEvents: scrollEventTimes.current.length,
      scrollSmoothnessScore: scrollSmoothness,
      cacheHitRate,
      cacheSize: totalCacheAccess
    }));
  }, [finalConfig.enabled, calculateScrollSmoothness]);

  /**
   * 生成性能报告
   */
  const generateReport = useCallback(() => {
    if (!finalConfig.enabled) return;
    
    const report = {
      timestamp: new Date().toISOString(),
      metrics: { ...metrics },
      recommendations: []
    };
    
    // 生成优化建议
    if (metrics.renderTime > 16) { // 超过16ms可能影响60fps
      report.recommendations.push('渲染时间过长，考虑减少DOM操作或使用更高效的渲染策略');
    }
    
    if (metrics.frameRate < 30) {
      report.recommendations.push('帧率过低，检查是否有阻塞主线程的操作');
    }
    
    if (metrics.renderRatio > 50) {
      report.recommendations.push('渲染项目比例过高，考虑增加虚拟化的overscan值');
    }
    
    if (metrics.scrollSmoothnessScore < 70) {
      report.recommendations.push('滚动不够流畅，检查滚动事件处理逻辑');
    }
    
    if (metrics.cacheHitRate < 80) {
      report.recommendations.push('缓存命中率较低，优化缓存策略');
    }
    
    logger.debug('虚拟化性能报告', report);
    
    return report;
  }, [finalConfig.enabled, metrics]);

  // 启动性能监控
  useEffect(() => {
    if (!finalConfig.enabled) return;
    
    // 定期采样
    sampleTimer.current = setInterval(() => {
      measureFrameRate();
      updateMetrics();
    }, finalConfig.sampleInterval);
    
    // 定期生成报告
    reportTimer.current = setInterval(() => {
      generateReport();
    }, finalConfig.reportInterval);
    
    return () => {
      if (sampleTimer.current) {
        clearInterval(sampleTimer.current);
      }
      if (reportTimer.current) {
        clearInterval(reportTimer.current);
      }
    };
  }, [finalConfig, measureFrameRate, updateMetrics, generateReport]);

  /**
   * 重置性能统计
   */
  const resetStats = useCallback(() => {
    renderTimes.current = [];
    frameTimes.current = [];
    scrollEventTimes.current = [];
    cacheStats.current = { hits: 0, misses: 0 };
    
    setMetrics({
      renderTime: 0,
      frameRate: 60,
      renderedItemCount: 0,
      totalItemCount: 0,
      renderRatio: 0,
      scrollEvents: 0,
      scrollSmoothnessScore: 100,
      cacheHitRate: 100,
      cacheSize: 0
    });
  }, []);

  /**
   * 获取性能等级
   */
  const getPerformanceGrade = useCallback(() => {
    const { renderTime, frameRate, scrollSmoothnessScore, cacheHitRate } = metrics;
    
    let score = 0;
    
    // 渲染时间评分 (25%)
    if (renderTime <= 8) score += 25;
    else if (renderTime <= 16) score += 20;
    else if (renderTime <= 32) score += 15;
    else score += 10;
    
    // 帧率评分 (25%)
    if (frameRate >= 55) score += 25;
    else if (frameRate >= 45) score += 20;
    else if (frameRate >= 30) score += 15;
    else score += 10;
    
    // 滚动流畅度评分 (25%)
    score += (scrollSmoothnessScore / 100) * 25;
    
    // 缓存命中率评分 (25%)
    score += (cacheHitRate / 100) * 25;
    
    if (score >= 90) return 'A';
    if (score >= 80) return 'B';
    if (score >= 70) return 'C';
    if (score >= 60) return 'D';
    return 'F';
  }, [metrics]);

  return {
    metrics,
    startRenderMeasurement,
    recordScrollEvent,
    updateRenderStats,
    recordCacheHit,
    recordCacheMiss,
    generateReport,
    resetStats,
    getPerformanceGrade,
    isEnabled: finalConfig.enabled
  };
};

/**
 * 虚拟化性能监控组件
 * 用于在开发环境中显示性能指标
 */
export const VirtualizationPerformanceMonitor: React.FC<{
  show?: boolean;
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
}> = ({ 
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
