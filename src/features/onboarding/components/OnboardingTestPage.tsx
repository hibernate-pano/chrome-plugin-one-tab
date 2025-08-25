/**
 * 新手引导测试页面
 * 用于开发环境下测试引导系统的各种功能
 */

import React from 'react';
import { useOnboarding } from './OnboardingProvider';
import { useAppSelector, useAppDispatch } from '@/app/store/hooks';
import { resetOnboarding } from '../store/onboardingSlice';

export const OnboardingTestPage: React.FC = () => {
  const {
    isActive,
    currentStep,
    currentStepIndex,
    totalSteps,
    isCompleted,
    start,
    stop,
    next,
    prev,
    skip,
    complete,
    isFirstTime,
    canGoNext,
    canGoPrev,
    canSkip,
  } = useOnboarding();
  
  const dispatch = useAppDispatch();
  const onboardingState = useAppSelector(state => state.onboarding);
  
  const handleReset = () => {
    dispatch(resetOnboarding());
  };
  
  const handleForceStart = () => {
    start(true);
  };
  
  return (
    <div className="p-6 bg-white dark:bg-gray-800 rounded-lg shadow-lg max-w-2xl mx-auto">
      <h2 className="text-2xl font-bold mb-6 text-gray-900 dark:text-white">
        新手引导测试控制台
      </h2>
      
      {/* 状态显示 */}
      <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
        <h3 className="text-lg font-semibold mb-3 text-gray-900 dark:text-white">
          当前状态
        </h3>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="font-medium text-gray-700 dark:text-gray-300">引导状态:</span>
            <span className={`ml-2 px-2 py-1 rounded text-xs ${
              isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
            }`}>
              {isActive ? '进行中' : '未激活'}
            </span>
          </div>
          <div>
            <span className="font-medium text-gray-700 dark:text-gray-300">完成状态:</span>
            <span className={`ml-2 px-2 py-1 rounded text-xs ${
              isCompleted ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-800'
            }`}>
              {isCompleted ? '已完成' : '未完成'}
            </span>
          </div>
          <div>
            <span className="font-medium text-gray-700 dark:text-gray-300">首次使用:</span>
            <span className={`ml-2 px-2 py-1 rounded text-xs ${
              isFirstTime ? 'bg-yellow-100 text-yellow-800' : 'bg-gray-100 text-gray-800'
            }`}>
              {isFirstTime ? '是' : '否'}
            </span>
          </div>
          <div>
            <span className="font-medium text-gray-700 dark:text-gray-300">当前步骤:</span>
            <span className="ml-2 text-gray-900 dark:text-white">
              {currentStepIndex + 1} / {totalSteps}
            </span>
          </div>
        </div>
        
        {currentStep && (
          <div className="mt-4 p-3 bg-white dark:bg-gray-600 rounded border">
            <h4 className="font-medium text-gray-900 dark:text-white mb-1">
              {currentStep.title}
            </h4>
            <p className="text-sm text-gray-600 dark:text-gray-300">
              {currentStep.description}
            </p>
            <div className="mt-2 flex space-x-2 text-xs">
              <span className="px-2 py-1 bg-blue-100 text-blue-800 rounded">
                {currentStep.action || 'none'}
              </span>
              <span className="px-2 py-1 bg-purple-100 text-purple-800 rounded">
                {currentStep.position || 'center'}
              </span>
              {currentStep.canSkip && (
                <span className="px-2 py-1 bg-green-100 text-green-800 rounded">
                  可跳过
                </span>
              )}
            </div>
          </div>
        )}
      </div>
      
      {/* 控制按钮 */}
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-3 text-gray-900 dark:text-white">
          控制操作
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => start()}
            disabled={isActive}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
          >
            开始引导
          </button>
          
          <button
            onClick={handleForceStart}
            className="px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 transition-colors"
          >
            强制开始
          </button>
          
          <button
            onClick={stop}
            disabled={!isActive}
            className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
          >
            停止引导
          </button>
          
          <button
            onClick={handleReset}
            className="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700 transition-colors"
          >
            重置状态
          </button>
        </div>
      </div>
      
      {/* 步骤控制 */}
      {isActive && (
        <div className="mb-6">
          <h3 className="text-lg font-semibold mb-3 text-gray-900 dark:text-white">
            步骤控制
          </h3>
          <div className="flex space-x-3">
            <button
              onClick={prev}
              disabled={!canGoPrev}
              className="px-3 py-1.5 bg-gray-500 text-white rounded hover:bg-gray-600 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors text-sm"
            >
              上一步
            </button>
            
            <button
              onClick={next}
              disabled={!canGoNext}
              className="px-3 py-1.5 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors text-sm"
            >
              下一步
            </button>
            
            <button
              onClick={skip}
              disabled={!canSkip}
              className="px-3 py-1.5 bg-yellow-500 text-white rounded hover:bg-yellow-600 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors text-sm"
            >
              跳过
            </button>
            
            <button
              onClick={() => complete()}
              className="px-3 py-1.5 bg-green-500 text-white rounded hover:bg-green-600 transition-colors text-sm"
            >
              完成当前步骤
            </button>
          </div>
        </div>
      )}
      
      {/* 用户进度 */}
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-3 text-gray-900 dark:text-white">
          用户进度
        </h3>
        <div className="grid grid-cols-2 gap-2 text-sm">
          {Object.entries(onboardingState.userProgress).map(([key, value]) => {
            if (Array.isArray(value)) {
              return (
                <div key={key} className="col-span-2">
                  <span className="font-medium text-gray-700 dark:text-gray-300">
                    {key}:
                  </span>
                  <span className="ml-2 text-gray-600 dark:text-gray-400">
                    [{value.join(', ')}]
                  </span>
                </div>
              );
            }
            return (
              <div key={key}>
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  {key}:
                </span>
                <span className={`ml-2 px-2 py-1 rounded text-xs ${
                  value ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                }`}>
                  {value ? '是' : '否'}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      
      {/* 调试信息 */}
      <details className="mb-4">
        <summary className="cursor-pointer text-lg font-semibold text-gray-900 dark:text-white mb-2">
          调试信息
        </summary>
        <pre className="bg-gray-100 dark:bg-gray-700 p-4 rounded text-xs overflow-auto max-h-60">
          {JSON.stringify(onboardingState, null, 2)}
        </pre>
      </details>
      
      {/* 使用说明 */}
      <div className="text-sm text-gray-600 dark:text-gray-400">
        <h4 className="font-medium mb-2">使用说明:</h4>
        <ul className="list-disc list-inside space-y-1">
          <li>点击"开始引导"启动正常引导流程</li>
          <li>点击"强制开始"可以重新开始引导（即使已完成）</li>
          <li>使用步骤控制按钮可以手动控制引导进度</li>
          <li>引导过程中可以使用键盘快捷键：Esc退出，←→控制步骤</li>
          <li>状态会自动保存到localStorage中</li>
        </ul>
      </div>
    </div>
  );
};
