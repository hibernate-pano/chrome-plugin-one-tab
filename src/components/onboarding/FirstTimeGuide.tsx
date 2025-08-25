/**
 * 首次使用引导组件
 * 为新用户提供完整的使用指导
 */

import React, { useState, useEffect } from 'react';
import { useAppSelector } from '@/app/store/hooks';
import { GuidedActions } from '@/shared/components/GuidedActions/GuidedActions';
import { cn } from '@/shared/utils/cn';

export interface FirstTimeGuideProps {
  onSaveAllTabs?: () => void;
  onImportData?: () => void;
  onShowSettings?: () => void;
  onShowTutorial?: () => void;
  onLogin?: () => void;
  onDismiss?: () => void;
  className?: string;
}

const FirstTimeGuide: React.FC<FirstTimeGuideProps> = ({
  onSaveAllTabs,
  onImportData,
  onShowSettings,
  onShowTutorial,
  onLogin,
  onDismiss,
  className,
}) => {
  const { user } = useAppSelector(state => state.auth);
  const isAuthenticated = !!user;
  const [currentStep, setCurrentStep] = useState(0);
  const [showProgress, setShowProgress] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setShowProgress(true), 500);
    return () => clearTimeout(timer);
  }, []);

  // 定义引导步骤
  const steps = [
    {
      title: '开始使用 OneTab Plus',
      description: '选择一个操作开始管理您的浏览器标签页',
      actions: [
        {
          id: 'save-tabs',
          title: '保存当前标签',
          description: '将当前浏览器中的所有标签页保存到一个组中',
          icon: (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
          ),
          onClick: () => {
            onSaveAllTabs?.();
            setCurrentStep(1);
          },
          variant: 'primary' as const,
          shortcut: 'Ctrl+Shift+S',
        },
        {
          id: 'import-data',
          title: '导入现有数据',
          description: '从其他标签管理工具或备份文件导入数据',
          icon: (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
            </svg>
          ),
          onClick: () => {
            onImportData?.();
            setCurrentStep(1);
          },
          variant: 'secondary' as const,
        },
        {
          id: 'tutorial',
          title: '查看使用教程',
          description: '了解 OneTab Plus 的所有功能和使用技巧',
          icon: (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.746 0 3.332.477 4.5 1.253v13C19.832 18.477 18.246 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
          ),
          onClick: () => {
            onShowTutorial?.();
            setCurrentStep(1);
          },
          variant: 'info' as const,
        },
      ],
    },
    {
      title: '个性化设置',
      description: '根据您的使用习惯调整 OneTab Plus',
      actions: [
        {
          id: 'login',
          title: isAuthenticated ? '已登录' : '登录账户',
          description: isAuthenticated ? '您已登录，可以同步数据' : '登录以在多设备间同步标签页数据',
          icon: (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          ),
          onClick: () => {
            if (!isAuthenticated) {
              onLogin?.();
            }
          },
          variant: (isAuthenticated ? 'success' : 'primary') as 'success' | 'primary',
          disabled: isAuthenticated,
        },
        {
          id: 'settings',
          title: '调整设置',
          description: '自定义快捷键、主题和其他偏好设置',
          icon: (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          ),
          onClick: () => {
            onShowSettings?.();
          },
          variant: 'secondary' as const,
        },
      ],
    },
  ];

  const currentStepData = steps[currentStep];
  const progress = ((currentStep + 1) / steps.length) * 100;

  return (
    <div className={cn('max-w-4xl mx-auto', className)}>
      {/* 进度指示器 */}
      {showProgress && (
        <div className={cn(
          'mb-8 transition-all duration-700 ease-out',
          showProgress ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'
        )}>
          <div className="flex items-center justify-between text-sm text-gray-600 dark:text-gray-400 mb-2">
            <span>设置进度</span>
            <span>{currentStep + 1} / {steps.length}</span>
          </div>
          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
            <div
              className="bg-blue-600 h-2 rounded-full transition-all duration-500 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {/* 当前步骤 */}
      <GuidedActions
        title={currentStepData.title}
        description={currentStepData.description}
        actions={currentStepData.actions}
        layout="grid"
        animated={true}
      />

      {/* 导航按钮 */}
      <div className="flex items-center justify-between mt-8">
        <button
          onClick={() => setCurrentStep(Math.max(0, currentStep - 1))}
          disabled={currentStep === 0}
          className="flex items-center px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          上一步
        </button>

        <div className="flex space-x-2">
          {steps.map((_, index) => (
            <button
              key={index}
              onClick={() => setCurrentStep(index)}
              className={cn(
                'w-3 h-3 rounded-full transition-colors',
                index === currentStep
                  ? 'bg-blue-600'
                  : index < currentStep
                  ? 'bg-green-500'
                  : 'bg-gray-300 dark:bg-gray-600'
              )}
            />
          ))}
        </div>

        <div className="flex space-x-2">
          {currentStep < steps.length - 1 ? (
            <button
              onClick={() => setCurrentStep(Math.min(steps.length - 1, currentStep + 1))}
              className="flex items-center px-4 py-2 text-sm text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300"
            >
              下一步
              <svg className="w-4 h-4 ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          ) : (
            <button
              onClick={onDismiss}
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
            >
              完成设置
            </button>
          )}
        </div>
      </div>

      {/* 跳过选项 */}
      {onDismiss && (
        <div className="text-center mt-6">
          <button
            onClick={onDismiss}
            className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 underline"
          >
            跳过引导，直接开始使用
          </button>
        </div>
      )}
    </div>
  );
};

export { FirstTimeGuide };
export default FirstTimeGuide;
