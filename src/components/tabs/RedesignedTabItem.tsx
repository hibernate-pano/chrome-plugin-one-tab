/**
 * 重新设计的标签项组件
 * 基于空标签页面的设计规范，提供一致的视觉体验
 */

import React from 'react';
import { useAppDispatch } from '@/app/store/hooks';
import { updateGroup } from '@/features/tabs/store/tabGroupsSlice';
import { Tab } from '@/shared/types/tab';
import { Button, Icon, AnimatedContainer } from '@/shared/components';
import { cn } from '@/shared/utils/cn';

interface RedesignedTabItemProps {
  tab: Tab;
  groupId: string;
  index: number;
  className?: string;
}

export const RedesignedTabItem: React.FC<RedesignedTabItemProps> = ({
  tab,
  groupId,
  index,
  className,
}) => {
  const dispatch = useAppDispatch();

  // 处理打开标签
  const handleOpenTab = () => {
    chrome.runtime.sendMessage({
      type: 'OPEN_TAB',
      data: { url: tab.url }
    });
  };

  // 处理删除标签
  const handleDeleteTab = () => {
    // TODO: 实现删除单个标签的逻辑
    console.log('删除标签:', tab.id);
  };

  // 获取域名
  const getDomain = (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  };

  // 处理favicon错误
  const handleFaviconError = (e: React.SyntheticEvent<HTMLImageElement>) => {
    e.currentTarget.style.display = 'none';
  };

  return (
    <AnimatedContainer
      animation="slideUp"
      delay={index * 50}
      className={className}
    >
      <div
        className={cn(
          'group relative bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700',
          'hover:border-blue-400 dark:hover:border-blue-500 hover:shadow-md hover:scale-[1.02]',
          'transition-all duration-300 focus-within:ring-2 focus-within:ring-blue-500 focus-within:ring-offset-2',
          'overflow-hidden'
        )}
      >
        <div className="flex items-center p-4">
          {/* Favicon */}
          <div className="flex-shrink-0 w-6 h-6 mr-4">
            {tab.favicon ? (
              <img
                src={tab.favicon}
                alt=""
                className="w-6 h-6 rounded-lg shadow-sm"
                onError={handleFaviconError}
              />
            ) : (
              <div className="w-6 h-6 bg-gradient-to-br from-blue-100 to-blue-200 dark:from-blue-900 dark:to-blue-800 rounded-lg flex items-center justify-center shadow-sm">
                <Icon name="tab" size="sm" className="text-blue-600 dark:text-blue-400" />
              </div>
            )}
          </div>

          {/* 标签信息 */}
          <div className="flex-1 min-w-0">
            <button
              onClick={handleOpenTab}
              className="block w-full text-left focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 rounded-lg p-1 -m-1"
            >
              <div className="font-semibold text-gray-900 dark:text-gray-100 truncate hover:text-blue-600 dark:hover:text-blue-400 transition-colors duration-200 mb-1">
                {tab.title || '无标题'}
              </div>
              <div className="text-sm text-gray-600 dark:text-gray-400 truncate flex items-center">
                <Icon name="link" size="xs" className="mr-1 flex-shrink-0" />
                {getDomain(tab.url)}
              </div>
            </button>
          </div>

          {/* 操作按钮 */}
          <div className="flex-shrink-0 ml-3 opacity-0 group-hover:opacity-100 transition-all duration-300 transform group-hover:translate-x-0 translate-x-2">
            <div className="flex items-center space-x-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleOpenTab}
                className="p-2 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-blue-600 dark:text-blue-400 rounded-full transition-all duration-200 hover:scale-110"
                icon={<Icon name="chevronRight" size="sm" />}
                title="打开标签"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDeleteTab}
                className="p-2 hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400 rounded-full transition-all duration-200 hover:scale-110"
                icon={<Icon name="close" size="sm" />}
                title="删除标签"
              />
            </div>
          </div>
        </div>
      </div>
    </AnimatedContainer>
  );
};

export default RedesignedTabItem;
