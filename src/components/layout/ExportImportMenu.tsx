import React, { useRef, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { cleanDuplicateTabs } from '@/store/slices/tabSlice';
import { storage } from '@/utils/storage';
import { useToast } from '@/contexts/ToastContext';
import { trackProductEvent } from '@/utils/productEvents';
import { MenuSection } from './MenuSection';
import { ModalFrame } from '@/components/common/ModalFrame';
import { previewCleanDuplicateTabs } from '@/utils/cleanDuplicate';

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
  const groups = useAppSelector(state => state.tabs.groups);
  const [openSubmenu, setOpenSubmenu] = useState<'export' | 'import' | null>(null);
  const jsonImportRef = useRef<HTMLInputElement>(null);
  const oneTabImportRef = useRef<HTMLInputElement>(null);
  const { showToast, showAlert } = useToast();
  // 清理重复预览弹窗
  const [showCleanPreview, setShowCleanPreview] = useState(false);
  const [cleanExecuting, setCleanExecuting] = useState(false);

  // 进入清理预览弹窗
  const handleCleanDuplicateTabs = () => {
    onClose();
    setShowCleanPreview(true);
  };

  // 弹窗内点"确认清理" —— 真正执行 thunk
  const confirmCleanDuplicates = async () => {
    setCleanExecuting(true);
    try {
      const result = await dispatch(cleanDuplicateTabs() as any).unwrap();
      const removed = result?.removedTabsCount ?? 0;
      const removedGroups = result?.removedGroupsCount ?? 0;
      const originalGroups: any[] = result?.originalGroups ?? [];
      setShowCleanPreview(false);

      if (removed === 0 && removedGroups === 0) {
        showAlert({ title: '无需清理', message: '没有发现重复标签或空会话', type: 'success', onClose: () => {} });
        return;
      }

      // 撤销回调：把快照写回 storage + dispatch setGroups 同步 Redux
      const undo = async () => {
        if (!originalGroups.length) return;
        await storage.setGroups(originalGroups);
        dispatch({ type: 'tabs/setGroups', payload: originalGroups });
      };

      const summary =
        (removed > 0 ? `${removed} 个重复标签` : '') +
        (removed > 0 && removedGroups > 0 ? ' · ' : '') +
        (removedGroups > 0 ? `${removedGroups} 个空会话` : '');

      showToast({
        message: `已清理 ${summary}`,
        action: { label: '撤销', onClick: () => { void undo(); } },
      });
    } catch (error) {
      showAlert({ title: '清理失败', message: '清理重复标签失败，请重试', type: 'error', onClose: () => {} });
    } finally {
      setCleanExecuting(false);
    }
  };

  // 弹窗预览内容：实时扫描当前 groups
  const preview = previewCleanDuplicateTabs(groups);
  const hasChanges = preview.removedTabsCount > 0 || preview.removedGroupsCount > 0;

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
    <>
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

    {/* 清理重复预览弹窗 —— 先看会改什么，再决定 */}
    <ModalFrame
      visible={showCleanPreview}
      onClose={() => !cleanExecuting && setShowCleanPreview(false)}
      title="清理重复标签"
      description="预览扫描结果。锁定会话和固定标签页不会被处理。"
      icon={
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </div>
      }
      footer={
        <>
          <button
            onClick={() => setShowCleanPreview(false)}
            disabled={cleanExecuting}
            className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-slate-100 px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            取消
          </button>
          <button
            onClick={confirmCleanDuplicates}
            disabled={!hasChanges || cleanExecuting}
            className="inline-flex items-center justify-center rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-sky-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {cleanExecuting ? '清理中…' : hasChanges ? '确认清理' : '无需清理'}
          </button>
        </>
      }
    >
      {hasChanges ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-slate-50 px-4 py-3 dark:bg-slate-800/60">
              <div className="text-xs text-slate-500 dark:text-slate-400">将合并的重复标签</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-50">
                {preview.removedTabsCount}
              </div>
            </div>
            <div className="rounded-xl bg-slate-50 px-4 py-3 dark:bg-slate-800/60">
              <div className="text-xs text-slate-500 dark:text-slate-400">将删除的空会话</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-50">
                {preview.removedGroupsCount}
              </div>
            </div>
          </div>
          {preview.removedTabSamples.length > 0 && (
            <div>
              <div className="mb-2 text-xs font-medium text-slate-600 dark:text-slate-300">部分被合并的标签（前 8 个）</div>
              <ul className="space-y-1 rounded-xl border border-slate-200 bg-white p-3 text-sm dark:border-slate-700 dark:bg-slate-900/60">
                {preview.removedTabSamples.map((sample, i) => (
                  <li key={`${sample.url}-${i}`} className="flex items-start gap-2 text-slate-700 dark:text-slate-300">
                    <span className="mt-1 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-slate-400" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{sample.title}</span>
                      <span className="ml-1 text-xs text-slate-500 dark:text-slate-400">来自「{sample.fromGroupName}」</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
            清理完成后会显示「撤销」按钮，10 秒内可一键回滚。
          </p>
        </div>
      ) : (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          没有发现重复标签或空会话。可以直接关闭此弹窗。
        </p>
      )}
    </ModalFrame>
    </>
  );
};

export default ExportImportMenu;
