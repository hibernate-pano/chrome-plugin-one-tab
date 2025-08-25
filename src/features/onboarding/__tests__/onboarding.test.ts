/**
 * 新手引导系统测试
 * 测试引导流程的核心功能和状态管理
 */

import { configureStore } from '@reduxjs/toolkit';
import onboardingReducer, {
  startOnboarding,
  stopOnboarding,
  nextStep,
  prevStep,
  skipStep,
  completeStep,
  updateUserProgress,
  resetOnboarding,
  OnboardingState,
} from '../store/onboardingSlice';

// 创建测试用的store
const createTestStore = (initialState?: Partial<OnboardingState>) => {
  return configureStore({
    reducer: {
      onboarding: onboardingReducer,
    },
    preloadedState: initialState ? { onboarding: initialState as OnboardingState } : undefined,
  });
};

describe('新手引导系统', () => {
  describe('引导状态管理', () => {
    test('应该正确初始化状态', () => {
      const store = createTestStore();
      const state = store.getState().onboarding;
      
      expect(state.isActive).toBe(false);
      expect(state.isCompleted).toBe(false);
      expect(state.currentStepIndex).toBe(0);
      expect(state.totalSteps).toBe(6);
      expect(state.hasShownBefore).toBe(false);
    });

    test('应该能够开始引导', () => {
      const store = createTestStore();
      
      store.dispatch(startOnboarding());
      const state = store.getState().onboarding;
      
      expect(state.isActive).toBe(true);
      expect(state.currentStepIndex).toBe(0);
    });

    test('应该能够停止引导', () => {
      const store = createTestStore();
      
      store.dispatch(startOnboarding());
      store.dispatch(stopOnboarding());
      const state = store.getState().onboarding;
      
      expect(state.isActive).toBe(false);
    });

    test('应该能够进入下一步', () => {
      const store = createTestStore();
      
      store.dispatch(startOnboarding());
      store.dispatch(nextStep());
      const state = store.getState().onboarding;
      
      expect(state.currentStepIndex).toBe(1);
    });

    test('应该能够返回上一步', () => {
      const store = createTestStore();
      
      store.dispatch(startOnboarding());
      store.dispatch(nextStep());
      store.dispatch(prevStep());
      const state = store.getState().onboarding;
      
      expect(state.currentStepIndex).toBe(0);
    });

    test('应该能够跳过步骤', () => {
      const store = createTestStore();
      
      store.dispatch(startOnboarding());
      store.dispatch(skipStep());
      const state = store.getState().onboarding;
      
      expect(state.currentStepIndex).toBe(1);
      expect(state.userProgress.skippedSteps).toContain('welcome');
    });

    test('应该能够完成步骤', () => {
      const store = createTestStore();
      
      store.dispatch(startOnboarding());
      store.dispatch(completeStep({ stepId: 'welcome' }));
      const state = store.getState().onboarding;
      
      expect(state.userProgress.completedSteps).toContain('welcome');
      expect(state.currentStepIndex).toBe(1);
    });

    test('应该在最后一步完成引导', () => {
      const store = createTestStore();
      
      store.dispatch(startOnboarding());
      
      // 跳到最后一步
      for (let i = 0; i < 5; i++) {
        store.dispatch(nextStep());
      }
      
      // 完成最后一步
      store.dispatch(nextStep());
      const state = store.getState().onboarding;
      
      expect(state.isCompleted).toBe(true);
      expect(state.isActive).toBe(false);
      expect(state.hasShownBefore).toBe(true);
    });

    test('应该能够更新用户进度', () => {
      const store = createTestStore();
      
      store.dispatch(updateUserProgress({
        hasCreatedGroup: true,
        hasOpenedTab: true,
      }));
      const state = store.getState().onboarding;
      
      expect(state.userProgress.hasCreatedGroup).toBe(true);
      expect(state.userProgress.hasOpenedTab).toBe(true);
    });

    test('应该能够重置引导状态', () => {
      const store = createTestStore();
      
      // 先完成一些操作
      store.dispatch(startOnboarding());
      store.dispatch(nextStep());
      store.dispatch(updateUserProgress({ hasCreatedGroup: true }));
      
      // 重置状态
      store.dispatch(resetOnboarding());
      const state = store.getState().onboarding;
      
      expect(state.isActive).toBe(false);
      expect(state.currentStepIndex).toBe(0);
      expect(state.hasShownBefore).toBe(false);
      expect(state.userProgress.hasCreatedGroup).toBe(false);
    });
  });

  describe('边界条件测试', () => {
    test('不应该能够超出步骤范围', () => {
      const store = createTestStore();
      
      store.dispatch(startOnboarding());
      
      // 尝试返回到负数步骤
      store.dispatch(prevStep());
      let state = store.getState().onboarding;
      expect(state.currentStepIndex).toBe(0);
      
      // 跳到最后一步后尝试继续
      for (let i = 0; i < 10; i++) {
        store.dispatch(nextStep());
      }
      state = store.getState().onboarding;
      expect(state.isCompleted).toBe(true);
    });

    test('应该正确处理强制开始', () => {
      const store = createTestStore({
        hasShownBefore: true,
        isCompleted: true,
      } as Partial<OnboardingState>);
      
      // 正常开始应该被跳过
      store.dispatch(startOnboarding());
      let state = store.getState().onboarding;
      expect(state.isActive).toBe(false);
      
      // 强制开始应该成功
      store.dispatch(startOnboarding({ force: true }));
      state = store.getState().onboarding;
      expect(state.isActive).toBe(true);
    });

    test('应该正确处理不可跳过的步骤', () => {
      const store = createTestStore();
      
      store.dispatch(startOnboarding());
      store.dispatch(nextStep()); // 进入 save-tabs 步骤
      
      const state = store.getState().onboarding;
      const currentStep = state.steps[state.currentStepIndex];
      
      // save-tabs 步骤不可跳过
      expect(currentStep.canSkip).toBe(false);
      
      // 尝试跳过应该无效
      const initialIndex = state.currentStepIndex;
      store.dispatch(skipStep());
      const newState = store.getState().onboarding;
      expect(newState.currentStepIndex).toBe(initialIndex);
    });
  });

  describe('步骤配置测试', () => {
    test('应该包含所有必需的步骤', () => {
      const store = createTestStore();
      const state = store.getState().onboarding;
      
      const expectedSteps = [
        'welcome',
        'save-tabs',
        'view-group',
        'open-tab',
        'search',
        'settings',
      ];
      
      expectedSteps.forEach((stepId, index) => {
        expect(state.steps[index].id).toBe(stepId);
      });
    });

    test('每个步骤应该有必需的属性', () => {
      const store = createTestStore();
      const state = store.getState().onboarding;
      
      state.steps.forEach(step => {
        expect(step.id).toBeDefined();
        expect(step.title).toBeDefined();
        expect(step.description).toBeDefined();
        expect(typeof step.canSkip).toBe('boolean');
      });
    });
  });

  describe('用户进度跟踪', () => {
    test('应该正确跟踪用户操作', () => {
      const store = createTestStore();
      
      // 模拟用户操作序列
      store.dispatch(updateUserProgress({ hasCreatedGroup: true }));
      store.dispatch(completeStep({ stepId: 'save-tabs' }));
      
      store.dispatch(updateUserProgress({ hasOpenedTab: true }));
      store.dispatch(completeStep({ stepId: 'open-tab' }));
      
      store.dispatch(updateUserProgress({ hasUsedSearch: true }));
      store.dispatch(completeStep({ stepId: 'search' }));
      
      const state = store.getState().onboarding;
      
      expect(state.userProgress.hasCreatedGroup).toBe(true);
      expect(state.userProgress.hasOpenedTab).toBe(true);
      expect(state.userProgress.hasUsedSearch).toBe(true);
      
      expect(state.userProgress.completedSteps).toContain('save-tabs');
      expect(state.userProgress.completedSteps).toContain('open-tab');
      expect(state.userProgress.completedSteps).toContain('search');
    });
  });
});

// 集成测试辅助函数
export const createOnboardingTestUtils = () => {
  const store = createTestStore();
  
  return {
    store,
    getState: () => store.getState().onboarding,
    dispatch: store.dispatch,
    
    // 便捷方法
    startOnboarding: (force = false) => store.dispatch(startOnboarding({ force })),
    completeAllSteps: () => {
      store.dispatch(startOnboarding());
      for (let i = 0; i < 6; i++) {
        store.dispatch(nextStep());
      }
    },
    simulateUserJourney: () => {
      store.dispatch(startOnboarding());
      store.dispatch(nextStep()); // welcome -> save-tabs
      store.dispatch(updateUserProgress({ hasCreatedGroup: true }));
      store.dispatch(completeStep({ stepId: 'save-tabs' }));
      store.dispatch(updateUserProgress({ hasOpenedTab: true }));
      store.dispatch(completeStep({ stepId: 'open-tab' }));
      store.dispatch(updateUserProgress({ hasUsedSearch: true }));
      store.dispatch(completeStep({ stepId: 'search' }));
    },
  };
};
