import React from 'react';
import { useAppSelector } from '@/store/hooks';

export const TabCounter: React.FC = () => {
  const { groups } = useAppSelector(state => state.tabs);
  
  // 安全检查：确保groups不为undefined
  const safeGroups = groups || [];
  
  // 计算标签组数量
  const groupCount = safeGroups.length;
  
  // 计算标签页总数
  const tabCount = safeGroups.reduce((total, group) => total + (group.tabs?.length || 0), 0);
  
  return (
    <div className="ml-2 flex items-center">
      <span className="text-xs text-gray-500 bg-gray-100 rounded-full px-2 py-0.5 ml-2">
        {groupCount} 组 · {tabCount} 标签
      </span>
    </div>
  );
};

export default TabCounter;
