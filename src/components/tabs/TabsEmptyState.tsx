/**
 * 标签页空状态组件
 * 专门为标签页列表设计的空状态界面
 */

import React, { useState, useEffect } from 'react';
import { useAppSelector } from '@/app/store/hooks';
import { EmptyState, EmptyStateAction } from '@/shared/components/EmptyState/EmptyState';
import { GuidedActions, GuidedAction } from '@/shared/components/GuidedActions/GuidedActions';
import { cn } from '@/shared/utils/cn';

export interface TabsEmptyStateProps {
  onSaveAllTabs?: () => void;
  onImportData?: () => void;
  onShowTutorial?: () => void;
  onShowSettings?: () => void;
  showGuidedActions?: boolean;
  className?: string;
}

const TabsEmptyState: React.FC<TabsEmptyStateProps> = ({
  onSaveAllTabs,
  onImportData,
  onShowTutorial,
  onShowSettings,
  showGuidedActions = true,
  className,
}) => {
  const { isAuthenticated } = useAppSelector(state => state.auth);
  const [currentTip, setCurrentTip] = useState(0);
  const [showStats, setShowStats] = useState(false);

  // 轮播提示
  const tips = [
    '💡 点击右上角的"保存所有标签"开始使用',
    '🚀 使用快捷键 Ctrl+Shift+O 快速保存标签',
    '📁 可以为标签组添加自定义名称和描述',
    '🔄 登录后可以在多设备间同步标签',
    '🔍 使用搜索功能快速找到需要的标签',
  ];

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTip((prev) => (prev + 1) % tips.length);
    }, 4000);

    return () => clearInterval(timer);
  }, [tips.length]);

  useEffect(() => {
    const timer = setTimeout(() => setShowStats(true), 1000);
    return () => clearTimeout(timer);
  }, []);

  // 构建操作按钮
  const actions: EmptyStateAction[] = [];

  if (onSaveAllTabs) {
    actions.push({
      label: '保存当前标签',
      onClick: onSaveAllTabs,
      variant: 'primary',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
        </svg>
      ),
    });
  }

  if (onImportData) {
    actions.push({
      label: '导入数据',
      onClick: onImportData,
      variant: 'secondary',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
        </svg>
      ),
    });
  }

  if (onShowTutorial) {
    actions.push({
      label: '查看教程',
      onClick: onShowTutorial,
      variant: 'secondary',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
    });
  }

  // 自定义插图
  const customIllustration = (
    <div className="relative">
      {/* 主图标 */}
      <div className="relative">
        <div className="w-20 h-20 bg-gradient-to-br from-blue-100 to-blue-200 dark:from-blue-900/30 dark:to-blue-800/30 rounded-2xl flex items-center justify-center shadow-lg">
          <svg
            className="w-10 h-10 text-blue-600 dark:text-blue-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"
            />
          </svg>
        </div>

        {/* 装饰性元素 */}
        <div className="absolute -top-2 -right-2 w-6 h-6 bg-green-500 rounded-full flex items-center justify-center animate-bounce">
          <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
        </div>

        {/* 浮动的小标签 */}
        <div className="absolute -bottom-1 -left-3 w-8 h-6 bg-white dark:bg-gray-800 rounded shadow-md border border-gray-200 dark:border-gray-700 animate-pulse">
          <div className="w-full h-2 bg-gray-200 dark:bg-gray-600 rounded-t mt-1"></div>
          <div className="w-3/4 h-1 bg-gray-300 dark:bg-gray-500 rounded mx-1 mt-1"></div>
        </div>

        <div className="absolute -bottom-2 right-4 w-8 h-6 bg-white dark:bg-gray-800 rounded shadow-md border border-gray-200 dark:border-gray-700 animate-pulse delay-300">
          <div className="w-full h-2 bg-gray-200 dark:bg-gray-600 rounded-t mt-1"></div>
          <div className="w-2/3 h-1 bg-gray-300 dark:bg-gray-500 rounded mx-1 mt-1"></div>
        </div>
      </div>
    </div>
  );

  // 构建引导性操作
  const guidedActions: GuidedAction[] = [];

  if (onSaveAllTabs) {
    guidedActions.push({
      id: 'save-tabs',
      title: '保存当前标签',
      description: '将浏览器中的所有标签页保存到一个组中，释放内存并整理标签',
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
        </svg>
      ),
      onClick: onSaveAllTabs,
      variant: 'primary',
      shortcut: 'Ctrl+Shift+S',
    });
  }

  if (onImportData) {
    guidedActions.push({
      id: 'import-data',
      title: '导入现有数据',
      description: '从其他标签管理工具或备份文件导入您的标签页数据',
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
        </svg>
      ),
      onClick: onImportData,
      variant: 'secondary',
    });
  }

  if (onShowTutorial) {
    guidedActions.push({
      id: 'tutorial',
      title: '查看使用教程',
      description: '了解 OneTab Plus 的所有功能和使用技巧',
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.746 0 3.332.477 4.5 1.253v13C19.832 18.477 18.246 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
        </svg>
      ),
      onClick: onShowTutorial,
      variant: 'info',
    });
  }

  if (onShowSettings) {
    guidedActions.push({
      id: 'settings',
      title: '个性化设置',
      description: '自定义快捷键、主题和其他偏好设置',
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      ),
      onClick: onShowSettings,
      variant: 'secondary',
    });
  }

  return (
    <div className={cn('relative', className)}>
      {showGuidedActions && guidedActions.length > 0 ? (
        <GuidedActions
          title="开始管理您的标签页"
          description="OneTab Plus 帮助您整理和管理浏览器标签页，提升浏览效率"
          actions={guidedActions}
          layout="grid"
          animated={true}
        />
      ) : (
        <EmptyState
          title="开始管理您的标签页"
          description="OneTab Plus 帮助您整理和管理浏览器标签页，提升浏览效率"
          customIllustration={customIllustration}
          actions={actions}
          animated={true}
          size="lg"
        />
      )}

      {/* 轮播提示 */}
      <div className="mt-8 max-w-md mx-auto">
        <div className="relative h-12 overflow-hidden">
          {tips.map((tip, index) => (
            <div
              key={index}
              className={cn(
                'absolute inset-0 flex items-center justify-center transition-all duration-500 ease-in-out',
                index === currentTip
                  ? 'translate-y-0 opacity-100'
                  : index < currentTip
                  ? '-translate-y-full opacity-0'
                  : 'translate-y-full opacity-0'
              )}
            >
              <p className="text-sm text-gray-600 dark:text-gray-400 text-center px-4">
                {tip}
              </p>
            </div>
          ))}
        </div>

        {/* 指示器 */}
        <div className="flex justify-center space-x-2 mt-4">
          {tips.map((_, index) => (
            <button
              key={index}
              onClick={() => setCurrentTip(index)}
              className={cn(
                'w-2 h-2 rounded-full transition-colors',
                index === currentTip
                  ? 'bg-blue-600'
                  : 'bg-gray-300 dark:bg-gray-600 hover:bg-gray-400 dark:hover:bg-gray-500'
              )}
            />
          ))}
        </div>
      </div>

      {/* 使用统计预览 */}
      {showStats && (
        <div className={cn(
          'mt-8 grid grid-cols-3 gap-4 max-w-sm mx-auto transition-all duration-700 ease-out',
          showStats ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'
        )}>
          <div className="text-center">
            <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">0</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">已保存标签组</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-green-600 dark:text-green-400">0</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">已保存标签</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-purple-600 dark:text-purple-400">0</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">节省内存</div>
          </div>
        </div>
      )}

      {/* 同步状态提示 */}
      {!isAuthenticated && (
        <div className="mt-6 max-w-md mx-auto">
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
            <div className="flex items-start">
              <svg className="w-5 h-5 text-blue-600 dark:text-blue-400 mt-0.5 mr-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div>
                <h4 className="text-sm font-medium text-blue-800 dark:text-blue-200">
                  登录以同步数据
                </h4>
                <p className="text-sm text-blue-700 dark:text-blue-300 mt-1">
                  登录后可以在多设备间同步您的标签页数据
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export { TabsEmptyState };
export default TabsEmptyState;
