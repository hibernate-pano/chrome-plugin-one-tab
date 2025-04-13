import React, { useRef } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { importGroups } from '@/store/slices/tabSlice';
import { storage } from '@/utils/storage';

export const DataManagement: React.FC = () => {
  const dispatch = useAppDispatch();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { groups } = useAppSelector(state => state.tabs);
  const settings = useAppSelector(state => state.settings);

  const handleExport = async () => {
    try {
      const exportData = {
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        data: {
          groups,
          settings
        }
      };

      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: 'application/json'
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `onetab-plus-backup-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('导出数据失败:', error);
      alert('导出数据失败，请重试');
    }
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    try {
      const file = event.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const content = e.target?.result as string;
          const importData = JSON.parse(content);

          // 验证数据格式
          if (!importData.version || !importData.data || !importData.data.groups) {
            throw new Error('无效的数据格式');
          }

          // 先显示成功提示，然后异步导入数据
          alert('数据导入已开始，请稍候...');

          // 异步导入标签组，不阻塞用户界面
          dispatch(importGroups(importData.data.groups))
            .then(() => {
              // 导入设置
              if (importData.data.settings) {
                return storage.setSettings(importData.data.settings);
              }
            })
            .then(() => {
              console.log('数据导入完成');
            })
            .catch(error => {
              console.error('导入数据失败:', error);
              alert('导入过程中发生错误，请检查控制台');
            });
        } catch (error) {
          console.error('导入数据失败:', error);
          alert('导入数据失败，请确保文件格式正确');
        }
      };

      reader.readAsText(file);
    } catch (error) {
      console.error('读取文件失败:', error);
      alert('读取文件失败，请重试');
    } finally {
      // 重置文件输入，以便可以重复导入同一个文件
      event.target.value = '';
    }
  };

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-medium">数据管理</h3>
      <div className="space-y-4">
        <div className="flex items-center space-x-4">
          <button
            onClick={handleExport}
            className="
              px-4 py-2 rounded-lg
              bg-blue-600 hover:bg-blue-700
              dark:bg-blue-500 dark:hover:bg-blue-600
              text-white font-medium
              transition duration-200
              focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50
            "
          >
            导出数据
          </button>
          <button
            onClick={handleImportClick}
            className="
              px-4 py-2 rounded-lg
              bg-gray-600 hover:bg-gray-700
              dark:bg-gray-500 dark:hover:bg-gray-600
              text-white font-medium
              transition duration-200
              focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-opacity-50
            "
          >
            导入数据
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleImport}
            className="hidden"
          />
        </div>
        <div className="text-sm text-gray-500 dark:text-gray-400">
          <p>导出数据将包含：</p>
          <ul className="list-disc list-inside ml-2">
            <li>所有标签组和标签页</li>
            <li>所有设置选项</li>
          </ul>
        </div>
      </div>
    </div>
  );
};

export default DataManagement;