import React, { memo } from 'react';
import { cn } from '@/shared/utils/cn';
import { createMemoComparison } from '@/shared/utils/performanceOptimizer';

/**
 * 加载状态类型枚举
 */
export enum LoadingType {
  SPINNER = 'spinner',
  DOTS = 'dots',
  PULSE = 'pulse',
  SKELETON = 'skeleton',
  PROGRESS = 'progress'
}

/**
 * 加载状态大小枚举
 */
export enum LoadingSize {
  SMALL = 'small',
  MEDIUM = 'medium',
  LARGE = 'large'
}

/**
 * 加载状态属性接口
 */
export interface LoadingStateProps {
  // 基础属性
  loading?: boolean;
  type?: LoadingType;
  size?: LoadingSize;
  message?: string;
  
  // 进度相关
  progress?: number; // 0-100
  showProgress?: boolean;
  
  // 样式相关
  className?: string;
  overlay?: boolean; // 是否显示遮罩层
  transparent?: boolean; // 遮罩层是否透明
  
  // 交互相关
  cancelable?: boolean;
  onCancel?: () => void;
  
  // 内容相关
  children?: React.ReactNode; // 被包装的内容
  fallback?: React.ReactNode; // 加载时的替代内容
}

/**
 * 旋转加载器组件
 */
const SpinnerLoader: React.FC<{ size: LoadingSize; className?: string }> = ({ size, className }) => {
  const sizeClasses = {
    [LoadingSize.SMALL]: 'w-4 h-4',
    [LoadingSize.MEDIUM]: 'w-6 h-6',
    [LoadingSize.LARGE]: 'w-8 h-8'
  };

  return (
    <div className={cn('animate-spin', sizeClasses[size], className)}>
      <svg className="w-full h-full" fill="none" viewBox="0 0 24 24">
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
        />
      </svg>
    </div>
  );
};

/**
 * 点状加载器组件
 */
const DotsLoader: React.FC<{ size: LoadingSize; className?: string }> = ({ size, className }) => {
  const sizeClasses = {
    [LoadingSize.SMALL]: 'w-1 h-1',
    [LoadingSize.MEDIUM]: 'w-2 h-2',
    [LoadingSize.LARGE]: 'w-3 h-3'
  };

  const dotClass = cn('bg-current rounded-full animate-pulse', sizeClasses[size]);

  return (
    <div className={cn('flex space-x-1', className)}>
      <div className={cn(dotClass, 'animation-delay-0')} />
      <div className={cn(dotClass, 'animation-delay-150')} />
      <div className={cn(dotClass, 'animation-delay-300')} />
    </div>
  );
};

/**
 * 脉冲加载器组件
 */
const PulseLoader: React.FC<{ size: LoadingSize; className?: string }> = ({ size, className }) => {
  const sizeClasses = {
    [LoadingSize.SMALL]: 'w-8 h-8',
    [LoadingSize.MEDIUM]: 'w-12 h-12',
    [LoadingSize.LARGE]: 'w-16 h-16'
  };

  return (
    <div className={cn('relative', sizeClasses[size], className)}>
      <div className="absolute inset-0 bg-current rounded-full animate-ping opacity-20" />
      <div className="absolute inset-2 bg-current rounded-full animate-pulse opacity-40" />
      <div className="absolute inset-4 bg-current rounded-full" />
    </div>
  );
};

/**
 * 骨架屏加载器组件
 */
const SkeletonLoader: React.FC<{ size: LoadingSize; className?: string }> = ({ size, className }) => {
  const heightClasses = {
    [LoadingSize.SMALL]: 'h-20',
    [LoadingSize.MEDIUM]: 'h-32',
    [LoadingSize.LARGE]: 'h-48'
  };

  return (
    <div className={cn('animate-pulse space-y-3', heightClasses[size], className)}>
      <div className="bg-gray-200 dark:bg-gray-700 rounded h-4 w-3/4" />
      <div className="bg-gray-200 dark:bg-gray-700 rounded h-4 w-1/2" />
      <div className="bg-gray-200 dark:bg-gray-700 rounded h-4 w-5/6" />
      <div className="bg-gray-200 dark:bg-gray-700 rounded h-4 w-2/3" />
    </div>
  );
};

/**
 * 进度条加载器组件
 */
const ProgressLoader: React.FC<{ 
  progress: number; 
  size: LoadingSize; 
  className?: string;
  showPercentage?: boolean;
}> = ({ progress, size, className, showPercentage = true }) => {
  const heightClasses = {
    [LoadingSize.SMALL]: 'h-1',
    [LoadingSize.MEDIUM]: 'h-2',
    [LoadingSize.LARGE]: 'h-3'
  };

  const clampedProgress = Math.max(0, Math.min(100, progress));

  return (
    <div className={cn('w-full', className)}>
      {showPercentage && (
        <div className="flex justify-between text-sm text-gray-600 dark:text-gray-400 mb-1">
          <span>加载中...</span>
          <span>{clampedProgress.toFixed(0)}%</span>
        </div>
      )}
      <div className={cn('w-full bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden', heightClasses[size])}>
        <div
          className="bg-blue-600 h-full transition-all duration-300 ease-out"
          style={{ width: `${clampedProgress}%` }}
        />
      </div>
    </div>
  );
};

