/**
 * 现代化标签组列表组件
 * 支持多种布局模式和流畅的动画效果
 */

import React from 'react';
import { TabGroup as TabGroupType } from '@/shared/types/tab';
import { ModernTabGroupCard } from './ModernTabGroupCard';
import { cn } from '@/shared/utils/cn';

interface ModernTabGroupListProps {
  groups: TabGroupType[];
  useDoubleColumnLayout?: boolean;
  className?: string;
}

export const ModernTabGroupList: React.FC<ModernTabGroupListProps> = ({
  groups,
  useDoubleColumnLayout = false,
  className,
}) => {
  if (groups.length === 0) {
    return null;
  }

  return (
    <div className={cn('space-y-6', className)}>
      {useDoubleColumnLayout ? (
        // 双栏布局 - 瀑布流效果
        <div className="columns-1 md:columns-2 gap-6 space-y-6">
          {groups.map((group, index) => (
            <div
              key={group.id}
              className="break-inside-avoid mb-6 animate-fade-in-up"
              style={{ animationDelay: `${index * 100}ms` }}
            >
              <ModernTabGroupCard
                group={group}
                index={index}
              />
            </div>
          ))}
        </div>
      ) : (
        // 单栏布局 - 交错动画
        <div className="space-y-6">
          {groups.map((group, index) => (
            <div
              key={group.id}
              className="animate-slide-in-up"
              style={{ animationDelay: `${index * 150}ms` }}
            >
              <ModernTabGroupCard
                group={group}
                index={index}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ModernTabGroupList;
