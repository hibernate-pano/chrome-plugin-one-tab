/**
 * 错误恢复指南组件
 * 为用户提供具体的错误解决建议和操作指引
 */

import React, { useState } from 'react';
import { feedback } from '@/shared/utils/feedback';

export interface RecoveryStep {
  id: string;
  title: string;
  description: string;
  action?: {
    label: string;
    handler: () => void | Promise<void>;
  };
  isCompleted?: boolean;
}

export interface ErrorRecoveryGuideProps {
  error: any;
  steps: RecoveryStep[];
  onClose?: () => void;
  onComplete?: () => void;
  className?: string;
}

export const ErrorRecoveryGuide: React.FC<ErrorRecoveryGuideProps> = ({
  error,
  steps,
  onClose,
  onComplete,
  className = '',
}) => {
  const [completedSteps, setCompletedSteps] = useState<Set<string>>(new Set());
  const [currentStep, setCurrentStep] = useState(0);
  const [isExecuting, setIsExecuting] = useState(false);

  const handleStepAction = async (step: RecoveryStep, index: number) => {
    if (!step.action) return;

    setIsExecuting(true);
    try {
      await step.action.handler();
      
      // 标记步骤为已完成
      setCompletedSteps(prev => new Set(prev).add(step.id));
      
      // 移动到下一步
      if (index < steps.length - 1) {
        setCurrentStep(index + 1);
      } else {
        // 所有步骤完成
        feedback.success('问题解决步骤已完成');
        if (onComplete) {
          onComplete();
        }
      }
    } catch (actionError) {
      feedback.error(`执行步骤失败: ${actionError.message}`);
    } finally {
      setIsExecuting(false);
    }
  };

  const handleSkipStep = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(currentStep + 1);
    }
  };

  const allStepsCompleted = steps.every(step => completedSteps.has(step.id));

  return (
    <div className={`bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 ${className}`}>
      {/* 头部 */}
      <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <svg
                className="h-6 w-6 text-blue-600 dark:text-blue-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>
            <div className="ml-3">
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                问题解决指南
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                按照以下步骤解决遇到的问题
              </p>
            </div>
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            >
              <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* 进度指示器 */}
      <div className="px-6 py-4 bg-gray-50 dark:bg-gray-900/50">
        <div className="flex items-center justify-between text-sm text-gray-600 dark:text-gray-400">
          <span>进度: {completedSteps.size} / {steps.length}</span>
          <span>{Math.round((completedSteps.size / steps.length) * 100)}%</span>
        </div>
        <div className="mt-2 w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
          <div
            className="bg-blue-600 h-2 rounded-full transition-all duration-300"
            style={{ width: `${(completedSteps.size / steps.length) * 100}%` }}
          />
        </div>
      </div>

      {/* 步骤列表 */}
      <div className="px-6 py-4 space-y-4">
        {steps.map((step, index) => {
          const isCompleted = completedSteps.has(step.id);
          const isCurrent = index === currentStep;
          const isPending = index > currentStep;

          return (
            <div
              key={step.id}
              className={`relative flex items-start p-4 rounded-lg border ${
                isCompleted
                  ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'
                  : isCurrent
                  ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800'
                  : 'bg-gray-50 dark:bg-gray-900/50 border-gray-200 dark:border-gray-700'
              }`}
            >
              {/* 步骤图标 */}
              <div className="flex-shrink-0">
                {isCompleted ? (
                  <div className="w-8 h-8 bg-green-600 rounded-full flex items-center justify-center">
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                ) : isCurrent ? (
                  <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center">
                    <span className="text-white text-sm font-medium">{index + 1}</span>
                  </div>
                ) : (
                  <div className="w-8 h-8 bg-gray-300 dark:bg-gray-600 rounded-full flex items-center justify-center">
                    <span className="text-gray-600 dark:text-gray-400 text-sm font-medium">{index + 1}</span>
                  </div>
                )}
              </div>

              {/* 步骤内容 */}
              <div className="ml-4 flex-1">
                <h4 className={`text-sm font-medium ${
                  isCompleted
                    ? 'text-green-800 dark:text-green-200'
                    : isCurrent
                    ? 'text-blue-800 dark:text-blue-200'
                    : 'text-gray-600 dark:text-gray-400'
                }`}>
                  {step.title}
                </h4>
                <p className={`mt-1 text-sm ${
                  isCompleted
                    ? 'text-green-700 dark:text-green-300'
                    : isCurrent
                    ? 'text-blue-700 dark:text-blue-300'
                    : 'text-gray-500 dark:text-gray-500'
                }`}>
                  {step.description}
                </p>

                {/* 操作按钮 */}
                {step.action && isCurrent && !isCompleted && (
                  <div className="mt-3 flex space-x-2">
                    <button
                      onClick={() => handleStepAction(step, index)}
                      disabled={isExecuting}
                      className="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isExecuting ? '执行中...' : step.action.label}
                    </button>
                    <button
                      onClick={handleSkipStep}
                      className="bg-gray-300 dark:bg-gray-600 text-gray-700 dark:text-gray-300 px-4 py-2 rounded text-sm hover:bg-gray-400 dark:hover:bg-gray-500"
                    >
                      跳过
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* 底部操作 */}
      <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50">
        {allStepsCompleted ? (
          <div className="flex items-center justify-between">
            <div className="flex items-center text-green-600 dark:text-green-400">
              <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-sm font-medium">所有步骤已完成</span>
            </div>
            <button
              onClick={onClose}
              className="bg-green-600 text-white px-4 py-2 rounded text-sm hover:bg-green-700"
            >
              完成
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              如果问题仍未解决，请联系技术支持
            </p>
            <button
              onClick={() => {
                feedback.info('技术支持联系方式已复制到剪贴板');
                navigator.clipboard?.writeText('support@onetabplus.com');
              }}
              className="text-blue-600 dark:text-blue-400 text-sm hover:underline"
            >
              联系支持
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ErrorRecoveryGuide;
