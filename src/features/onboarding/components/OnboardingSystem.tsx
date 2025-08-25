/**
 * 新手引导系统主组件
 * 整合所有引导相关组件，提供完整的引导体验
 */

import React from 'react';
import { OnboardingProvider } from './OnboardingProvider';
import { OnboardingOverlay } from './OnboardingOverlay';

interface OnboardingSystemProps {
  children: React.ReactNode;
  autoStart?: boolean;
  storageKey?: string;
  className?: string;
}

export const OnboardingSystem: React.FC<OnboardingSystemProps> = ({
  children,
  autoStart = true,
  storageKey = 'onetab-onboarding-state',
  className = '',
}) => {
  return (
    <OnboardingProvider autoStart={autoStart} storageKey={storageKey}>
      <div className={className}>
        {children}
        <OnboardingOverlay />
      </div>
    </OnboardingProvider>
  );
};

// 导出所有相关组件和hooks
export { OnboardingProvider, useOnboarding, withOnboarding, useOnboardingHighlight, useOnboardingTarget } from './OnboardingProvider';
export { OnboardingOverlay } from './OnboardingOverlay';
export { OnboardingTooltip } from './OnboardingTooltip';
export { OnboardingProgress, SimpleOnboardingProgress, CircularOnboardingProgress } from './OnboardingProgress';

// 导出类型
export type { OnboardingStep, OnboardingState, UserProgress } from '../store/onboardingSlice';

// 导出actions
export {
  startOnboarding,
  stopOnboarding,
  nextStep,
  prevStep,
  skipStep,
  completeStep,
  updateUserProgress,
  resetOnboarding,
} from '../store/onboardingSlice';
