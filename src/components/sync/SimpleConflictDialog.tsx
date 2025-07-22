import React, { useState } from 'react';
import { SimpleVersionedTabGroup } from '@/services/simpleOptimisticLock';

interface SimpleConflictDialogProps {
  isOpen: boolean;
  localVersion: SimpleVersionedTabGroup;
  remoteVersion: SimpleVersionedTabGroup;
  conflictInfo: {
    localChanges: string[];
    remoteChanges: string[];
    recommendation: string;
  };
  onResolve: (choice: 'local' | 'remote' | 'merge') => void;
  onCancel: () => void;
}

export const SimpleConflictDialog: React.FC<SimpleConflictDialogProps> = ({
  isOpen,
  localVersion,
  remoteVersion,
  conflictInfo,
  onResolve,
  onCancel
}) => {
  const [selectedChoice, setSelectedChoice] = useState<'local' | 'remote' | 'merge'>('merge');

  if (!isOpen) return null;

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString('zh-CN');
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
            🔄 同步冲突需要处理
          </h2>
          <button
            onClick={onCancel}
            className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            ✕
          </button>
        </div>

        <div className="mb-6">
          <p className="text-gray-600 dark:text-gray-400 mb-2">
            标签组 "<strong>{localVersion.name}</strong>" 在多个设备上被同时修改了。请选择如何处理：
          </p>
          
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-3 mb-4">
            <p className="text-blue-800 dark:text-blue-200 text-sm">
              💡 <strong>建议：</strong>{conflictInfo.recommendation}
            </p>
          </div>
        </div>

        {/* 选择选项 */}
        <div className="space-y-4 mb-6">
          {/* 智能合并选项 */}
          <label className="flex items-start space-x-3 p-4 border rounded-lg cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700">
            <input
              type="radio"
              name="conflict-choice"
              value="merge"
              checked={selectedChoice === 'merge'}
              onChange={(e) => setSelectedChoice(e.target.value as 'merge')}
              className="mt-1"
            />
            <div className="flex-1">
              <div className="font-medium text-gray-900 dark:text-gray-100">
                🤖 智能合并 (推荐)
              </div>
              <div className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                自动合并两个版本的标签，保留所有数据，去除重复项
              </div>
              <div className="text-xs text-green-600 dark:text-green-400 mt-1">
                ✓ 不会丢失数据 ✓ 自动去重 ✓ 保留最新信息
              </div>
            </div>
          </label>

          {/* 本地版本选项 */}
          <label className="flex items-start space-x-3 p-4 border rounded-lg cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700">
            <input
              type="radio"
              name="conflict-choice"
              value="local"
              checked={selectedChoice === 'local'}
              onChange={(e) => setSelectedChoice(e.target.value as 'local')}
              className="mt-1"
            />
            <div className="flex-1">
              <div className="font-medium text-gray-900 dark:text-gray-100">
                📱 使用本设备版本
              </div>
              <div className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                {conflictInfo.localChanges.join(' • ')}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                修改时间: {formatDate(localVersion.updatedAt)}
              </div>
              <div className="mt-2">
                <div className="text-xs text-gray-600 dark:text-gray-400">
                  标签预览: {localVersion.tabs.slice(0, 3).map(tab => tab.title).join(', ')}
                  {localVersion.tabs.length > 3 && ` 等${localVersion.tabs.length}个标签`}
                </div>
              </div>
            </div>
          </label>

          {/* 远程版本选项 */}
          <label className="flex items-start space-x-3 p-4 border rounded-lg cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700">
            <input
              type="radio"
              name="conflict-choice"
              value="remote"
              checked={selectedChoice === 'remote'}
              onChange={(e) => setSelectedChoice(e.target.value as 'remote')}
              className="mt-1"
            />
            <div className="flex-1">
              <div className="font-medium text-gray-900 dark:text-gray-100">
                ☁️ 使用云端版本
              </div>
              <div className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                {conflictInfo.remoteChanges.join(' • ')}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                修改时间: {formatDate(remoteVersion.updatedAt)}
              </div>
              <div className="mt-2">
                <div className="text-xs text-gray-600 dark:text-gray-400">
                  标签预览: {remoteVersion.tabs.slice(0, 3).map(tab => tab.title).join(', ')}
                  {remoteVersion.tabs.length > 3 && ` 等${remoteVersion.tabs.length}个标签`}
                </div>
              </div>
            </div>
          </label>
        </div>

        {/* 操作按钮 */}
        <div className="flex justify-end space-x-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
          >
            取消
          </button>
          <button
            onClick={() => onResolve(selectedChoice)}
            className="px-6 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 font-medium"
          >
            {selectedChoice === 'merge' ? '智能合并' : 
             selectedChoice === 'local' ? '使用本设备版本' : '使用云端版本'}
          </button>
        </div>

        {/* 帮助信息 */}
        <div className="mt-4 p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
          <p className="text-xs text-gray-600 dark:text-gray-400">
            <strong>💡 提示：</strong>
            智能合并会保留两个版本的所有标签，自动去除重复项，是最安全的选择。
            如果您确定要使用特定版本，可以选择对应的选项。
          </p>
        </div>
      </div>
    </div>
  );
};
