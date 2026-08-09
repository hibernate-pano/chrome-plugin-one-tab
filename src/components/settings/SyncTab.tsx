import React, { useEffect, useState } from 'react';
import { SyncStatusRow } from '../sync/SyncStatusRow';
import { SyncButton } from '../sync/SyncButton';
import { storage } from '@/utils/storage';
import { syncService } from '@/services/syncService';
import { useToast } from '@/contexts/ToastContext';

/**
 * Sync tab. The compact `<SyncStatusRow />` shows the live status
 * indicator + manual refresh action; the legacy `<SyncButton />` keeps
 * the advanced overwrite / merge previews (the complex dialogs).
 *
 * S1 §5.3：挂载时读取持久化同步状态（IndexedDB），若上次同步失败
 * （lastSyncError 非空）则在状态区下方显示错误说明（rose 文字）。
 *
 * F9：恢复 S2 Header 折叠时丢失的两个动作——「上传到云端」与
 * 「下载（覆盖本地）」。这两个动作的语义就是「用本地覆盖云端」/
 * 「用云端覆盖本地」，不需要「高级操作」里的预览/确认弹窗，直接
 * 一键执行。SyncStatusRow 的「立即同步」按钮保留合并模式语义不变。
 */
export const SyncTab: React.FC = () => {
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'idle' | 'upload' | 'download'>('idle');
  const { showToast } = useToast();

  useEffect(() => {
    let cancelled = false;
    storage.getLastSyncStatus().then(status => {
      if (!cancelled) setLastSyncError(status.lastSyncError);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleUpload = async () => {
    if (busy !== 'idle') return;
    setBusy('upload');
    try {
      const result = await syncService.uploadToCloud(false, true);
      if (result.success) {
        showToast({ message: '已上传到云端', type: 'success' });
      } else {
        showToast({
          message: result.error || '上传失败',
          type: 'error',
          duration: 5000,
        });
      }
    } catch (e: any) {
      showToast({
        message: e?.message || '上传失败',
        type: 'error',
        duration: 5000,
      });
    } finally {
      setBusy('idle');
    }
  };

  const handleDownload = async () => {
    if (busy !== 'idle') return;
    setBusy('download');
    try {
      const result = await syncService.downloadAndRefresh(true);
      if (result.success) {
        showToast({ message: '已从云端下载并覆盖本地', type: 'success' });
      } else {
        showToast({
          message: result.error || '下载失败',
          type: 'error',
          duration: 5000,
        });
      }
    } catch (e: any) {
      showToast({
        message: e?.message || '下载失败',
        type: 'error',
        duration: 5000,
      });
    } finally {
      setBusy('idle');
    }
  };

  const uploadDisabled = busy !== 'idle';
  const downloadDisabled = busy !== 'idle';

  return (
    <div className="max-w-2xl space-y-6">
      <section className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          同步状态
        </h3>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          显示最近一次云端同步时间和当前状态；点击「立即同步」从云端拉取最新会话（合并模式）。
        </p>
        <div className="mt-4 rounded-md border border-gray-100 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/50">
          <SyncStatusRow />
          {lastSyncError && (
            <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">
              上次同步失败：{lastSyncError}
            </p>
          )}
        </div>
        {/* F9：恢复丢失的两个一键动作——覆盖语义，无预览弹窗 */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            onClick={handleUpload}
            disabled={uploadDisabled}
            className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700 flat-interaction focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
          >
            {busy === 'upload' ? '上传中…' : '上传到云端'}
          </button>
          <button
            onClick={handleDownload}
            disabled={downloadDisabled}
            className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700 flat-interaction focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
          >
            {busy === 'download' ? '下载中…' : '下载（覆盖本地）'}
          </button>
        </div>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          高级操作
        </h3>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          手动上传 / 下载并预览改动，覆盖或合并模式由你在弹窗中确认。
        </p>
        <div className="mt-4">
          <SyncButton />
        </div>
      </section>
    </div>
  );
};

export default SyncTab;
