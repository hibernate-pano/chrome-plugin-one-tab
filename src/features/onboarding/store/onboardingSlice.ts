/**
 * 新手引导状态管理
 * 管理引导流程的状态、进度和用户交互
 */

import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { logger } from '@/shared/utils/logger';

export interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  targetElement?: string; // CSS选择器
  position?: 'top' | 'bottom' | 'left' | 'right' | 'center';
  action?: 'click' | 'input' | 'observe' | 'none';
  isOptional?: boolean;
  canSkip?: boolean;
}

export interface UserProgress {
  hasCreatedGroup: boolean;
  hasOpenedTab: boolean;
  hasUsedSearch: boolean;
  hasUsedSettings: boolean;
  hasUsedSync: boolean;
  completedSteps: string[];
  skippedSteps: string[];
}

export interface OnboardingState {
  // 引导状态
  isActive: boolean;
  isCompleted: boolean;
  currentStepIndex: number;
  totalSteps: number;
  
  // 引导配置
  canSkip: boolean;
  autoAdvance: boolean;
  showProgress: boolean;
  
  // 用户进度
  userProgress: UserProgress;
  
  // 引导步骤
  steps: OnboardingStep[];
  
  // 交互状态
  isWaitingForAction: boolean;
  highlightedElement: string | null;
  
  // 设置
  hasShownBefore: boolean;
  lastCompletedAt: string | null;
  
  // 错误处理
  error: string | null;
}

// 默认引导步骤
const defaultSteps: OnboardingStep[] = [
  {
    id: 'welcome',
    title: '欢迎使用 OneTab Plus',
    description: '让我们花2分钟时间了解如何使用这个强大的标签管理工具',
    position: 'center',
    action: 'none',
    canSkip: true,
  },
  {
    id: 'save-tabs',
    title: '保存当前标签',
    description: '点击"保存所有标签"按钮，将当前打开的标签页保存为一个组',
    targetElement: '[data-onboarding="save-tabs-button"]',
    position: 'bottom',
    action: 'click',
    canSkip: false,
  },
  {
    id: 'view-group',
    title: '查看标签组',
    description: '这就是您刚创建的标签组。点击展开按钮查看其中的标签',
    targetElement: '[data-onboarding="tab-group"]',
    position: 'right',
    action: 'click',
    canSkip: true,
  },
  {
    id: 'open-tab',
    title: '重新打开标签',
    description: '点击任意标签可以重新打开它。试试看！',
    targetElement: '[data-onboarding="tab-item"]',
    position: 'right',
    action: 'click',
    canSkip: true,
  },
  {
    id: 'search',
    title: '搜索标签',
    description: '使用搜索框可以快速找到需要的标签。试着输入一些关键词',
    targetElement: '[data-onboarding="search-input"]',
    position: 'bottom',
    action: 'input',
    canSkip: true,
  },
  {
    id: 'settings',
    title: '探索更多功能',
    description: '在设置中可以配置云端同步、主题等功能。您也可以随时重新开始引导',
    targetElement: '[data-onboarding="settings-button"]',
    position: 'left',
    action: 'none',
    canSkip: true,
  },
];

const initialState: OnboardingState = {
  isActive: false,
  isCompleted: false,
  currentStepIndex: 0,
  totalSteps: defaultSteps.length,
  
  canSkip: true,
  autoAdvance: true,
  showProgress: true,
  
  userProgress: {
    hasCreatedGroup: false,
    hasOpenedTab: false,
    hasUsedSearch: false,
    hasUsedSettings: false,
    hasUsedSync: false,
    completedSteps: [],
    skippedSteps: [],
  },
  
  steps: defaultSteps,
  
  isWaitingForAction: false,
  highlightedElement: null,
  
  hasShownBefore: false,
  lastCompletedAt: null,
  
  error: null,
};

