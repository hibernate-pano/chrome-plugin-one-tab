import React from 'react';
import { SyncStatusRow } from '../sync/SyncStatusRow';
import { SyncButton } from '../sync/SyncButton';

/**
 * Sync tab. The compact `<SyncStatusRow />` shows the live status
 * indicator + manual refresh action; the legacy `<SyncButton />` keeps
 * the advanced overwrite / merge previews (the complex dialogs).
 */
export const SyncTab: React.FC = () => {
  return (
    <div className="max-w-2xl space-y-6">
      <section className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          同步状态
        </h3>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          显示最近一次云端同步时间和当前状态；点击「立即同步」从云端拉取最新会话。
        </p>
        <div className="mt-4 rounded-md border border-gray-100 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/50">
          <SyncStatusRow />
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
