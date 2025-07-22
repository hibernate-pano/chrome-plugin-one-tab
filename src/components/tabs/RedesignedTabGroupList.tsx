/**
 * 重新设计的标签组列表组件
 * 基于空标签页面的设计规范，提供一致的视觉体验
 */

import React from 'react';
import { TabGroup as TabGroupType } from '@/shared/types/tab';
import { RedesignedTabGroupCard } from './RedesignedTabGroupCard';
import { cn } from '@/shared/utils/cn';

interface RedesignedTabGroupListProps {
  groups: TabGroupType[];
  useDoubleColumnLayout?: boolean;
  className?: string;
}

export const RedesignedTabGroupList: React.FC<RedesignedTabGroupListProps> = ({
  groups,
  useDoubleColumnLayout = false,
  className,
}) => {
  if (groups.length === 0) {
    return null;
  }

  return (
    <div className={cn('space-y-4', className)}>
      {useDoubleColumnLayout ? (
        // 双栏布局
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {groups.map((group, index) => (
            <RedesignedTabGroupCard
              key={group.id}
              group={group}
              index={index}
            />
          ))}
        </div>
      ) : (
        // 单栏布局
        <div className="space-y-4">
          {groups.map((group, index) => (
            <RedesignedTabGroupCard
              key={group.id}
              group={group}
              index={index}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default RedesignedTabGroupList;