const onboardingSlice = createSlice({
  name: 'onboarding',
  initialState,
  reducers: {
    // 开始引导
    startOnboarding: (state, action: PayloadAction<{ force?: boolean }> = { payload: {} }) => {
      const { force = false } = action.payload;
      
      if (!force && state.hasShownBefore && state.isCompleted) {
        logger.debug('引导已完成，跳过自动启动');
        return;
      }
      
      state.isActive = true;
      state.isCompleted = false;
      state.currentStepIndex = 0;
      state.isWaitingForAction = false;
      state.highlightedElement = null;
      state.error = null;
      
      logger.debug('开始新手引导', { 
        force, 
        stepCount: state.totalSteps 
      });
    },
    
    // 停止引导
    stopOnboarding: (state) => {
      state.isActive = false;
      state.isWaitingForAction = false;
      state.highlightedElement = null;
      
      logger.debug('停止新手引导', { 
        currentStep: state.currentStepIndex,
        completed: state.isCompleted 
      });
    },
    
    // 下一步
    nextStep: (state) => {
      if (state.currentStepIndex < state.totalSteps - 1) {
        state.currentStepIndex += 1;
        state.isWaitingForAction = false;
        state.highlightedElement = null;
        
        const currentStep = state.steps[state.currentStepIndex];
        if (currentStep.targetElement) {
          state.highlightedElement = currentStep.targetElement;
        }
        
        logger.debug('进入下一步', { 
          stepIndex: state.currentStepIndex,
          stepId: currentStep.id 
        });
      } else {
        // 完成引导
        state.isCompleted = true;
        state.isActive = false;
        state.lastCompletedAt = new Date().toISOString();
        state.hasShownBefore = true;
        
        logger.debug('完成新手引导');
      }
    },
    
    // 上一步
    prevStep: (state) => {
      if (state.currentStepIndex > 0) {
        state.currentStepIndex -= 1;
        state.isWaitingForAction = false;
        state.highlightedElement = null;
        
        const currentStep = state.steps[state.currentStepIndex];
        if (currentStep.targetElement) {
          state.highlightedElement = currentStep.targetElement;
        }
        
        logger.debug('返回上一步', { 
          stepIndex: state.currentStepIndex,
          stepId: currentStep.id 
        });
      }
    },
    
    // 跳过当前步骤
    skipStep: (state) => {
      const currentStep = state.steps[state.currentStepIndex];
      
      if (currentStep.canSkip) {
        state.userProgress.skippedSteps.push(currentStep.id);
        
        logger.debug('跳过引导步骤', { 
          stepId: currentStep.id,
          stepIndex: state.currentStepIndex 
        });
        
        // 自动进入下一步
        onboardingSlice.caseReducers.nextStep(state);
      }
    },
    
    // 完成当前步骤
    completeStep: (state, action: PayloadAction<{ stepId?: string }> = { payload: {} }) => {
      const { stepId } = action.payload;
      const currentStep = state.steps[state.currentStepIndex];
      const targetStepId = stepId || currentStep.id;
      
      if (!state.userProgress.completedSteps.includes(targetStepId)) {
        state.userProgress.completedSteps.push(targetStepId);
      }
      
      logger.debug('完成引导步骤', { 
        stepId: targetStepId,
        stepIndex: state.currentStepIndex 
      });
      
      // 如果是当前步骤，自动进入下一步
      if (targetStepId === currentStep.id && state.autoAdvance) {
        onboardingSlice.caseReducers.nextStep(state);
      }
    },
    
    // 更新用户进度
    updateUserProgress: (state, action: PayloadAction<Partial<UserProgress>>) => {
      state.userProgress = { ...state.userProgress, ...action.payload };
      
      logger.debug('更新用户进度', action.payload);
    },
    
    // 设置等待用户操作
    setWaitingForAction: (state, action: PayloadAction<boolean>) => {
      state.isWaitingForAction = action.payload;
    },
    
    // 设置高亮元素
    setHighlightedElement: (state, action: PayloadAction<string | null>) => {
      state.highlightedElement = action.payload;
    },
    
    // 重置引导状态
    resetOnboarding: (state) => {
      Object.assign(state, {
        ...initialState,
        hasShownBefore: false,
        lastCompletedAt: null,
      });
      
      logger.debug('重置新手引导状态');
    },
    
    // 设置错误
    setError: (state, action: PayloadAction<string | null>) => {
      state.error = action.payload;
      
      if (action.payload) {
        logger.error('新手引导错误', { error: action.payload });
      }
    },
    
    // 从本地存储恢复状态
    restoreFromStorage: (state, action: PayloadAction<Partial<OnboardingState>>) => {
      const savedState = action.payload;
      
      // 只恢复特定字段，避免覆盖默认配置
      if (savedState.hasShownBefore !== undefined) {
        state.hasShownBefore = savedState.hasShownBefore;
      }
      if (savedState.lastCompletedAt) {
        state.lastCompletedAt = savedState.lastCompletedAt;
      }
      if (savedState.userProgress) {
        state.userProgress = { ...state.userProgress, ...savedState.userProgress };
      }
      
      logger.debug('从本地存储恢复引导状态', savedState);
    },
  },
});

export const {
  startOnboarding,
  stopOnboarding,
  nextStep,
  prevStep,
  skipStep,
  completeStep,
  updateUserProgress,
  setWaitingForAction,
  setHighlightedElement,
  resetOnboarding,
  setError,
  restoreFromStorage,
} = onboardingSlice.actions;

export default onboardingSlice.reducer;
