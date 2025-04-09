import React, { useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { loadGroups, deleteGroup } from '@/store/slices/tabSlice';
import { TabGroup } from '@/components/tabs/TabGroup';
import { TabGroup as TabGroupType } from '@/types/tab';

interface TabListProps {
  searchQuery: string;
}

export const TabList: React.FC<TabListProps> = ({ searchQuery }) => {
  const dispatch = useAppDispatch();
  const { groups, isLoading, error } = useAppSelector(state => state.tabs);
  const [isRestoreAllModalOpen, setIsRestoreAllModalOpen] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<TabGroupType | null>(null);

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

  const handleRestoreAll = () => {
    if (!selectedGroup) return;

    // 打开所有标签页
    selectedGroup.tabs.forEach(tab => {
      chrome.tabs.create({ url: tab.url });
    });

    // 如果标签组没有锁定，则删除标签组
    if (!selectedGroup.isLocked) {
      dispatch(deleteGroup(selectedGroup.id));
    }

    setIsRestoreAllModalOpen(false);
    setSelectedGroup(null);
  };

  return (
    <div className="space-y-4">
      {/* 标签组列表 */}
      {filteredGroups.map(group => (
        <TabGroup key={group.id} group={group} />
      ))}

      {/* 恢复所有标签确认对话框 */}
      {isRestoreAllModalOpen && selectedGroup && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full">
            <h3 className="text-lg font-medium mb-4">恢复所有标签页</h3>
            <p className="mb-4">确定要恢复标签组 "{selectedGroup.name}" 中的所有 {selectedGroup.tabs.length} 个标签页吗？</p>

            <div className="flex justify-end space-x-2">
              <button
                onClick={() => {
                  setIsRestoreAllModalOpen(false);
                  setSelectedGroup(null);
                }}
                className="px-4 py-2 rounded-lg bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600"
              >
                取消
              </button>
              <button
                onClick={handleRestoreAll}
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 text-white"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TabList;
