/**
 * 重新设计的标签组卡片组件
 * 基于空标签页面的设计规范，提供一致的视觉体验
 */

import React, { useState } from 'react';
import { useAppDispatch } from '@/app/store/hooks';
import { deleteGroup, updateGroup } from '@/features/tabs/store/tabGroupsSlice';
import { TabGroup as TabGroupType } from '@/shared/types/tab';
import { Card, CardHeader, CardContent, Button, Icon, AnimatedContainer } from '@/shared/components';
import { RedesignedTabItem } from './RedesignedTabItem';
import { cn } from '@/shared/utils/cn';
import { getThemeTransitionClasses, getTextColors } from '@/shared/utils/themeUtils';

interface RedesignedTabGroupCardProps {
  group: TabGroupType;
  index: number;
  className?: string;
}

export const RedesignedTabGroupCard: React.FC<RedesignedTabGroupCardProps> = ({
  group,
  index,
  className,
}) => {
  const dispatch = useAppDispatch();
  const [isExpanded, setIsExpanded] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [newName, setNewName] = useState(group.name);

  // 处理展开/收起
  const handleToggleExpand = () => {
    setIsExpanded(!isExpanded);
  };

  // 处理编辑名称
  const handleEditName = () => {
    setIsEditing(true);
  };

  // 处理保存名称
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

  // 处理取消编辑
  const handleCancelEdit = () => {
    setNewName(group.name);
    setIsEditing(false);
  };

  // 处理键盘事件
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSaveName();
    } else if (e.key === 'Escape') {
      handleCancelEdit();
    }
  };

  // 处理删除标签组
  const handleDeleteGroup = () => {
    if (window.confirm(`确定要删除标签组"${group.name}"吗？`)) {
      dispatch(deleteGroup(group.id));
    }
  };

  // 处理打开所有标签
  const handleOpenAllTabs = () => {
    group.tabs.forEach(tab => {
      chrome.runtime.sendMessage({
        type: 'OPEN_TAB',
        data: { url: tab.url }
      });
    });
  };

  // 格式化创建时间
  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <AnimatedContainer
      animation="slideUp"
      delay={index * 100}
      className={className}
    >
      <Card
        variant="elevated"
        size="lg"
        interactive={false}
        className="overflow-hidden redesigned-card redesigned-gradient-card border-0"
      >
        <CardHeader className="pb-4">
          <div className="flex items-start justify-between">
            {/* 展开/收起按钮 */}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleToggleExpand}
              className="redesigned-button redesigned-button-ghost redesigned-button-round p-2 text-blue-600 dark:text-blue-400"
              icon={
                <Icon
                  name={isExpanded ? 'chevronUp' : 'chevronDown'}
                  size="md"
                  className="transition-transform duration-300"
                />
              }
            />

            {/* 标签组信息 */}
            <div className="flex-1 min-w-0 mx-4">
              {isEditing ? (
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onBlur={handleSaveName}
                  onKeyDown={handleKeyDown}
                  className="w-full px-3 py-2 text-xl font-bold bg-white dark:bg-gray-700 border-2 border-blue-500 dark:border-blue-400 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                  autoFocus
                />
              ) : (
                <div>
                  <h3
                    className="text-xl font-bold text-gray-900 dark:text-gray-100 truncate cursor-pointer hover:text-blue-600 dark:hover:text-blue-400 transition-colors duration-200 mb-2"
                    onClick={handleEditName}
                    title="点击编辑名称"
                  >
                    {group.name}
                  </h3>
                  <div className="flex items-center space-x-6 text-sm text-gray-600 dark:text-gray-400">
                    <div className="flex items-center space-x-1">
                      <Icon name="tab" size="sm" className="text-blue-500" />
                      <span className="font-medium">{group.tabs.length} 个标签</span>
                    </div>
                    <div className="flex items-center space-x-1">
                      <Icon name="clock" size="sm" className="text-gray-400" />
                      <span>{formatDate(group.createdAt)}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* 操作按钮 */}
            <div className="flex items-center space-x-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleOpenAllTabs}
                className="p-2 hover:bg-green-50 dark:hover:bg-green-900/20 text-green-600 dark:text-green-400 rounded-full transition-all duration-200 hover:scale-105"
                icon={<Icon name="tab" size="md" />}
                title="打开所有标签"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDeleteGroup}
                className="p-2 hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400 rounded-full transition-all duration-200 hover:scale-105"
                icon={<Icon name="delete" size="md" />}
                title="删除标签组"
              />
            </div>
          </div>
        </CardHeader>

        {/* 标签列表 */}
        {isExpanded && (
          <CardContent className="pt-0 pb-6">
            <AnimatedContainer animation="slideDown" delay={150}>
              <div className="bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900/50 dark:to-gray-800/50 rounded-xl p-4 space-y-3 border border-gray-200 dark:border-gray-700">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                    标签页列表
                  </h4>
                  <span className="text-xs text-gray-500 dark:text-gray-400 bg-gray-200 dark:bg-gray-700 px-2 py-1 rounded-full">
                    {group.tabs.length} 项
                  </span>
                </div>
                <div className="space-y-2">
                  {group.tabs.map((tab, tabIndex) => (
                    <RedesignedTabItem
                      key={tab.id}
                      tab={tab}
                      groupId={group.id}
                      index={tabIndex}
                    />
                  ))}
                </div>
              </div>
            </AnimatedContainer>
          </CardContent>
        )}
      </Card>
    </AnimatedContainer>
  );
};

export default RedesignedTabGroupCard;
