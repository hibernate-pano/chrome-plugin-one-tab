/**
 * 代码分割和懒加载工具
 * 提供智能的代码分割和预加载功能
 */

/**
 * 创建懒加载组件
 */
export function createLazyComponent<T>(
  importFunc: () => Promise<{ default: T }>
): () => Promise<{ default: T }> {
  return importFunc;
}

/**
 * 带重试的懒加载组件
 */
export function createResilientLazyComponent<T>(
  importFunc: () => Promise<{ default: T }>,
  options: { maxRetries?: number; retryDelay?: number } = {}
): () => Promise<{ default: T }> {
  const { maxRetries = 3, retryDelay = 1000 } = options;

  return async (): Promise<{ default: T }> => {
    let lastError: Error;

    for (let i = 0; i <= maxRetries; i++) {
      try {
        return await importFunc();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (i < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }

    throw lastError!;
  };
}

/**
 * 条件渲染的懒加载
 * 只有在满足条件时才加载组件
 */
export function createConditionalLazyComponent<T>(
  importFunc: () => Promise<{ default: T }>,
  condition: () => boolean
): () => Promise<{ default: T } | null> {
  return async (): Promise<{ default: T } | null> => {
    if (!condition()) {
      return null;
    }
    return await importFunc();
  };
}

/**
 * 基于路由的懒加载
 */
export function createRouteLazyComponent<T>(
  importFunc: () => Promise<{ default: T }>,
  routePattern: string
): () => Promise<{ default: T } | null> {
  // 检查当前路由是否匹配
  const isRouteMatch = () => {
    return (
      window.location.pathname.includes(routePattern) || window.location.hash.includes(routePattern)
    );
  };

  return createConditionalLazyComponent(importFunc, isRouteMatch);
}

/**
 * 预加载管理器
 * 管理组件的预加载策略
 */
class PreloadManager {
  private preloaded = new Set<string>();
  private preloadQueue: Array<{ key: string; importFunc: () => Promise<any> }> = [];

  /**
   * 添加到预加载队列
   */
  queue(key: string, importFunc: () => Promise<any>): void {
    if (this.preloaded.has(key)) return;
    this.preloadQueue.push({ key, importFunc });
  }

  /**
   * 预加载队列中的组件
   */
  async preloadQueued(): Promise<void> {
    const promises = this.preloadQueue.map(async ({ key, importFunc }) => {
      try {
        await importFunc();
        this.preloaded.add(key);
      } catch (error) {
        console.warn(`Failed to preload ${key}:`, error);
      }
    });

    await Promise.all(promises);
    this.preloadQueue = [];
  }

  /**
   * 智能预加载
   * 基于用户行为预测预加载
   */
  startSmartPreloading(): void {
    // 监听用户交互
    const handleInteraction = () => {
      // 延迟预加载，避免阻塞当前操作
      setTimeout(() => {
        this.preloadQueued();
      }, 100);
    };

    // 鼠标悬停
    document.addEventListener('mouseover', handleInteraction, { passive: true });
    // 触摸开始
    document.addEventListener('touchstart', handleInteraction, { passive: true });
    // 滚动
    document.addEventListener('scroll', handleInteraction, { passive: true, once: true });

    // 页面可见性变化
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        setTimeout(() => this.preloadQueued(), 100);
      }
    });
  }

  /**
   * 预加载特定组件
   */
  async preload(key: string, importFunc: () => Promise<any>): Promise<void> {
    if (this.preloaded.has(key)) return;

    try {
      await importFunc();
      this.preloaded.add(key);
    } catch (error) {
      console.warn(`Failed to preload ${key}:`, error);
    }
  }
}

// 导出单例实例
export const preloadManager = new PreloadManager();
