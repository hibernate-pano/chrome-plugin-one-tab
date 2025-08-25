/**
 * 组件清理Hook
 * 防止内存泄漏，自动清理组件卸载时的资源
 */
import { useEffect, useRef, useCallback } from 'react';
import { logger } from '@/shared/utils/logger';

export interface CleanupTask {
  name: string;
  cleanup: () => void;
  priority: number;
}

export const useComponentCleanup = (componentName?: string) => {
  const cleanupTasks = useRef<CleanupTask[]>([]);
  const isMounted = useRef(true);
  
  const addCleanupTask = useCallback((
    cleanup: () => void, 
    name: string = 'anonymous',
    priority: number = 0
  ) => {
    const task: CleanupTask = { name, cleanup, priority };
    cleanupTasks.current.push(task);
    
    // 按优先级排序（高优先级先执行）
    cleanupTasks.current.sort((a, b) => b.priority - a.priority);
    
    if (process.env.NODE_ENV === 'development') {
      logger.debug('添加清理任务', { 
        component: componentName,
        task: name,
        priority,
        totalTasks: cleanupTasks.current.length,
      });
    }
    
    // 返回移除函数
    return () => {
      cleanupTasks.current = cleanupTasks.current.filter(t => t !== task);
    };
  }, [componentName]);
  
  const executeCleanup = useCallback(() => {
    if (cleanupTasks.current.length === 0) return;
    
    logger.debug('执行组件清理', { 
      component: componentName,
      taskCount: cleanupTasks.current.length,
    });
    
    let successCount = 0;
    let errorCount = 0;
    
    cleanupTasks.current.forEach(task => {
      try {
        task.cleanup();
        successCount++;
      } catch (error) {
        errorCount++;
        logger.error(`清理任务失败: ${task.name}`, error, {
          component: componentName,
          taskName: task.name,
        });
      }
    });
    
    if (process.env.NODE_ENV === 'development') {
      logger.debug('组件清理完成', {
        component: componentName,
        success: successCount,
        errors: errorCount,
      });
    }
    
    cleanupTasks.current = [];
  }, [componentName]);
  
  const isComponentMounted = useCallback(() => isMounted.current, []);
  
  // 组件卸载时执行清理
  useEffect(() => {
    isMounted.current = true;
    
    return () => {
      isMounted.current = false;
      executeCleanup();
    };
  }, [executeCleanup]);
  
  // 手动清理函数
  const manualCleanup = useCallback(() => {
    executeCleanup();
  }, [executeCleanup]);
  
  return {
    addCleanupTask,
    isComponentMounted,
    manualCleanup,
    taskCount: cleanupTasks.current.length,
  };
};

/**
 * 自动清理的定时器Hook
 */
export const useAutoCleanupTimer = (
  callback: () => void,
  delay: number | null,
  dependencies: React.DependencyList = []
) => {
  const { addCleanupTask } = useComponentCleanup();
  
  useEffect(() => {
    if (delay === null) return;
    
    const timerId = setTimeout(callback, delay);
    
    const removeCleanup = addCleanupTask(
      () => clearTimeout(timerId),
      `timer-${delay}ms`,
      10 // 高优先级，确保定时器及时清理
    );
    
    return removeCleanup;
  }, [...dependencies, delay]);
};

/**
 * 自动清理的事件监听器Hook
 */
export const useAutoCleanupEventListener = <T extends keyof WindowEventMap>(
  event: T,
  handler: (event: WindowEventMap[T]) => void,
  target: EventTarget = window,
  options?: boolean | AddEventListenerOptions
) => {
  const { addCleanupTask } = useComponentCleanup();
  
  useEffect(() => {
    const typedHandler = handler as EventListener;
    target.addEventListener(event, typedHandler, options);
    
    const removeCleanup = addCleanupTask(
      () => target.removeEventListener(event, typedHandler, options),
      `event-${event}`,
      5 // 中等优先级
    );
    
    return removeCleanup;
  }, [event, handler, target, options, addCleanupTask]);
};

/**
 * 自动清理的异步操作Hook
 */
export const useAutoCleanupAsync = () => {
  const { addCleanupTask, isComponentMounted } = useComponentCleanup();
  const abortControllers = useRef<Set<AbortController>>(new Set());
  
  const createAbortablePromise = useCallback(<T>(
    promiseFactory: (signal: AbortSignal) => Promise<T>,
    name: string = 'async-operation'
  ): Promise<T> => {
    const controller = new AbortController();
    abortControllers.current.add(controller);
    
    const removeCleanup = addCleanupTask(
      () => {
        if (!controller.signal.aborted) {
          controller.abort();
        }
        abortControllers.current.delete(controller);
      },
      `abort-${name}`,
      8 // 较高优先级
    );
    
    return promiseFactory(controller.signal)
      .finally(() => {
        abortControllers.current.delete(controller);
        removeCleanup();
      });
  }, [addCleanupTask]);
  
  const safeAsyncCall = useCallback(async <T>(
    asyncFn: () => Promise<T>,
    name: string = 'safe-async'
  ): Promise<T | null> => {
    try {
      const result = await createAbortablePromise(
        async (_signal) => {
          const result = await asyncFn();
          
          // 检查操作完成时组件是否仍然挂载
          if (!isComponentMounted()) {
            throw new Error('Component unmounted during async operation');
          }
          
          return result;
        },
        name
      );
      
      return result;
    } catch (error) {
      if ((error as Error).name === 'AbortError' || 
          (error as Error).message.includes('unmounted')) {
        // 忽略取消和卸载错误
        return null;
      }
      throw error;
    }
  }, [createAbortablePromise, isComponentMounted]);
  
  return {
    createAbortablePromise,
    safeAsyncCall,
    activeOperations: abortControllers.current.size,
  };
};