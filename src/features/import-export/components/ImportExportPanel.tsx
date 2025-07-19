import React, { useState, useCallback, useRef, memo } from 'react';
import { useAppSelector } from '@/app/store/hooks';
import { 
  ImportExportService, 
  ExportFormat, 
  ExportOptions, 
  ImportOptions,
  importExportService 
} from '../services/ImportExportService';
import { createMemoComparison } from '@/shared/utils/performanceOptimizer';
import { logger } from '@/shared/utils/logger';

interface ImportExportPanelProps {
  onClose: () => void;
  onImportComplete?: () => void;
}

const ImportExportPanelComponent: React.FC<ImportExportPanelProps> = ({
  onClose,
  onImportComplete
}) => {
  const { groups } = useAppSelector(state => state.tabGroups);
  const [activeTab, setActiveTab] = useState<'export' | 'import'>('export');
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 导出选项状态
  const [exportOptions, setExportOptions] = useState<ExportOptions>({
    format: ExportFormat.JSON,
    includeSettings: true,
    includeMetadata: true,
    compression: false
  });

  // 导入选项状态
  const [importOptions, setImportOptions] = useState<ImportOptions>({
    mergeMode: 'append',
    includeSettings: true,
    validateData: true
  });

  // 选中的标签组
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);

  // 处理导出
  const handleExport = useCallback(async () => {
    try {
      setIsProcessing(true);
      setProgress(0);
      setMessage('准备导出数据...');

      const options: ExportOptions = {
        ...exportOptions,
        selectedGroupIds: selectedGroupIds.length > 0 ? selectedGroupIds : undefined
      };

      setProgress(25);
      setMessage('生成导出文件...');

      const result = await importExportService.exportData(options);

      setProgress(100);
      
      if (result.success) {
        setMessage(`导出成功！已导出 ${result.data?.groupsCount} 个标签组，${result.data?.tabsCount} 个标签`);
        setTimeout(() => {
          setMessage('');
          setProgress(0);
        }, 3000);
      } else {
        setMessage(`导出失败：${result.error}`);
      }
    } catch (error) {
      logger.error('导出失败', error);
      setMessage('导出失败，请重试');
    } finally {
      setIsProcessing(false);
    }
  }, [exportOptions, selectedGroupIds]);

  // 处理导入
  const handleImport = useCallback(async (file: File) => {
    try {
      setIsProcessing(true);
      setProgress(0);
      setMessage('读取文件...');

      setProgress(25);
      setMessage('解析数据...');

      const result = await importExportService.importData(file, importOptions);

      setProgress(75);
      setMessage('保存数据...');

      setProgress(100);
      
      if (result.success) {
        setMessage(`导入成功！已导入 ${result.data?.groupsCount} 个标签组，${result.data?.tabsCount} 个标签`);
        setTimeout(() => {
          onImportComplete?.();
          onClose();
        }, 2000);
      } else {
        setMessage(`导入失败：${result.error}`);
      }
    } catch (error) {
      logger.error('导入失败', error);
      setMessage('导入失败，请重试');
    } finally {
      setIsProcessing(false);
    }
  }, [importOptions, onImportComplete, onClose]);

  // 处理文件选择
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleImport(file);
    }
  }, [handleImport]);

  // 切换标签组选择
  const toggleGroupSelection = useCallback((groupId: string) => {
    setSelectedGroupIds(prev => 
      prev.includes(groupId) 
        ? prev.filter(id => id !== groupId)
        : [...prev, groupId]
    );
  }, []);

  // 全选/取消全选
  const toggleSelectAll = useCallback(() => {
    if (selectedGroupIds.length === groups.length) {
      setSelectedGroupIds([]);
    } else {
      setSelectedGroupIds(groups.map(g => g.id));
    }
  }, [selectedGroupIds.length, groups]);

  // 格式化文件大小
  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-4xl mx-4 max-h-[90vh] overflow-hidden">
        <div className="p-6">
          {/* 标题栏 */}
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              数据导入导出
            </h2>
            <button
              onClick={onClose}
              className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* 标签页 */}
          <div className="flex border-b border-gray-200 dark:border-gray-600 mb-6">
            <button
              onClick={() => setActiveTab('export')}
              className={`px-4 py-2 font-medium transition-colors ${
                activeTab === 'export'
                  ? 'text-blue-600 border-b-2 border-blue-600'
                  : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
              }`}
            >
              导出数据
            </button>
            <button
              onClick={() => setActiveTab('import')}
              className={`px-4 py-2 font-medium transition-colors ${
                activeTab === 'import'
                  ? 'text-blue-600 border-b-2 border-blue-600'
                  : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
              }`}
            >
              导入数据
            </button>
          </div>

          {/* 进度条 */}
          {isProcessing && (
            <div className="mb-6">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-600 dark:text-gray-400">{message}</span>
                <span className="text-sm text-gray-600 dark:text-gray-400">{progress}%</span>
              </div>
              <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                <div 
                  className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          {/* 消息显示 */}
          {message && !isProcessing && (
            <div className="mb-6 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
              <p className="text-blue-800 dark:text-blue-200 text-sm">{message}</p>
            </div>
          )}

          {/* 导出面板 */}
          {activeTab === 'export' && (
            <div className="space-y-6">
              {/* 导出格式选择 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                  导出格式
                </label>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {Object.values(ExportFormat).map((format) => (
                    <label key={format} className="flex items-center">
                      <input
                        type="radio"
                        name="exportFormat"
                        value={format}
                        checked={exportOptions.format === format}
                        onChange={(e) => setExportOptions(prev => ({ ...prev, format: e.target.value as ExportFormat }))}
                        className="mr-2"
                      />
                      <span className="text-sm">
                        {format.toUpperCase()}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {/* 导出选项 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                  导出选项
                </label>
                <div className="space-y-2">
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={exportOptions.includeSettings}
                      onChange={(e) => setExportOptions(prev => ({ ...prev, includeSettings: e.target.checked }))}
                      className="mr-2"
                    />
                    <span className="text-sm">包含设置数据</span>
                  </label>
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={exportOptions.includeMetadata}
                      onChange={(e) => setExportOptions(prev => ({ ...prev, includeMetadata: e.target.checked }))}
                      className="mr-2"
                    />
                    <span className="text-sm">包含元数据</span>
                  </label>
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={exportOptions.compression}
                      onChange={(e) => setExportOptions(prev => ({ ...prev, compression: e.target.checked }))}
                      className="mr-2"
                    />
                    <span className="text-sm">启用压缩（减小文件大小）</span>
                  </label>
                </div>
              </div>

              {/* 标签组选择 */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    选择要导出的标签组
                  </label>
                  <button
                    onClick={toggleSelectAll}
                    className="text-sm text-blue-600 hover:text-blue-700 transition-colors"
                  >
                    {selectedGroupIds.length === groups.length ? '取消全选' : '全选'}
                  </button>
                </div>
                <div className="max-h-48 overflow-y-auto border border-gray-300 dark:border-gray-600 rounded-lg p-3">
                  {groups.length === 0 ? (
                    <p className="text-gray-500 dark:text-gray-400 text-sm">暂无标签组</p>
                  ) : (
                    <div className="space-y-2">
                      {groups.map((group) => (
                        <label key={group.id} className="flex items-center">
                          <input
                            type="checkbox"
                            checked={selectedGroupIds.includes(group.id)}
                            onChange={() => toggleGroupSelection(group.id)}
                            className="mr-2"
                          />
                          <span className="text-sm flex-1">{group.name}</span>
                          <span className="text-xs text-gray-500 dark:text-gray-400">
                            {group.tabs.length} 个标签
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                  {selectedGroupIds.length === 0 ? '未选择时将导出所有标签组' : `已选择 ${selectedGroupIds.length} 个标签组`}
                </p>
              </div>

              {/* 导出按钮 */}
              <div className="flex justify-end">
                <button
                  onClick={handleExport}
                  disabled={isProcessing || groups.length === 0}
                  className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isProcessing ? '导出中...' : '开始导出'}
                </button>
              </div>
            </div>
          )}

          {/* 导入面板 */}
          {activeTab === 'import' && (
            <div className="space-y-6">
              {/* 导入选项 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                  导入模式
                </label>
                <div className="space-y-2">
                  <label className="flex items-center">
                    <input
                      type="radio"
                      name="mergeMode"
                      value="append"
                      checked={importOptions.mergeMode === 'append'}
                      onChange={(e) => setImportOptions(prev => ({ ...prev, mergeMode: e.target.value as any }))}
                      className="mr-2"
                    />
                    <div>
                      <span className="text-sm font-medium">追加模式</span>
                      <p className="text-xs text-gray-500 dark:text-gray-400">将导入的数据添加到现有数据之前</p>
                    </div>
                  </label>
                  <label className="flex items-center">
                    <input
                      type="radio"
                      name="mergeMode"
                      value="merge"
                      checked={importOptions.mergeMode === 'merge'}
                      onChange={(e) => setImportOptions(prev => ({ ...prev, mergeMode: e.target.value as any }))}
                      className="mr-2"
                    />
                    <div>
                      <span className="text-sm font-medium">合并模式</span>
                      <p className="text-xs text-gray-500 dark:text-gray-400">智能合并相同名称的标签组</p>
                    </div>
                  </label>
                  <label className="flex items-center">
                    <input
                      type="radio"
                      name="mergeMode"
                      value="replace"
                      checked={importOptions.mergeMode === 'replace'}
                      onChange={(e) => setImportOptions(prev => ({ ...prev, mergeMode: e.target.value as any }))}
                      className="mr-2"
                    />
                    <div>
                      <span className="text-sm font-medium">替换模式</span>
                      <p className="text-xs text-gray-500 dark:text-gray-400 text-red-600">⚠️ 将完全替换现有数据</p>
                    </div>
                  </label>
                </div>
              </div>

              {/* 其他导入选项 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                  导入选项
                </label>
                <div className="space-y-2">
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={importOptions.includeSettings}
                      onChange={(e) => setImportOptions(prev => ({ ...prev, includeSettings: e.target.checked }))}
                      className="mr-2"
                    />
                    <span className="text-sm">导入设置数据</span>
                  </label>
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={importOptions.validateData}
                      onChange={(e) => setImportOptions(prev => ({ ...prev, validateData: e.target.checked }))}
                      className="mr-2"
                    />
                    <span className="text-sm">验证数据完整性</span>
                  </label>
                </div>
              </div>

              {/* 支持的格式说明 */}
              <div className="bg-gray-50 dark:bg-gray-700 p-4 rounded-lg">
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">支持的文件格式</h4>
                <div className="grid grid-cols-2 gap-2 text-xs text-gray-600 dark:text-gray-400">
                  <div>• JSON (.json) - 标准格式</div>
                  <div>• 压缩JSON (.cjson) - 压缩格式</div>
                  <div>• OneTab (.txt) - OneTab导出</div>
                  <div>• CSV (.csv) - 表格格式</div>
                  <div>• HTML (.html) - 书签格式</div>
                  <div>• Markdown (.md) - 文档格式</div>
                  <div>• XML (.xml) - 结构化格式</div>
                </div>
              </div>

              {/* 文件选择 */}
              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,.cjson,.txt,.csv,.html,.htm,.md,.markdown,.xml"
                  onChange={handleFileSelect}
                  disabled={isProcessing}
                  className="hidden"
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isProcessing}
                  className="w-full p-6 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg hover:border-blue-500 dark:hover:border-blue-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <div className="text-center">
                    <svg className="mx-auto h-12 w-12 text-gray-400" stroke="currentColor" fill="none" viewBox="0 0 48 48">
                      <path d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                      {isProcessing ? '正在处理文件...' : '点击选择文件或拖拽文件到此处'}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-500">
                      支持 JSON, OneTab, CSV, HTML, Markdown, XML 格式
                    </p>
                  </div>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// 使用memo优化组件性能
export const ImportExportPanel = memo(
  ImportExportPanelComponent,
  createMemoComparison(['onClose', 'onImportComplete'])
);