/**
 * 通用加载状态组件
 */
const LoadingStateComponent: React.FC<LoadingStateProps> = ({
  loading = true,
  type = LoadingType.SPINNER,
  size = LoadingSize.MEDIUM,
  message,
  progress = 0,
  showProgress = false,
  className,
  overlay = false,
  transparent = false,
  cancelable = false,
  onCancel,
  children,
  fallback
}) => {
  // 如果不在加载状态，直接返回子内容
  if (!loading) {
    return <>{children}</>;
  }

  // 渲染加载器
  const renderLoader = () => {
    const loaderProps = { size, className: 'text-blue-600' };

    switch (type) {
      case LoadingType.SPINNER:
        return <SpinnerLoader {...loaderProps} />;
      case LoadingType.DOTS:
        return <DotsLoader {...loaderProps} />;
      case LoadingType.PULSE:
        return <PulseLoader {...loaderProps} />;
      case LoadingType.SKELETON:
        return <SkeletonLoader {...loaderProps} />;
      case LoadingType.PROGRESS:
        return (
          <ProgressLoader 
            progress={progress} 
            size={size} 
            className={loaderProps.className}
            showPercentage={showProgress}
          />
        );
      default:
        return <SpinnerLoader {...loaderProps} />;
    }
  };

  // 加载内容
  const loadingContent = (
    <div className={cn(
      'flex flex-col items-center justify-center space-y-3',
      overlay ? 'absolute inset-0 z-10' : '',
      className
    )}>
      {renderLoader()}
      
      {message && (
        <p className="text-sm text-gray-600 dark:text-gray-400 text-center max-w-xs">
          {message}
        </p>
      )}
      
      {cancelable && onCancel && (
        <button
          onClick={onCancel}
          className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 underline"
        >
          取消
        </button>
      )}
    </div>
  );

  // 如果是遮罩模式
  if (overlay) {
    return (
      <div className="relative">
        {children}
        <div className={cn(
          'absolute inset-0 flex items-center justify-center',
          transparent ? 'bg-transparent' : 'bg-white/80 dark:bg-gray-900/80',
          'backdrop-blur-sm'
        )}>
          {loadingContent}
        </div>
      </div>
    );
  }

  // 如果有fallback内容
  if (fallback) {
    return <>{fallback}</>;
  }

  // 默认返回加载内容
  return loadingContent;
};

// 使用memo优化性能
export const LoadingState = memo(
  LoadingStateComponent,
  createMemoComparison([
    'loading',
    'type',
    'size',
    'message',
    'progress',
    'showProgress',
    'className',
    'overlay',
    'transparent',
    'cancelable',
    'onCancel',
    'children',
    'fallback'
  ])
);

/**
 * 加载状态Hook
 */
export function useLoadingState(initialLoading: boolean = false) {
  const [loading, setLoading] = React.useState(initialLoading);
  const [progress, setProgress] = React.useState(0);
  const [message, setMessage] = React.useState<string>('');

  const startLoading = React.useCallback((loadingMessage?: string) => {
    setLoading(true);
    setProgress(0);
    if (loadingMessage) {
      setMessage(loadingMessage);
    }
  }, []);

  const stopLoading = React.useCallback(() => {
    setLoading(false);
    setProgress(0);
    setMessage('');
  }, []);

  const updateProgress = React.useCallback((newProgress: number, progressMessage?: string) => {
    setProgress(newProgress);
    if (progressMessage) {
      setMessage(progressMessage);
    }
  }, []);

  const updateMessage = React.useCallback((newMessage: string) => {
    setMessage(newMessage);
  }, []);

  return {
    loading,
    progress,
    message,
    startLoading,
    stopLoading,
    updateProgress,
    updateMessage,
    setLoading
  };
}

/**
 * 预定义的加载状态配置
 */
export const LoadingPresets = {
  /**
   * 页面加载
   */
  page: {
    type: LoadingType.SPINNER,
    size: LoadingSize.LARGE,
    message: '页面加载中...',
    overlay: true
  },

  /**
   * 数据加载
   */
  data: {
    type: LoadingType.DOTS,
    size: LoadingSize.MEDIUM,
    message: '数据加载中...'
  },

  /**
   * 文件上传
   */
  upload: {
    type: LoadingType.PROGRESS,
    size: LoadingSize.MEDIUM,
    message: '文件上传中...',
    showProgress: true,
    cancelable: true
  },

  /**
   * 保存操作
   */
  save: {
    type: LoadingType.SPINNER,
    size: LoadingSize.SMALL,
    message: '保存中...'
  },

  /**
   * 删除操作
   */
  delete: {
    type: LoadingType.PULSE,
    size: LoadingSize.MEDIUM,
    message: '删除中...'
  },

  /**
   * 同步操作
   */
  sync: {
    type: LoadingType.DOTS,
    size: LoadingSize.MEDIUM,
    message: '同步中...',
    cancelable: true
  }
};
