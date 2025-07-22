import React, { useState, useEffect } from 'react';
import { databaseSchemaManager } from '@/services/databaseSchemaManager';

interface DatabaseMigrationPromptProps {
  isOpen: boolean;
  onClose: () => void;
  onMigrationComplete?: () => void;
}

export const DatabaseMigrationPrompt: React.FC<DatabaseMigrationPromptProps> = ({
  isOpen,
  onClose,
  onMigrationComplete
}) => {
  const [migrationSQL, setMigrationSQL] = useState<string>('');
  const [advice, setAdvice] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (isOpen) {
      loadMigrationInfo();
    }
  }, [isOpen]);

  const loadMigrationInfo = async () => {
    setIsLoading(true);
    try {
      const [sql, migrationAdvice] = await Promise.all([
        databaseSchemaManager.generateMigrationSQL(),
        databaseSchemaManager.getMigrationAdvice()
      ]);
      
      setMigrationSQL(sql);
      setAdvice(migrationAdvice);
    } catch (error) {
      console.error('加载迁移信息失败:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(migrationSQL);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('复制失败:', error);
    }
  };

  const handleComplete = () => {
    // 清除schema缓存，强制重新检查
    databaseSchemaManager.clearCache();
    onMigrationComplete?.();
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-4xl w-full mx-4 max-h-[80vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
            🔧 数据库迁移需要
          </h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            ✕
          </button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
            <span className="ml-2 text-gray-600 dark:text-gray-400">检查数据库状态...</span>
          </div>
        ) : (
          <>
            <div className="mb-6">
              <p className="text-gray-600 dark:text-gray-400 mb-4">
                为了支持新的乐观锁同步机制，需要更新Supabase数据库结构。
              </p>
              
              <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4 mb-4">
                <h3 className="font-medium text-yellow-800 dark:text-yellow-200 mb-2">
                  📋 迁移建议：
                </h3>
                <ul className="space-y-1">
                  {advice.map((item, index) => (
                    <li key={index} className="text-sm text-yellow-700 dark:text-yellow-300">
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="mb-6">
              <h3 className="font-medium text-gray-900 dark:text-gray-100 mb-2">
                📝 迁移SQL脚本：
              </h3>
              <div className="relative">
                <pre className="bg-gray-100 dark:bg-gray-700 rounded-lg p-4 text-sm overflow-x-auto">
                  <code className="text-gray-800 dark:text-gray-200">
                    {migrationSQL}
                  </code>
                </pre>
                <button
                  onClick={copyToClipboard}
                  className="absolute top-2 right-2 px-3 py-1 bg-blue-500 text-white text-xs rounded hover:bg-blue-600"
                >
                  {copied ? '已复制!' : '复制'}
                </button>
              </div>
            </div>

            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mb-6">
              <h3 className="font-medium text-blue-800 dark:text-blue-200 mb-2">
                🚀 执行步骤：
              </h3>
              <ol className="list-decimal list-inside space-y-2 text-sm text-blue-700 dark:text-blue-300">
                <li>登录到您的 <a href="https://supabase.com/dashboard" target="_blank" rel="noopener noreferrer" className="underline">Supabase Dashboard</a></li>
                <li>选择您的项目</li>
                <li>进入 "SQL Editor"</li>
                <li>复制上面的SQL脚本并粘贴到编辑器中</li>
                <li>点击 "Run" 执行脚本</li>
                <li>确认看到成功消息后，点击下面的"迁移完成"按钮</li>
              </ol>
            </div>

            <div className="flex justify-end space-x-3">
              <button
                onClick={onClose}
                className="px-4 py-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
              >
                稍后处理
              </button>
              <button
                onClick={handleComplete}
                className="px-6 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 font-medium"
              >
                迁移完成
              </button>
            </div>

            <div className="mt-4 p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
              <p className="text-xs text-gray-600 dark:text-gray-400">
                <strong>💡 提示：</strong>
                如果您没有数据库管理权限，请联系系统管理员执行此迁移。
                在迁移完成之前，同步功能将使用兼容模式运行，可能无法使用最新的乐观锁特性。
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
