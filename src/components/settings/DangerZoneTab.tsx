import React from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { deleteAllGroups } from '@/store/slices/tabSlice';
import { syncService } from '@/services/syncService';
import { useToast } from '@/contexts/ToastContext';

/**
 * Danger-zone tab. Hosts the "delete all sessions" action that was
 * tucked at the bottom of the old `HeaderDropdown`.
 */
export const DangerZoneTab: React.FC = () => {
  const dispatch = useAppDispatch();
  const { isAuthenticated } = useAppSelector(state => state.auth);
  const { confirmBeforeDelete } = useAppSelector(state => state.settings);
  const { showConfirm, showAlert } = useToast();

  const handleDeleteAllGroups = () => {
    const runDeleteAll = async () => {
      try {
        const result: any = await dispatch(deleteAllGroups());
        const count = result?.payload?.count || 0;

        if (isAuthenticated) {
          syncService
            .uploadToCloud(true, true)
            .then(() => {
              console.log('删除操作已同步到云端');
            })
            .catch(error => {
              console.error('同步到云端失败:', error);
            });
        }

        showAlert({
          title: '删除成功',
          message: `成功删除了 ${count} 个会话`,
          type: 'success',
          onClose: () => {},
        });
      } catch (error) {
        console.error('删除所有标签组失败:', error);
        showAlert({
          title: '删除失败',
          message: '删除所有会话失败',
          type: 'error',
          onClose: () => {},
        });
      }
    };

    if (!confirmBeforeDelete) {
      void runDeleteAll();
      return;
    }

    showConfirm({
      title: '删除确认',
      message: '确定要删除所有会话吗？此操作无法撤销。',
      type: 'danger',
      confirmText: '删除',
      cancelText: '取消',
      onConfirm: () => {
        void runDeleteAll();
      },
      onCancel: () => {},
    });
  };

  return (
    <div className="max-w-2xl space-y-6">
      <section className="rounded-2xl border border-rose-200 bg-rose-50 p-5 dark:border-rose-900/40 dark:bg-rose-950/30">
        <h3 className="text-sm font-semibold text-rose-700 dark:text-rose-300">
          删除所有会话
        </h3>
        <p className="mt-1 text-xs text-rose-700/80 dark:text-rose-300/80">
          清空本地所有已保存的会话。如果已登录，删除操作会同步到云端。此操作无法撤销。
        </p>
        <button
          onClick={handleDeleteAllGroups}
          className="mt-4 inline-flex items-center justify-center rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700 flat-interaction"
        >
          立即清空
        </button>
      </section>
    </div>
  );
};

export default DangerZoneTab;
