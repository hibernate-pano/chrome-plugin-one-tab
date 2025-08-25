/**
 * 现代化空状态组件
 * 具有吸引力和信息性的空状态设计
 */

import React from 'react';
import { ModernCard } from '@/shared/components/ModernCard/ModernCard';
import { ModernIcon } from '@/shared/components/ModernIcon/ModernIcon';
import { ModernIllustration, DecorativeElement } from '@/shared/components/ModernIllustration/ModernIllustration';
import { cn } from '@/shared/utils/cn';

interface ModernEmptyStateProps {
  onSaveAllTabs?: () => void;
  onImportData?: () => void;
  onShowTutorial?: () => void;
  showGuidedActions?: boolean;
  className?: string;
}

export const ModernEmptyState: React.FC<ModernEmptyStateProps> = ({
  onSaveAllTabs,
  onImportData,
  onShowTutorial,
  showGuidedActions = true,
  className,
}) => {
  return (
    <div className={cn('relative min-h-[600px] flex items-center justify-center', className)}>
      {/* 背景装饰元素 */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <DecorativeElement
          type="gradient-orb"
          size="lg"
          className="absolute top-10 right-10 opacity-30"
          animated
        />
        <DecorativeElement
          type="dots"
          size="md"
          color="secondary"
          className="absolute bottom-20 left-10 opacity-20"
          animated
        />
        <DecorativeElement
          type="waves"
          size="lg"
          color="accent"
          className="absolute top-1/2 left-0 transform -translate-y-1/2 opacity-10"
          animated
        />
        <DecorativeElement
          type="circles"
          size="md"
          color="primary"
          className="absolute bottom-10 right-20 opacity-15"
          animated
        />
      </div>

      <div className="relative z-10 max-w-2xl mx-auto text-center space-y-8">
        {/* 主要插画 */}
        <div className="flex justify-center">
          <ModernIllustration
            name="emptyTabs"
            size="xl"
            animated
          />
        </div>

        {/* 主要内容 */}
        <div className="space-y-6">
          <div className="space-y-4">
            <h1 className="modern-text-h1 modern-text-primary">
              <span className="gradient-text">开始整理</span>您的标签页
            </h1>
            <p className="modern-text-body-lg modern-text-secondary max-w-lg mx-auto">
              OneTab Plus 帮助您轻松管理浏览器标签页，提升工作效率，让您的数字生活更加井然有序。
            </p>
          </div>

          {/* 特性展示 */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-12">
            <ModernCard
              variant="glass"
              size="md"
              interactive
              className="animate-fade-in-up stagger-1 hover:scale-105 transition-transform duration-300"
            >
              <div className="text-center space-y-4">
                <div className="w-16 h-16 mx-auto bg-gradient-to-br from-blue-500 to-cyan-500 rounded-2xl flex items-center justify-center shadow-lg">
                  <ModernIcon name="tab" size="lg" className="text-white" variant="filled" />
                </div>
                <h3 className="modern-text-h6 modern-text-primary">一键保存</h3>
                <p className="modern-text-body-sm modern-text-secondary">
                  快速保存所有打开的标签页，释放浏览器内存
                </p>
              </div>
            </ModernCard>

            <ModernCard
              variant="glass"
              size="md"
              interactive
              className="animate-fade-in-up stagger-2 hover:scale-105 transition-transform duration-300"
            >
              <div className="text-center space-y-4">
                <div className="w-16 h-16 mx-auto bg-gradient-to-br from-green-500 to-emerald-500 rounded-2xl flex items-center justify-center shadow-lg">
                  <ModernIcon name="folder" size="lg" className="text-white" variant="filled" />
                </div>
                <h3 className="modern-text-h6 modern-text-primary">智能分组</h3>
                <p className="modern-text-body-sm modern-text-secondary">
                  自动识别并分类您的标签页，便于查找和管理
                </p>
              </div>
            </ModernCard>

            <ModernCard
              variant="glass"
              size="md"
              interactive
              className="animate-fade-in-up stagger-3 hover:scale-105 transition-transform duration-300"
            >
              <div className="text-center space-y-4">
                <div className="w-16 h-16 mx-auto bg-gradient-to-br from-purple-500 to-pink-500 rounded-2xl flex items-center justify-center shadow-lg">
                  <ModernIcon name="sync" size="lg" className="text-white" variant="filled" />
                </div>
                <h3 className="modern-text-h6 modern-text-primary">云端同步</h3>
                <p className="modern-text-body-sm modern-text-secondary">
                  跨设备同步您的标签页，随时随地访问
                </p>
              </div>
            </ModernCard>
          </div>

          {/* 操作按钮 */}
          {showGuidedActions && (
            <div className="flex flex-col sm:flex-row gap-4 justify-center items-center mt-12">
              <button
                onClick={onSaveAllTabs}
                className="modern-button-primary px-8 py-4 text-lg font-semibold rounded-2xl shadow-lg hover:shadow-xl transform hover:scale-105 transition-all duration-300 animate-bounce-in animate-delay-1000"
              >
                <ModernIcon name="plus" size="md" className="mr-2" />
                保存当前标签页
              </button>

              <div className="flex gap-3">
                <button
                  onClick={onImportData}
                  className="modern-button-secondary px-6 py-3 rounded-xl hover:scale-105 transition-all duration-300 animate-fade-in animate-delay-1200"
                >
                  <ModernIcon name="download" size="sm" className="mr-2" />
                  导入数据
                </button>

                <button
                  onClick={onShowTutorial}
                  className="modern-button-ghost px-6 py-3 rounded-xl hover:scale-105 transition-all duration-300 animate-fade-in animate-delay-1400"
                >
                  <ModernIcon name="info" size="sm" className="mr-2" />
                  使用教程
                </button>
              </div>
            </div>
          )}

          {/* 统计信息 */}
          <div className="mt-16 p-6 bg-gradient-to-r from-blue-50 to-purple-50 dark:from-blue-900/20 dark:to-purple-900/20 rounded-2xl border border-blue-200 dark:border-blue-800 animate-fade-in animate-delay-1600">
            <div className="grid grid-cols-3 gap-6 text-center">
              <div>
                <div className="modern-text-h3 gradient-text-secondary font-bold">10K+</div>
                <div className="modern-text-caption modern-text-tertiary">活跃用户</div>
              </div>
              <div>
                <div className="modern-text-h3 gradient-text font-bold">1M+</div>
                <div className="modern-text-caption modern-text-tertiary">已保存标签</div>
              </div>
              <div>
                <div className="modern-text-h3 gradient-text-secondary font-bold">99%</div>
                <div className="modern-text-caption modern-text-tertiary">用户满意度</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// 现代化加载状态组件
export const ModernLoadingState: React.FC<{ message?: string; className?: string }> = ({
  message = '加载中...',
  className,
}) => {
  return (
    <div className={cn('flex flex-col items-center justify-center min-h-[400px] space-y-8', className)}>
      {/* 背景装饰 */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <DecorativeElement
          type="gradient-orb"
          size="md"
          className="absolute top-1/4 left-1/4 opacity-20"
          animated
        />
        <DecorativeElement
          type="circles"
          size="sm"
          color="secondary"
          className="absolute bottom-1/4 right-1/4 opacity-15"
          animated
        />
      </div>

      {/* 主加载动画 */}
      <div className="relative">
        <div className="w-20 h-20 relative">
          {/* 外圈 */}
          <div className="absolute inset-0 border-4 border-blue-200 dark:border-blue-800 rounded-full animate-spin">
            <div className="absolute top-0 left-0 w-4 h-4 bg-blue-500 rounded-full transform -translate-x-2 -translate-y-2"></div>
          </div>

          {/* 内圈 */}
          <div className="absolute inset-2 border-4 border-purple-200 dark:border-purple-800 rounded-full animate-spin" style={{ animationDirection: 'reverse', animationDuration: '1.5s' }}>
            <div className="absolute top-0 left-0 w-3 h-3 bg-purple-500 rounded-full transform -translate-x-1.5 -translate-y-1.5"></div>
          </div>

          {/* 中心点 */}
          <div className="absolute inset-6 bg-gradient-to-br from-blue-500 to-purple-500 rounded-full animate-pulse"></div>
        </div>

        {/* 光效 */}
        <div className="absolute inset-0 bg-gradient-to-r from-blue-500/20 via-purple-500/20 to-pink-500/20 rounded-full blur-xl animate-glow"></div>
      </div>

      {/* 加载文本 */}
      <div className="text-center space-y-2">
        <h3 className="modern-text-h5 modern-text-primary">{message}</h3>
        <div className="flex items-center justify-center space-x-1">
          <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce"></div>
          <div className="w-2 h-2 bg-purple-500 rounded-full animate-bounce animate-delay-100"></div>
          <div className="w-2 h-2 bg-pink-500 rounded-full animate-bounce animate-delay-200"></div>
        </div>
      </div>

      {/* 进度指示器 */}
      <div className="w-64 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
        <div className="h-full bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500 rounded-full animate-shimmer"></div>
      </div>
    </div>
  );
};

export { ModernLoadingState };
export default ModernEmptyState;
