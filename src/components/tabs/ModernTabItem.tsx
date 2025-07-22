/**
 * 现代化标签项组件
 * 具有精美的视觉效果和流畅的交互体验
 */

import React, { useState } from 'react';
import { useAppDispatch } from '@/app/store/hooks';
import { updateGroup } from '@/features/tabs/store/tabGroupsSlice';
import { Tab } from '@/shared/types/tab';
import { ModernIcon } from '@/shared/components/ModernIcon/ModernIcon';
import { cn } from '@/shared/utils/cn';

interface ModernTabItemProps {
  tab: Tab;
  groupId: string;
  index: number;
  className?: string;
}

export const ModernTabItem: React.FC<ModernTabItemProps> = ({
  tab,
  groupId,
  index,
  className,
}) => {
  const dispatch = useAppDispatch();
  const [isHovered, setIsHovered] = useState(false);

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

  // 获取域名类型和颜色
  const getDomainInfo = (url: string) => {
    const domain = getDomain(url).toLowerCase();
    
    if (domain.includes('github')) {
      return { type: 'development', color: 'text-gray-800', bg: 'bg-gray-100', icon: 'code' };
    } else if (domain.includes('stackoverflow')) {
      return { type: 'development', color: 'text-orange-600', bg: 'bg-orange-100', icon: 'code' };
    } else if (domain.includes('youtube')) {
      return { type: 'media', color: 'text-red-600', bg: 'bg-red-100', icon: 'play' };
    } else if (domain.includes('twitter') || domain.includes('linkedin')) {
      return { type: 'social', color: 'text-blue-600', bg: 'bg-blue-100', icon: 'users' };
    } else {
      return { type: 'general', color: 'text-gray-600', bg: 'bg-gray-100', icon: 'globe' };
    }
  };

  const domainInfo = getDomainInfo(tab.url);

  // 处理favicon错误
  const handleFaviconError = (e: React.SyntheticEvent<HTMLImageElement>) => {
    e.currentTarget.style.display = 'none';
  };

  return (
    <div
      className={cn(
        'group relative modern-card-minimal p-4 rounded-2xl',
        'bg-white dark:bg-gray-800',
        'border border-gray-200 dark:border-gray-700',
        'hover:border-blue-300 dark:hover:border-blue-600',
        'hover:shadow-lg hover:shadow-blue-500/10',
        'hover:-translate-y-0.5',
        'transition-all duration-300 ease-out',
        'cursor-pointer',
        className
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={handleOpenTab}
    >
      {/* 顶部装饰条 */}
      <div className={cn(
        'absolute top-0 left-0 right-0 h-0.5 rounded-t-2xl transition-all duration-300',
        domainInfo.type === 'development' && 'bg-gradient-to-r from-blue-500 to-cyan-500',
        domainInfo.type === 'media' && 'bg-gradient-to-r from-red-500 to-pink-500',
        domainInfo.type === 'social' && 'bg-gradient-to-r from-green-500 to-emerald-500',
        domainInfo.type === 'general' && 'bg-gradient-to-r from-gray-500 to-slate-500',
        isHovered ? 'h-1' : 'h-0.5'
      )} />

      <div className="flex items-center space-x-4">
        {/* Favicon 和类型指示器 */}
        <div className="relative flex-shrink-0">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-700 dark:to-gray-800 flex items-center justify-center shadow-sm">
            {tab.favicon ? (
              <img
                src={tab.favicon}
                alt=""
                className="w-6 h-6 rounded-lg"
                onError={handleFaviconError}
              />
            ) : (
              <ModernIcon 
                name="tab" 
                size="md" 
                className="text-gray-500 dark:text-gray-400" 
                variant="filled"
              />
            )}
          </div>
          
          {/* 类型指示器 */}
          <div className={cn(
            'absolute -bottom-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center',
            'border-2 border-white dark:border-gray-800',
            'shadow-sm',
            domainInfo.bg
          )}>
            <ModernIcon 
              name={domainInfo.icon} 
              size="xs" 
              className={domainInfo.color}
              variant="filled"
            />
          </div>
        </div>

        {/* 标签信息 */}
        <div className="flex-1 min-w-0">
          <div className="modern-text-body font-semibold modern-text-primary truncate mb-1 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors duration-200">
            {tab.title || '无标题'}
          </div>
          <div className="flex items-center space-x-2 modern-text-body-sm modern-text-tertiary">
            <ModernIcon name="globe" size="xs" className="flex-shrink-0" />
            <span className="truncate">{getDomain(tab.url)}</span>
          </div>
        </div>

        {/* 操作按钮 */}
        <div className={cn(
          'flex items-center space-x-2 transition-all duration-300',
          isHovered ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-2'
        )}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleOpenTab();
            }}
            className="modern-button-ghost p-2 rounded-xl hover:bg-blue-50 dark:hover:bg-blue-900/20 text-blue-600 dark:text-blue-400 hover:scale-110 transition-all duration-200"
            title="打开标签"
          >
            <ModernIcon name="externalLink" size="sm" variant="outline" />
          </button>
          
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleDeleteTab();
            }}
            className="modern-button-ghost p-2 rounded-xl hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400 hover:scale-110 transition-all duration-200"
            title="删除标签"
          >
            <ModernIcon name="close" size="sm" variant="outline" />
          </button>
        </div>
      </div>

      {/* 悬停时的光效 */}
      {isHovered && (
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-blue-50/50 to-transparent dark:via-blue-900/10 rounded-2xl pointer-events-none" />
      )}
    </div>
  );
};

export default ModernTabItem;
