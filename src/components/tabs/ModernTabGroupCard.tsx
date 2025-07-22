/**
 * 现代化标签组卡片组件
 * 包含缩略图、进度条、状态指示器等视觉增强元素
 */

import React, { useState, useMemo } from 'react';
import { useAppDispatch } from '@/app/store/hooks';
import { deleteGroup, updateGroup } from '@/features/tabs/store/tabGroupsSlice';
import { TabGroup as TabGroupType } from '@/shared/types/tab';
import { ModernCard, ModernCardHeader, ModernCardContent } from '@/shared/components/ModernCard/ModernCard';
import { ModernIcon } from '@/shared/components/ModernIcon/ModernIcon';
import { ModernTabItem } from './ModernTabItem';
import { cn } from '@/shared/utils/cn';

interface ModernTabGroupCardProps {
  group: TabGroupType;
  index: number;
  className?: string;
}

export const ModernTabGroupCard: React.FC<ModernTabGroupCardProps> = ({
  group,
  index,
  className,
}) => {
  const dispatch = useAppDispatch();
  const [isExpanded, setIsExpanded] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [newName, setNewName] = useState(group.name);

  // 计算标签组统计信息
  const stats = useMemo(() => {
    const totalTabs = group.tabs.length;
    const uniqueDomains = new Set(group.tabs.map(tab => {
      try {
        return new URL(tab.url).hostname;
      } catch {
        return 'unknown';
      }
    })).size;
    
    const categories = group.tabs.reduce((acc, tab) => {
      const domain = tab.url.includes('github') ? 'development' :
                    tab.url.includes('stackoverflow') ? 'development' :
                    tab.url.includes('youtube') ? 'media' :
                    tab.url.includes('twitter') ? 'social' :
                    tab.url.includes('linkedin') ? 'social' :
                    'general';
      acc[domain] = (acc[domain] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const primaryCategory = Object.entries(categories).sort(([,a], [,b]) => b - a)[0]?.[0] || 'general';

    return {
      totalTabs,
      uniqueDomains,
      primaryCategory,
      categories,
    };
  }, [group.tabs]);

  // 获取分类颜色和图标
  const getCategoryInfo = (category: string) => {
    const categoryMap = {
      development: { color: 'text-blue-500', bg: 'bg-blue-100 dark:bg-blue-900/20', icon: 'code' },
      media: { color: 'text-red-500', bg: 'bg-red-100 dark:bg-red-900/20', icon: 'play' },
      social: { color: 'text-green-500', bg: 'bg-green-100 dark:bg-green-900/20', icon: 'users' },
      general: { color: 'text-gray-500', bg: 'bg-gray-100 dark:bg-gray-900/20', icon: 'folder' },
    };
    return categoryMap[category as keyof typeof categoryMap] || categoryMap.general;
  };

  const categoryInfo = getCategoryInfo(stats.primaryCategory);

  // 生成缩略图网格
  const generateThumbnailGrid = () => {
    const maxThumbnails = 4;
    const thumbnails = group.tabs.slice(0, maxThumbnails);
    
    return (
      <div className="grid grid-cols-2 gap-1 w-16 h-16 rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800">
        {thumbnails.map((tab, idx) => (
          <div key={idx} className="relative bg-white dark:bg-gray-700 flex items-center justify-center">
            {tab.favicon ? (
              <img
                src={tab.favicon}
                alt=""
                className="w-4 h-4 object-contain"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
            ) : (
              <ModernIcon name="tab" size="xs" className="text-gray-400" />
            )}
          </div>
        ))}
        {group.tabs.length > maxThumbnails && (
          <div className="absolute inset-0 bg-black/20 flex items-center justify-center">
            <span className="text-white text-xs font-bold">+{group.tabs.length - maxThumbnails}</span>
          </div>
        )}
      </div>
    );
  };

  // 处理操作
  const handleToggleExpand = () => setIsExpanded(!isExpanded);
  const handleEditName = () => setIsEditing(true);
  const handleSaveName = () => {
    if (newName.trim() && newName !== group.name) {
      dispatch(updateGroup({
        ...group,
        name: newName.trim(),
        updatedAt: new Date().toISOString(),
      }));
    }
    setIsEditing(false);
  };
  const handleCancelEdit = () => {
    setNewName(group.name);
    setIsEditing(false);
  };
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSaveName();
    else if (e.key === 'Escape') handleCancelEdit();
  };
  const handleDeleteGroup = () => {
    if (window.confirm(`确定要删除标签组"${group.name}"吗？`)) {
      dispatch(deleteGroup(group.id));
    }
  };
  const handleOpenAllTabs = () => {
    group.tabs.forEach(tab => {
      chrome.runtime.sendMessage({
        type: 'OPEN_TAB',
        data: { url: tab.url }
      });
    });
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <ModernCard
      variant="elevated"
      size="lg"
      interactive={false}
      className={cn(
        'group relative overflow-hidden',
        'hover:shadow-2xl hover:-translate-y-1',
        'transition-all duration-500 ease-out',
        className
      )}
    >
      {/* 顶部装饰条 */}
      <div className={cn(
        'absolute top-0 left-0 right-0 h-1 bg-gradient-to-r',
        stats.primaryCategory === 'development' && 'from-blue-500 to-cyan-500',
        stats.primaryCategory === 'media' && 'from-red-500 to-pink-500',
        stats.primaryCategory === 'social' && 'from-green-500 to-emerald-500',
        stats.primaryCategory === 'general' && 'from-gray-500 to-slate-500'
      )} />

      <ModernCardHeader className="pb-4">
        <div className="flex items-start justify-between">
          {/* 左侧：缩略图和基本信息 */}
          <div className="flex items-start space-x-4">
            {/* 缩略图网格 */}
            <div className="relative">
              {generateThumbnailGrid()}
              {/* 分类标识 */}
              <div className={cn(
                'absolute -bottom-1 -right-1 w-6 h-6 rounded-full flex items-center justify-center',
                categoryInfo.bg,
                'border-2 border-white dark:border-gray-800'
              )}>
                <ModernIcon name={categoryInfo.icon} size="xs" className={categoryInfo.color} />
              </div>
            </div>

            {/* 标签组信息 */}
            <div className="flex-1 min-w-0">
              {isEditing ? (
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onBlur={handleSaveName}
                  onKeyDown={handleKeyDown}
                  className="modern-input w-full text-lg font-bold"
                  autoFocus
                />
              ) : (
                <div>
                  <h3
                    className="modern-text-h4 modern-text-primary cursor-pointer hover:text-blue-600 dark:hover:text-blue-400 transition-colors duration-200 mb-2"
                    onClick={handleEditName}
                    title="点击编辑名称"
                  >
                    {group.name}
                  </h3>
                  
                  {/* 统计信息 */}
                  <div className="flex items-center space-x-4 modern-text-body-sm modern-text-secondary">
                    <div className="flex items-center space-x-1">
                      <ModernIcon name="tab" size="sm" className="text-blue-500" />
                      <span className="font-medium">{stats.totalTabs} 个标签</span>
                    </div>
                    <div className="flex items-center space-x-1">
                      <ModernIcon name="globe" size="sm" className="text-green-500" />
                      <span>{stats.uniqueDomains} 个域名</span>
                    </div>
                    <div className="flex items-center space-x-1">
                      <ModernIcon name="clock" size="sm" className="text-gray-400" />
                      <span>{formatDate(group.createdAt)}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 右侧：操作按钮 */}
          <div className="flex items-center space-x-2">
            <button
              onClick={handleToggleExpand}
              className="modern-button-ghost p-2 rounded-full hover:bg-blue-50 dark:hover:bg-blue-900/20 text-blue-600 dark:text-blue-400"
            >
              <ModernIcon
                name={isExpanded ? 'chevronUp' : 'chevronDown'}
                size="md"
                className="transition-transform duration-300"
              />
            </button>
            
            <button
              onClick={handleOpenAllTabs}
              className="modern-button-ghost p-2 rounded-full hover:bg-green-50 dark:hover:bg-green-900/20 text-green-600 dark:text-green-400"
            >
              <ModernIcon name="externalLink" size="md" />
            </button>
            
            <button
              onClick={handleDeleteGroup}
              className="modern-button-ghost p-2 rounded-full hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400"
            >
              <ModernIcon name="delete" size="md" />
            </button>
          </div>
        </div>

        {/* 进度条 - 显示不同类别的分布 */}
        <div className="mt-4">
          <div className="flex items-center justify-between mb-2">
            <span className="modern-text-caption modern-text-tertiary">标签分布</span>
            <span className="modern-text-caption modern-text-tertiary">{stats.totalTabs} 总计</span>
          </div>
          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
            <div className="h-full flex">
              {Object.entries(stats.categories).map(([category, count], idx) => {
                const percentage = (count / stats.totalTabs) * 100;
                const categoryInfo = getCategoryInfo(category);
                return (
                  <div
                    key={category}
                    className={cn(
                      'h-full transition-all duration-500',
                      category === 'development' && 'bg-blue-500',
                      category === 'media' && 'bg-red-500',
                      category === 'social' && 'bg-green-500',
                      category === 'general' && 'bg-gray-500'
                    )}
                    style={{ width: `${percentage}%` }}
                    title={`${category}: ${count} 个标签`}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </ModernCardHeader>

      {/* 展开的标签列表 */}
      {isExpanded && (
        <ModernCardContent>
          <div className="bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900/50 dark:to-gray-800/50 rounded-2xl p-4 space-y-3 border border-gray-200 dark:border-gray-700">
            <div className="flex items-center justify-between mb-3">
              <h4 className="modern-text-body font-semibold modern-text-secondary">
                标签页列表
              </h4>
              <span className="modern-tag-primary">
                {group.tabs.length} 项
              </span>
            </div>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {group.tabs.map((tab, tabIndex) => (
                <ModernTabItem
                  key={tab.id}
                  tab={tab}
                  groupId={group.id}
                  index={tabIndex}
                />
              ))}
            </div>
          </div>
        </ModernCardContent>
      )}
    </ModernCard>
  );
};

export default ModernTabGroupCard;
