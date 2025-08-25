/**
 * 新手引导进度指示器组件
 * 显示当前引导进度和步骤信息
 */

import React from 'react';

interface OnboardingProgressProps {
  currentStep: number;
  totalSteps: number;
  className?: string;
  style?: React.CSSProperties;
  showNumbers?: boolean;
  showPercentage?: boolean;
}

export const OnboardingProgress: React.FC<OnboardingProgressProps> = ({
  currentStep,
  totalSteps,
  className = '',
  style = {},
  showNumbers = true,
  showPercentage = false,
}) => {
  const progress = (currentStep / totalSteps) * 100;
  
  return (
    <div
      className={`bg-white dark:bg-gray-800 rounded-full shadow-lg border border-gray-200 dark:border-gray-700 px-4 py-2 ${className}`}
      style={style}
      role="progressbar"
      aria-valuenow={currentStep}
      aria-valuemin={1}
      aria-valuemax={totalSteps}
      aria-label={`引导进度: 第 ${currentStep} 步，共 ${totalSteps} 步`}
    >
      <div className="flex items-center space-x-3">
        {/* 进度条 */}
        <div className="flex-1 bg-gray-200 dark:bg-gray-700 rounded-full h-2 min-w-[120px]">
          <div
            className="bg-blue-600 h-2 rounded-full transition-all duration-300 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
        
        {/* 步骤信息 */}
        <div className="flex items-center space-x-2 text-sm text-gray-600 dark:text-gray-300">
          {showNumbers && (
            <span className="font-medium whitespace-nowrap">
              {currentStep} / {totalSteps}
            </span>
          )}
          
          {showPercentage && (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              ({Math.round(progress)}%)
            </span>
          )}
        </div>
        
        {/* 步骤点 */}
        <div className="flex space-x-1">
          {Array.from({ length: totalSteps }, (_, index) => {
            const stepNumber = index + 1;
            const isCompleted = stepNumber < currentStep;
            const isCurrent = stepNumber === currentStep;
            
            return (
              <div
                key={stepNumber}
                className={`w-2 h-2 rounded-full transition-all duration-200 ${
                  isCompleted
                    ? 'bg-blue-600 scale-110'
                    : isCurrent
                    ? 'bg-blue-400 scale-125 animate-pulse'
                    : 'bg-gray-300 dark:bg-gray-600'
                }`}
                title={`步骤 ${stepNumber}${isCompleted ? ' (已完成)' : isCurrent ? ' (当前)' : ''}`}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
};

// 简化版进度指示器
export const SimpleOnboardingProgress: React.FC<{
  currentStep: number;
  totalSteps: number;
  className?: string;
}> = ({ currentStep, totalSteps, className = '' }) => {
  return (
    <div className={`flex items-center space-x-2 ${className}`}>
      <div className="flex space-x-1">
        {Array.from({ length: totalSteps }, (_, index) => {
          const stepNumber = index + 1;
          const isActive = stepNumber <= currentStep;
          
          return (
            <div
              key={stepNumber}
              className={`w-2 h-2 rounded-full transition-colors duration-200 ${
                isActive ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
              }`}
            />
          );
        })}
      </div>
      <span className="text-xs text-gray-500 dark:text-gray-400">
        {currentStep}/{totalSteps}
      </span>
    </div>
  );
};

// 圆形进度指示器
export const CircularOnboardingProgress: React.FC<{
  currentStep: number;
  totalSteps: number;
  size?: number;
  strokeWidth?: number;
  className?: string;
}> = ({ 
  currentStep, 
  totalSteps, 
  size = 40, 
  strokeWidth = 3,
  className = '' 
}) => {
  const progress = (currentStep / totalSteps) * 100;
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const strokeDasharray = circumference;
  const strokeDashoffset = circumference - (progress / 100) * circumference;
  
  return (
    <div className={`relative ${className}`} style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        className="transform -rotate-90"
      >
        {/* 背景圆 */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="currentColor"
          strokeWidth={strokeWidth}
          fill="none"
          className="text-gray-200 dark:text-gray-700"
        />
        
        {/* 进度圆 */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="currentColor"
          strokeWidth={strokeWidth}
          fill="none"
          strokeDasharray={strokeDasharray}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          className="text-blue-600 transition-all duration-300 ease-out"
        />
      </svg>
      
      {/* 中心文字 */}
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
          {currentStep}/{totalSteps}
        </span>
      </div>
    </div>
  );
};
