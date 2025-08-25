/**
 * 新手引导提供者组件
 * 管理引导系统的全局状态和生命周期
 */

import React, { createContext, useContext, useEffect, useCallback } from 'react';
import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import {
  startOnboarding,
  stopOnboarding,
  nextStep,
  prevStep,
  skipStep,
  completeStep,
  updateUserProgress,
  restoreFromStorage,
  setError,
} from '../store/onboardingSlice';
import { logger } from '@/shared/utils/logger';

interface OnboardingContextValue {
  // 状态
  isActive: boolean;
  currentStep: any;
  currentStepIndex: number;
  totalSteps: number;
  isCompleted: boolean;
  
  // 操作
  start: (force?: boolean) => void;
  stop: () => void;
  next: () => void;
  prev: () => void;
  skip: () => void;
  complete: (stepId?: string) => void;
  
  // 进度管理
  markProgress: (progress: any) => void;
  
  // 工具方法
  isFirstTime: boolean;
  canGoNext: boolean;
  canGoPrev: boolean;
  canSkip: boolean;
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

export const useOnboarding = () => {
  const context = useContext(OnboardingContext);
  if (!context) {
    throw new Error('useOnboarding must be used within OnboardingProvider');
  }
  return context;
};

interface OnboardingProviderProps {
  children: React.ReactNode;
  autoStart?: boolean; // 是否自动开始引导
  storageKey?: string; // 本地存储键名
}

export const OnboardingProvider: React.FC<OnboardingProviderProps> = ({
  children,
  autoStart = true,
  storageKey = 'onetab-onboarding-state',
}) => {
  const dispatch = useAppDispatch();
  const onboardingState = useAppSelector(state => state.onboarding);
  
  const {
    isActive,
    currentStepIndex,
    totalSteps,
    isCompleted,
    steps,
    hasShownBefore,
    userProgress,
    canSkip: globalCanSkip,
  } = onboardingState;
  
  const currentStep = steps[currentStepIndex];
  
  // 从本地存储恢复状态
  useEffect(() => {
    try {
      const savedState = localStorage.getItem(storageKey);
      if (savedState) {
        const parsedState = JSON.parse(savedState);
        dispatch(restoreFromStorage(parsedState));
        
        logger.debug('恢复引导状态', parsedState);
      }
    } catch (error) {
      logger.error('恢复引导状态失败', error);
      dispatch(setError('恢复引导状态失败'));
    }
  }, [dispatch, storageKey]);
  
  // 保存状态到本地存储
  useEffect(() => {
    try {
      const stateToSave = {
        hasShownBefore,
        lastCompletedAt: onboardingState.lastCompletedAt,
        userProgress,
        isCompleted,
      };
      
      localStorage.setItem(storageKey, JSON.stringify(stateToSave));
    } catch (error) {
      logger.error('保存引导状态失败', error);
    }
  }, [hasShownBefore, onboardingState.lastCompletedAt, userProgress, isCompleted, storageKey]);
  
  // 自动开始引导（仅首次用户）
  useEffect(() => {
    // 只有在满足以下条件时才自动启动：
    // 1. 启用了自动启动
    // 2. 之前没有显示过引导
    // 3. 引导没有完成
    // 4. 引导当前不活跃
    // 5. 本地存储状态已经恢复（避免在状态恢复前启动）
    if (autoStart && !hasShownBefore && !isCompleted && !isActive) {
      // 延迟启动，确保页面完全加载和状态恢复完成
      const timer = setTimeout(() => {
        // 再次检查状态，确保在延迟期间状态没有改变
        if (!hasShownBefore && !isCompleted && !isActive) {
          logger.debug('自动启动新手引导', {
            hasShownBefore,
            isCompleted,
            isActive
          });
          dispatch(startOnboarding());
        }
      }, 2000); // 增加延迟时间，确保状态恢复完成

      return () => clearTimeout(timer);
    }
  }, [autoStart, hasShownBefore, isCompleted, isActive, dispatch]);
  
  // 监听用户操作，自动更新进度
  useEffect(() => {
    const handleUserAction = (event: Event) => {
      const target = event.target as HTMLElement;
      
      // 检查是否是引导相关的操作
      if (target.hasAttribute('data-onboarding')) {
        const action = target.getAttribute('data-onboarding');
        
        switch (action) {
          case 'save-tabs-button':
            dispatch(updateUserProgress({ hasCreatedGroup: true }));
            dispatch(completeStep({ stepId: 'save-tabs' }));
            break;
          case 'tab-item':
            dispatch(updateUserProgress({ hasOpenedTab: true }));
            dispatch(completeStep({ stepId: 'open-tab' }));
            break;
          case 'search-input':
            dispatch(updateUserProgress({ hasUsedSearch: true }));
            dispatch(completeStep({ stepId: 'search' }));
            break;
          case 'settings-button':
            dispatch(updateUserProgress({ hasUsedSettings: true }));
            dispatch(completeStep({ stepId: 'settings' }));
            break;
        }
      }
    };
    
    if (isActive) {
      document.addEventListener('click', handleUserAction);
      document.addEventListener('input', handleUserAction);
      
      return () => {
        document.removeEventListener('click', handleUserAction);
        document.removeEventListener('input', handleUserAction);
      };
    }
  }, [isActive, dispatch]);
  
  // 操作方法
  const start = useCallback((force = false) => {
    dispatch(startOnboarding({ force }));
  }, [dispatch]);
  
  const stop = useCallback(() => {
    dispatch(stopOnboarding());
  }, [dispatch]);
  
  const next = useCallback(() => {
    dispatch(nextStep());
  }, [dispatch]);
  
  const prev = useCallback(() => {
    dispatch(prevStep());
  }, [dispatch]);
  
  const skip = useCallback(() => {
    dispatch(skipStep());
  }, [dispatch]);
  
  const complete = useCallback((stepId?: string) => {
    dispatch(completeStep({ stepId }));
  }, [dispatch]);
  
  const markProgress = useCallback((progress: any) => {
    dispatch(updateUserProgress(progress));
  }, [dispatch]);
  
  // 计算状态
  const isFirstTime = !hasShownBefore;
  const canGoNext = currentStepIndex < totalSteps - 1;
  const canGoPrev = currentStepIndex > 0;
  const canSkip = globalCanSkip && currentStep?.canSkip;
  
  const contextValue: OnboardingContextValue = {
    // 状态
    isActive,
    currentStep,
    currentStepIndex,
    totalSteps,
    isCompleted,
    
    // 操作
    start,
    stop,
    next,
    prev,
    skip,
    complete,
    
    // 进度管理
    markProgress,
    
    // 工具方法
    isFirstTime,
    canGoNext,
    canGoPrev,
    canSkip,
  };
  
  return (
    <OnboardingContext.Provider value={contextValue}>
      {children}
    </OnboardingContext.Provider>
  );
};

// 高阶组件：为组件添加引导支持
export const withOnboarding = <P extends object>(
  Component: React.ComponentType<P>,
  onboardingId?: string
) => {
  return React.forwardRef<any, P>((props, ref) => {
    const onboarding = useOnboarding();
    
    const enhancedProps = {
      ...props,
      onboarding,
      'data-onboarding': onboardingId,
    } as P & { onboarding: OnboardingContextValue; 'data-onboarding'?: string };
    
    return <Component ref={ref} {...enhancedProps} />;
  });
};

// Hook：检查当前是否应该高亮某个元素
export const useOnboardingHighlight = (elementId: string) => {
  const { isActive, currentStep } = useOnboarding();
  const highlightedElement = useAppSelector(state => state.onboarding.highlightedElement);
  
  const isHighlighted = isActive && 
    currentStep?.targetElement === `[data-onboarding="${elementId}"]` &&
    highlightedElement === `[data-onboarding="${elementId}"]`;
  
  return {
    isHighlighted,
    shouldShowTooltip: isHighlighted,
    step: isHighlighted ? currentStep : null,
  };
};

// Hook：注册引导目标元素
export const useOnboardingTarget = (elementId: string, ref: React.RefObject<HTMLElement>) => {
  const { isActive, currentStep } = useOnboarding();
  
  useEffect(() => {
    if (isActive && currentStep?.targetElement === `[data-onboarding="${elementId}"]` && ref.current) {
      // 确保元素可见
      ref.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
        inline: 'center',
      });
    }
  }, [isActive, currentStep, elementId, ref]);
  
  return {
    'data-onboarding': elementId,
    ref,
  };
};
