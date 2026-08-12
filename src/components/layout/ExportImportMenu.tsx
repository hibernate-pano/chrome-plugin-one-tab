import React, { useRef, useState } from 'react';
import { useAppDispatch } from '@/store/hooks';
import { cleanDuplicateTabs } from '@/store/slices/tabSlice';
import { storage } from '@/utils/storage';
import { useToast } from '@/contexts/ToastContext';
import { trackProductEvent } from '@/utils/productEvents';
import { MenuSection } from './MenuSection';

interface ExportImportMenuProps {
  onClose: () => void;
}

const ChevronIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
  </svg>
);

/** 工具分组：清理重复标签 + 导出 / 导入数据（JSON 与 OneTab 格式）。 */
export const ExportImportMenu: React.FC<ExportImportMenuProps> = ({ onClose }) => {
  const dispatch = useAppDispatch();
  const [openSubmenu, setOpenSubmenu] = useState<'export' | 'import' | null>(null);
  const jsonImportRef = useRef<HTMLInputElement>(null);
  const oneTabImportRef = useRef<HTMLInputElement>(null);
  const { showAlert } = useToast();

  // 清理重复标签
  const handleCleanDuplicateTabs = async () => {
    onClose();
    try {
      const result = await dispatch(cleanDuplicateTabs() as any).unwrap();
      const removed = result?.removedCount ?? 0;
      showAlert({
        title: '清理完成',
        message: removed > 0 ? `已清理 ${removed} 个重复标签` : '没有发现重复标签',
        type: 'success',
        onClose: () => {},
      });
    } catch (error) {
      showAlert({
        title: '清理失败',
        message: '清理重复标签失败，请重试',
        type: 'error',
        onClose: () => {},
      });
    }
  };

  // 导出数据为 JSON 格式
  const handleExportData = async () => {
    try {
      setOpenSubmenu(null);
      const exportData = await storage.exportData();
      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: 'application/json',
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const date = new Date();
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      a.download = `tabstack-backup-${year}-${month}-${day}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      onClose();
    } catch (error) {
      console.error('导出数据失败:', error);
      showAlert({
        title: '导出失败',
        message: '导出数据失败，请重试',
        type: 'error',
        onClose: () => {},
      });
    }
  };

  // 导出数据为 OneTab 格式
  const handleExportOneTabFormat = async () => {
    try {
      setOpenSubmenu(null);
      const oneTabText = await storage.exportToOneTabFormat();
      const blob = new Blob([oneTabText], { type: 'text/plain' });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const date = new Date();
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      a.download = `tabstack-export-${year}-${month}-${day}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      onClose();
    } catch (error) {
      console.error('导出 OneTab 格式数据失败:', error);
      showAlert({
        title: '导出失败',
        message: '导出 OneTab 格式数据失败，请重试',
        type: 'error',
        onClose: () => {},
      });
    }
  };

  // 导入 JSON
  const handleImportJson = (file: File) => {
    const reader = new FileReader();
    reader.onload = async event => {
      try {
        const data = JSON.parse(event.target?.result as string);
        const success = await storage.importData(data);
        if (success) {
          showAlert({
            title: '导入成功',
            message: '数据导入成功',
            type: 'success',
            onClose: () => {
              window.location.reload();
            },
          });
        } else {
          showAlert({
            title: '导入失败',
            message: '数据导入失败',
            type: 'error',
            onClose: () => {},
          });
        }
      } catch (error) {
        console.error('解析导入文件失败:', error);
        showAlert({
          title: '导入失败',
          message: '解析导入文件失败，请确保文件格式正确',
          type: 'error',
          onClose: () => {},
        });
      }
    };
    reader.readAsText(file);
  };

  // 导入 OneTab
  const handleImportOneTab = (file: File) => {
    const reader = new FileReader();
    reader.onload = async event => {
      try {
        const text = event.target?.result as string;
        const success = await storage.importFromOneTabFormat(text);
        if (success) {
          void trackProductEvent('onetab_import_completed', {
            importSource: 'onetab',
            importedSessions: text.split('\n\n').filter(Boolean).length,
          });
          showAlert({
            title: '导入成功',
            message: 'OneTab 数据导入成功',
            type: 'success',
            onClose: () => {
              window.location.reload();
            },
          });
        } else {
          showAlert({
            title: '导入失败',
            message: 'OneTab 数据导入失败',
            type: 'error',
            onClose: () => {},
          });
        }
      } catch (error) {
        console.error('解析 OneTab 导入文件失败:', error);
        showAlert({
          title: '导入失败',
          message: '解析 OneTab 导入文件失败，请确保文件格式正确',
          type: 'error',
          onClose: () => {},
        });
      }
    };
    reader.readAsText(file);
  };

  return (
    <MenuSection title="工具">
      <button
        onClick={handleCleanDuplicateTabs}
        className="w-full text-left px-2 py-1.5 text-sm text-gray-700 dark:text-gray-300 flat-interaction rounded hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center"
        type="button"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
        清理重复标签
      </button>
      <button
        onClick={() => setOpenSubmenu(current => (current === 'export' ? null : 'export'))}
        className="w-full text-left px-2 py-1.5 text-sm text-gray-700 dark:text-gray-300 flat-interaction rounded hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-between"
        aria-expanded={openSubmenu === 'export'}
        aria-haspopup="menu"
        type="button"
      >
        <div className="flex items-center">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          导出数据
        </div>
        <ChevronIcon />
      </button>
      {openSubmenu === 'export' && (
        <div className="pl-6">
          <button
            onClick={handleExportData}
            className="w-full text-left px-2 py-1.5 text-sm text-gray-700 dark:text-gray-300 flat-interaction rounded hover:bg-gray-100 dark:hover:bg-gray-700"
            type="button"
          >
            JSON 备份
          </button>
          <button
            onClick={handleExportOneTabFormat}
            className="w-full text-left px-2 py-1.5 text-sm text-gray-700 dark:text-gray-300 flat-interaction rounded hover:bg-gray-100 dark:hover:bg-gray-700"
            type="button"
          >
            OneTab 格式
          </button>
        </div>
      )}
      <button
        onClick={() => setOpenSubmenu(current => (current === 'import' ? null : 'import'))}
        className="w-full text-left px-2 py-1.5 text-sm text-gray-700 dark:text-gray-300 flat-interaction rounded hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-between"
        aria-expanded={openSubmenu === 'import'}
        aria-haspopup="menu"
        type="button"
      >
        <div className="flex items-center">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L5 8m4-4v12" />
          </svg>
          导入数据
        </div>
        <ChevronIcon />
      </button>
      {openSubmenu === 'import' && (
        <div className="pl-6">
          <button
            onClick={() => jsonImportRef.current?.click()}
            className="w-full text-left px-2 py-1.5 text-sm text-gray-700 dark:text-gray-300 flat-interaction rounded hover:bg-gray-100 dark:hover:bg-gray-700"
            type="button"
          >
            JSON 备份
          </button>
          <button
            onClick={() => oneTabImportRef.current?.click()}
            className="w-full text-left px-2 py-1.5 text-sm text-gray-700 dark:text-gray-300 flat-interaction rounded hover:bg-gray-100 dark:hover:bg-gray-700"
            type="button"
          >
            OneTab 格式
          </button>
        </div>
      )}

      {/* 隐藏的 file input */}
      <input
        ref={jsonImportRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={e => {
          const file = e.target.files?.[0];
          if (file) handleImportJson(file);
          e.target.value = '';
        }}
      />
      <input
        ref={oneTabImportRef}
        type="file"
        accept=".txt,text/plain"
        className="hidden"
        onChange={e => {
          const file = e.target.files?.[0];
          if (file) handleImportOneTab(file);
          e.target.value = '';
        }}
      />
    </MenuSection>
  );
};

export default ExportImportMenu;
