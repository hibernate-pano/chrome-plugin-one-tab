/**
 * 现代化标签管理器演示页面
 * 展示全面重新设计的视觉体验和交互效果
 */

import React, { useState } from 'react';
import { ModernTabManager } from './ModernTabManager';
import { ModernCard, ModernCardSpotlight } from '@/shared/components/ModernCard/ModernCard';
import { ModernIcon } from '@/shared/components/ModernIcon/ModernIcon';
import { ModernIllustration, DecorativeElement } from '@/shared/components/ModernIllustration/ModernIllustration';
import { cn } from '@/shared/utils/cn';

interface ModernTabManagerDemoProps {
  className?: string;
}

export const ModernTabManagerDemo: React.FC<ModernTabManagerDemoProps> = ({
  className,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [showDemo, setShowDemo] = useState(false);

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
  };

  const clearSearch = () => {
    setSearchQuery('');
  };

  if (!showDemo) {
    return (
      <div className={cn('relative min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 dark:from-gray-900 dark:via-gray-800 dark:to-purple-900', className)}>
        {/* 背景装饰 */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <DecorativeElement
            type="gradient-orb"
            size="lg"
            className="absolute top-20 right-20 opacity-30"
            animated
          />
          <DecorativeElement
            type="waves"
            size="lg"
            color="primary"
            className="absolute bottom-0 left-0 opacity-20"
            animated
          />
          <DecorativeElement
            type="dots"
            size="md"
            color="secondary"
            className="absolute top-1/2 left-10 opacity-15"
            animated
          />
          <DecorativeElement
            type="circles"
            size="lg"
            color="accent"
            className="absolute bottom-20 right-10 opacity-10"
            animated
          />
        </div>

        <div className="relative z-10 max-w-6xl mx-auto px-6 py-16 text-center space-y-16">
          {/* 主标题区域 */}
          <div className="space-y-8 animate-fade-in-up">
            <div className="space-y-6">
              <h1 className="modern-text-display gradient-text font-bold">
                OneTab Plus
              </h1>
              <h2 className="modern-text-h2 modern-text-primary">
                全新视觉体验
              </h2>
              <p className="modern-text-body-lg modern-text-secondary max-w-3xl mx-auto">
                基于最新设计趋势的全面重新设计，采用现代化配色方案、流畅动画效果、
                精美的视觉元素和直观的交互体验，让标签管理变得更加优雅和高效。
              </p>
            </div>

            {/* 主要插画 */}
            <div className="flex justify-center animate-float">
              <ModernIllustration
                name="tabsOrganized"
                size="2xl"
                animated
              />
            </div>
          </div>

          {/* 特性展示 */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <ModernCardSpotlight
              variant="glass"
              size="lg"
              className="text-center space-y-4 animate-scale-in stagger-1"
            >
              <div className="w-16 h-16 mx-auto bg-gradient-to-br from-blue-500 to-cyan-500 rounded-2xl flex items-center justify-center shadow-xl">
                <ModernIcon name="tab" size="xl" className="text-white" variant="filled" />
              </div>
              <div>
                <h3 className="modern-text-h5 modern-text-primary mb-2">现代配色</h3>
                <p className="modern-text-body-sm modern-text-secondary">
                  采用渐变色和品牌色，优化深色模式体验
                </p>
              </div>
            </ModernCardSpotlight>

            <ModernCard
              variant="gradient"
              size="lg"
              className="text-center space-y-4 animate-scale-in stagger-2"
            >
              <div className="w-16 h-16 mx-auto bg-white/20 rounded-2xl flex items-center justify-center">
                <ModernIcon name="settings" size="xl" className="text-white" variant="filled" />
              </div>
              <div>
                <h3 className="modern-text-h5 text-white mb-2">流畅动画</h3>
                <p className="modern-text-body-sm text-white/80">
                  精心设计的动画效果和微交互反馈
                </p>
              </div>
            </ModernCard>

            <ModernCard
              variant="glass"
              size="lg"
              className="text-center space-y-4 animate-scale-in stagger-3 hover:scale-105 transition-transform duration-300"
            >
              <div className="w-16 h-16 mx-auto bg-gradient-to-br from-green-500 to-emerald-500 rounded-2xl flex items-center justify-center shadow-xl">
                <ModernIcon name="folder" size="xl" className="text-white" variant="filled" />
              </div>
              <div>
                <h3 className="modern-text-h5 modern-text-primary mb-2">精美卡片</h3>
                <p className="modern-text-body-sm modern-text-secondary">
                  立体阴影、毛玻璃效果和创新边框设计
                </p>
              </div>
            </ModernCard>

            <ModernCard
              variant="neon"
              size="lg"
              className="text-center space-y-4 animate-scale-in stagger-4"
            >
              <div className="w-16 h-16 mx-auto bg-cyan-500/20 rounded-2xl flex items-center justify-center border border-cyan-400">
                <ModernIcon name="users" size="xl" className="text-cyan-400" variant="filled" />
              </div>
              <div>
                <h3 className="modern-text-h5 text-cyan-100 mb-2">视觉增强</h3>
                <p className="modern-text-body-sm text-cyan-200/80">
                  缩略图、进度条和状态指示器
                </p>
              </div>
            </ModernCard>
          </div>

          {/* 行动按钮 */}
          <div className="space-y-8 animate-bounce-in animate-delay-1000">
            <button
              onClick={() => setShowDemo(true)}
              className="modern-button-primary px-12 py-6 text-xl font-bold rounded-3xl shadow-2xl hover:shadow-3xl transform hover:scale-105 transition-all duration-500 animate-glow"
            >
              <ModernIcon name="chevronRight" size="lg" className="mr-3" />
              体验全新设计
            </button>
            
            <div className="flex justify-center space-x-6">
              <div className="text-center animate-fade-in animate-delay-1200">
                <div className="modern-text-h4 gradient-text font-bold">10+</div>
                <div className="modern-text-caption modern-text-tertiary">设计改进</div>
              </div>
              <div className="text-center animate-fade-in animate-delay-1400">
                <div className="modern-text-h4 gradient-text-secondary font-bold">50+</div>
                <div className="modern-text-caption modern-text-tertiary">动画效果</div>
              </div>
              <div className="text-center animate-fade-in animate-delay-1600">
                <div className="modern-text-h4 gradient-text font-bold">100%</div>
                <div className="modern-text-caption modern-text-tertiary">视觉提升</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('min-h-screen bg-gradient-to-br from-gray-50 via-white to-blue-50 dark:from-gray-900 dark:via-gray-800 dark:to-blue-900', className)}>
      {/* 顶部导航 */}
      <div className="sticky top-0 z-50 bg-white/80 dark:bg-gray-900/80 backdrop-blur-xl border-b border-gray-200 dark:border-gray-700">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-6">
              <button
                onClick={() => setShowDemo(false)}
                className="modern-button-ghost p-3 rounded-xl hover:scale-110 transition-all duration-300"
              >
                <ModernIcon name="chevronLeft" size="md" />
              </button>
              <div>
                <h1 className="modern-text-h4 gradient-text font-bold">
                  OneTab Plus - 现代设计
                </h1>
                <p className="modern-text-body-sm modern-text-tertiary">
                  全新视觉体验演示
                </p>
              </div>
            </div>

            {/* 搜索框 */}
            <div className="relative">
              <input
                type="text"
                placeholder="搜索标签..."
                className="modern-input pl-12 pr-12 py-3 w-80 rounded-2xl shadow-lg focus:shadow-xl transition-all duration-300"
                onChange={handleSearch}
                value={searchQuery}
              />
              <ModernIcon
                name="search"
                size="md"
                className="absolute left-4 top-1/2 transform -translate-y-1/2 text-gray-400"
              />
              {searchQuery && (
                <button
                  onClick={clearSearch}
                  className="absolute right-4 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:scale-110 transition-all duration-200"
                >
                  <ModernIcon name="close" size="sm" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 主要内容 */}
      <ModernTabManager searchQuery={searchQuery} />
    </div>
  );
};

export default ModernTabManagerDemo;
