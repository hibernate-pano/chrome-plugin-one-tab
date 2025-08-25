/**
 * 拖拽性能优化工具
 * 提供节流、防抖和性能监控功能
 */

import { logger } from './logger';

// 节流函数，用于限制拖拽事件的频率
export function throttle<T extends (...args: any[]) => any>(
  func: T,
  delay: number
): (...args: Parameters<T>) => void {
  let lastCall = 0;
  let timeoutId: NodeJS.Timeout | null = null;

  return (...args: Parameters<T>) => {
    const now = Date.now();
    
    if (now - lastCall >= delay) {
      lastCall = now;
      func(...args);
    } else {
      // 清除之前的延迟调用
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      
      // 设置新的延迟调用，确保最后一次调用会被执行
      timeoutId = setTimeout(() => {
        lastCall = Date.now();
        func(...args);
        timeoutId = null;
      }, delay - (now - lastCall));
    }
  };
}

// 防抖函数，用于延迟执行拖拽结束后的清理操作
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: NodeJS.Timeout | null = null;

  return (...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    
    timeoutId = setTimeout(() => {
      func(...args);
      timeoutId = null;
    }, delay);
  };
}

// 拖拽性能监控器
export class DragPerformanceMonitor {
  private startTime: number = 0;
  private frameCount: number = 0;
  private lastFrameTime: number = 0;
  private isMonitoring: boolean = false;

  startMonitoring() {
    this.startTime = performance.now();
    this.frameCount = 0;
    this.lastFrameTime = this.startTime;
    this.isMonitoring = true;
    
    if (process.env.NODE_ENV === 'development') {
      logger.debug('开始拖拽性能监控');
    }
  }

  recordFrame() {
    if (!this.isMonitoring) return;
    
    const currentTime = performance.now();
    const frameDuration = currentTime - this.lastFrameTime;
    
    this.frameCount++;
    this.lastFrameTime = currentTime;
    
    // 如果帧时间超过16.67ms（60fps），记录警告
    if (frameDuration > 16.67 && process.env.NODE_ENV === 'development') {
      logger.warn('拖拽帧率下降', { 
        frameDuration: frameDuration.toFixed(2),
        frameCount: this.frameCount 
      });
    }
  }

  stopMonitoring() {
    if (!this.isMonitoring) return;
    
    const totalTime = performance.now() - this.startTime;
    const avgFps = this.frameCount / (totalTime / 1000);
    
    this.isMonitoring = false;
    
    if (process.env.NODE_ENV === 'development') {
      logger.debug('拖拽性能监控结束', {
        totalTime: totalTime.toFixed(2),
        frameCount: this.frameCount,
        avgFps: avgFps.toFixed(2)
      });
    }
    
    return {
      totalTime,
      frameCount: this.frameCount,
      avgFps
    };
  }
}

// 拖拽位置比较工具
export interface DragPosition {
  sourceGroupId: string;
  sourceIndex: number;
  targetGroupId: string;
  targetIndex: number;
}

export function isDragPositionEqual(pos1: DragPosition | null, pos2: DragPosition | null): boolean {
  if (!pos1 || !pos2) return pos1 === pos2;
  
  return (
    pos1.sourceGroupId === pos2.sourceGroupId &&
    pos1.sourceIndex === pos2.sourceIndex &&
    pos1.targetGroupId === pos2.targetGroupId &&
    pos1.targetIndex === pos2.targetIndex
  );
}

// 拖拽状态缓存
export class DragStateCache {
  private cache = new Map<string, any>();
  private maxSize: number;

  constructor(maxSize: number = 100) {
    this.maxSize = maxSize;
  }

  set(key: string, value: any): void {
    // 如果缓存已满，删除最旧的条目
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    
    this.cache.set(key, value);
  }

  get(key: string): any {
    return this.cache.get(key);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

// 创建全局实例
export const dragPerformanceMonitor = new DragPerformanceMonitor();
export const dragStateCache = new DragStateCache();

// 拖拽事件节流配置
export const DRAG_THROTTLE_DELAY = 16; // 约60fps
export const DRAG_DEBOUNCE_DELAY = 100; // 拖拽结束后的清理延迟
