import React from 'react';
import { useAppSelector } from '@/store/hooks';

export const TabCounter: React.FC = () => {
  const { groups } = useAppSelector(state => state.tabs);

  const groupCount = groups.length;
  const tabCount = groups.reduce((total, group) => total + group.tabs.length, 0);

  return (
    <div className="flex items-center gap-2">
      <span className="badge badge-accent">
        {groupCount} 组
      </span>
      <span
        className="text-xs font-medium px-2 py-0.5 rounded-full"
        style={{
          background: 'var(--color-bg-tertiary)',
          color: 'var(--color-text-secondary)'
        }}
      >
        {tabCount} 标签
      </span>
    </div>
  );
};

export default TabCounter;
