/**
 * 重新设计的标签管理器演示页面
 * 展示基于空标签页面设计规范的新UI
 */

import React, { useState } from 'react';
import { RedesignedTabManager } from './RedesignedTabManager';
import { Button, Icon, ResponsiveContainer } from '@/shared/components';
import { cn } from '@/shared/utils/cn';

interface RedesignedTabManagerDemoProps {
  className?: string;
}

export const RedesignedTabManagerDemo: React.FC<RedesignedTabManagerDemoProps> = ({
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
      <ResponsiveContainer maxWidth="lg" padding="lg" className={className}>
        <div className="text-center space-y-6">
          <div className="space-y-4">
            <h1 className="text-4xl font-bold text-gray-900 dark:text-gray-100">
              重新设计的标签管理器
            </h1>
            <p className="text-xl text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
              基于空标签页面的设计规范，提供一致的Material Design体验
            </p>
          </div>

          <div className="bg-gradient-to-r from-blue-50 to-green-50 dark:from-blue-900/20 dark:to-green-900/20 rounded-xl p-8 border border-blue-200 dark:border-blue-800">
            <div className="space-y-4">
              <div className="w-16 h-16 bg-blue-500 rounded-full flex items-center justify-center mx-auto">
                <Icon name="tab" size="xl" className="text-white" />
              </div>
              <h3 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                全新的设计体验
              </h3>
              <p className="text-gray-600 dark:text-gray-400 max-w-md mx-auto">
                统一的视觉风格、流畅的动画效果、完善的主题适配和响应式设计
              </p>
              <Button
                variant="primary"
                size="lg"
                onClick={() => setShowDemo(true)}
                className="redesigned-button redesigned-button-primary"
                icon={<Icon name="chevronRight" size="md" />}
              >
                查看演示
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-12">
            <div className="text-center space-y-3">
              <div className="w-12 h-12 bg-green-100 dark:bg-green-900/20 rounded-lg flex items-center justify-center mx-auto">
                <Icon name="check" size="lg" className="text-green-600 dark:text-green-400" />
              </div>
              <h4 className="font-semibold text-gray-900 dark:text-gray-100">统一设计</h4>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                与空标签页面保持一致的Material Design风格
              </p>
            </div>
            <div className="text-center space-y-3">
              <div className="w-12 h-12 bg-blue-100 dark:bg-blue-900/20 rounded-lg flex items-center justify-center mx-auto">
                <Icon name="sync" size="lg" className="text-blue-600 dark:text-blue-400" />
              </div>
              <h4 className="font-semibold text-gray-900 dark:text-gray-100">流畅动画</h4>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                精心设计的动画效果和交互反馈
              </p>
            </div>
            <div className="text-center space-y-3">
              <div className="w-12 h-12 bg-purple-100 dark:bg-purple-900/20 rounded-lg flex items-center justify-center mx-auto">
                <Icon name="settings" size="lg" className="text-purple-600 dark:text-purple-400" />
              </div>
              <h4 className="font-semibold text-gray-900 dark:text-gray-100">主题适配</h4>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                完美支持浅色、深色和自动模式
              </p>
            </div>
          </div>
        </div>
      </ResponsiveContainer>
    );
  }

  return (
    <div className={cn('min-h-screen bg-gray-50 dark:bg-gray-900', className)}>
      {/* 顶部导航 */}
      <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 sticky top-0 z-10">
        <ResponsiveContainer maxWidth="xl" padding="md">
          <div className="flex items-center justify-between py-4">
            <div className="flex items-center space-x-4">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowDemo(false)}
                icon={<Icon name="chevronLeft" size="md" />}
                className="redesigned-button redesigned-button-ghost"
              >
                返回
              </Button>
              <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">
                重新设计的标签管理器
              </h1>
            </div>

            {/* 搜索框 */}
            <div className="flex items-center space-x-4">
              <div className="relative">
                <input
                  type="text"
                  placeholder="搜索标签..."
                  className="pl-10 pr-10 py-2 w-64 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-200 dark:bg-gray-700 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent redesigned-input"
                  onChange={handleSearch}
                  value={searchQuery}
                />
                <Icon
                  name="search"
                  size="md"
                  className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400"
                />
                {searchQuery && (
                  <button
                    onClick={clearSearch}
                    className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                  >
                    <Icon name="close" size="sm" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </ResponsiveContainer>
      </div>

      {/* 主要内容 */}
      <div className="py-8">
        <RedesignedTabManager searchQuery={searchQuery} />
      </div>
    </div>
  );
};

export default RedesignedTabManagerDemo;
