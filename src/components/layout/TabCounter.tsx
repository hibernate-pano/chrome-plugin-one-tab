import React from 'react';
import { useAppSelector } from '@/store/hooks';

export const TabCounter: React.FC = () => {
  const { groups } = useAppSelector(state => state.tabs);
  
  // 计算标签组数量
  const groupCount = groups.length;
  
  // 计算标签页总数
  const tabCount = groups.reduce((total, group) => total + group.tabs.length, 0);
  
  return (
    <div className="ml-2 flex items-center">
      <span className="text-xs text-gray-500 bg-gray-100 dark:bg-gray-700 rounded-full px-2 py-0.5 ml-2 whitespace-nowrap">
        {groupCount}组 · {tabCount}标签
      </span>
    </div>
  );
};

export default TabCounter;
