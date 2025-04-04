import React, { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { loadGroups } from '@/store/slices/tabSlice';
import { TabGroup } from '@/components/tabs/TabGroup';

export const TabList: React.FC = () => {
  const dispatch = useAppDispatch();
  const { groups, isLoading, error, searchQuery } = useAppSelector(state => state.tabs);

  useEffect(() => {
    dispatch(loadGroups());
  }, [dispatch]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 dark:border-blue-500"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64 text-red-600 dark:text-red-500">
        {error}
      </div>
    );
  }

  const filteredGroups = searchQuery
    ? groups.filter(group => 
        group.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        group.tabs.some(tab => 
          tab.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          tab.url.toLowerCase().includes(searchQuery.toLowerCase())
        )
      )
    : groups;

  if (filteredGroups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 space-y-2 text-gray-500 dark:text-gray-400">
        {searchQuery ? (
          <>
            <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <p>没有找到匹配的标签组</p>
          </>
        ) : (
          <>
            <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
            <p>点击右上角按钮保存标签页</p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {filteredGroups.map(group => (
        <TabGroup key={group.id} group={group} />
      ))}
    </div>
  );
};

export default TabList; 