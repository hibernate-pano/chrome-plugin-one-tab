import React, { useRef } from 'react';
import { storage } from '@/utils/storage';
import { useToast } from '@/contexts/ToastContext';
import { trackProductEvent } from '@/utils/productEvents';
import { exportRawBackup, rawBackupFilename } from '@/utils/backupUtils';

const todayFilename = (prefix: string, ext: string): string => {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${prefix}-${yyyy}-${mm}-${dd}.${ext}`;
};

const triggerDownload = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

/**
 * Import / Export tab. Migrated from `HeaderDropdown` (the export / import
 * submenus there). All operations use the existing `storage` API.
 */
export const ImportExportTab: React.FC = () => {
  const { showAlert } = useToast();
  const jsonInputRef = useRef<HTMLInputElement>(null);
  const oneTabInputRef = useRef<HTMLInputElement>(null);

  const handleExportJson = async () => {
    try {
      const exportData = await storage.exportData();
      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: 'application/json',
      });
      triggerDownload(blob, todayFilename('onetab-backup', 'json'));
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

  const handleExportOneTab = async () => {
    try {
      const text = await storage.exportToOneTabFormat();
      const blob = new Blob([text], { type: 'text/plain' });
      triggerDownload(blob, todayFilename('onetab-export', 'txt'));
    } catch (error) {
      console.error('导出 OneTab 格式失败:', error);
      showAlert({
        title: '导出失败',
        message: '导出 OneTab 格式数据失败，请重试',
        type: 'error',
        onClose: () => {},
      });
    }
  };

  /**
   * S1 §3 加密失败逃生口：导出 IndexedDB 中的原始 blob（不解密）。
   * 当解密失败（key 漂移 / 数据损坏）时，这是唯一能取回数据的路径。
   */
  const handleExportRawBackup = async () => {
    try {
      const blob = await exportRawBackup();
      if (!blob) {
        showAlert({
          title: '导出失败',
          message: '没有可导出的数据',
          type: 'error',
          onClose: () => {},
        });
        return;
      }
      triggerDownload(blob, rawBackupFilename());
      showAlert({
        title: '导出成功',
        message: '原始备份已导出（加密数据，不解密）',
        type: 'success',
        onClose: () => {},
      });
    } catch (error) {
      console.error('导出原始备份失败:', error);
      showAlert({
        title: '导出失败',
        message: '导出原始备份失败，请重试',
        type: 'error',
        onClose: () => {},
      });
    }
  };

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
    <div className="max-w-3xl space-y-6">
      <section className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          导出数据
        </h3>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          把本地所有会话导出为文件，便于备份或迁移。
        </p>
        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <button
            onClick={handleExportJson}
            className="inline-flex items-center justify-center rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 flat-interaction"
          >
            导出为 JSON
          </button>
          <button
            onClick={handleExportOneTab}
            className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700 flat-interaction"
          >
            导出为 OneTab 格式
          </button>
        </div>
        {/* S1 §3：加密失败逃生口——原始（未解密）数据导出 */}
        <div className="mt-4 border-t border-gray-100 pt-4 dark:border-gray-700">
          <button
            onClick={handleExportRawBackup}
            className="inline-flex items-center justify-center rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300 dark:hover:bg-amber-900/30 flat-interaction"
          >
            导出原始备份
          </button>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            加密失败时的逃生口：导出 IndexedDB 中的原始（未解密）数据，不经过解密。
            正常情况请使用上方导出；此按钮保留字节原样，便于密钥修复后恢复。
          </p>
        </div>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          导入数据
        </h3>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          从 JSON 或 OneTab 文本中恢复会话；导入成功后会刷新页面。
        </p>
        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <button
            onClick={() => jsonInputRef.current?.click()}
            className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700 flat-interaction"
          >
            从 JSON 导入
          </button>
          <input
            ref={jsonInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={e => {
              const file = e.target.files?.[0];
              if (file) handleImportJson(file);
              e.target.value = '';
            }}
          />
          <button
            onClick={() => oneTabInputRef.current?.click()}
            className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700 flat-interaction"
          >
            从 OneTab 格式导入
          </button>
          <input
            ref={oneTabInputRef}
            type="file"
            accept=".txt"
            className="hidden"
            onChange={e => {
              const file = e.target.files?.[0];
              if (file) handleImportOneTab(file);
              e.target.value = '';
            }}
          />
        </div>
      </section>
    </div>
  );
};

export default ImportExportTab;
