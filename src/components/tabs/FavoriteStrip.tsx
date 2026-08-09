import React, { useCallback } from 'react';
import { useAppDispatch } from '@/store/hooks';
import { deleteGroup } from '@/store/slices/tabSlice';
import { SafeFavicon } from '@/components/common/SafeFavicon';
import { useToast } from '@/contexts/ToastContext';
import { trackProductEvent } from '@/utils/productEvents';
import { buildSessionRestoreMessage } from '@/utils/sessionPresentation';
import type { TabGroup as TabGroupType } from '@/types/tab';

interface FavoriteStripProps {
  groups: TabGroupType[];
}

/**
 * 收藏会话独立区：放在列表顶部，让高频会话始终第一眼可见。
 * 点击卡片直接恢复整个会话，未锁定会话会在恢复后软删原记录。
 */
export const FavoriteStrip: React.FC<FavoriteStripProps> = ({ groups }) => {
  const dispatch = useAppDispatch();
  const { showToast } = useToast();

  const handleOpenGroup = useCallback(
    (group: TabGroupType) => {
      const tabsPayload = group.tabs.map(tab => ({
        url: tab.url,
        pinned: !!tab.pinned,
      }));

      void trackProductEvent('session_restored', {
        sessionId: group.id,
        sessionName: group.name,
        source: 'favorites_strip',
        tabCount: group.tabs.length,
      });

      if (!group.isLocked) {
        dispatch(deleteGroup(group.id))
          .unwrap()
          .then(() => {
            showToast(buildSessionRestoreMessage(group), 'success', 4500);
          })
          .catch(error => {
            console.error('恢复收藏会话后删除原会话失败:', error);
            showToast(`恢复会话后清理失败: ${error?.message || '未知错误'}`, 'error', 4500);
          });
      } else {
        showToast(buildSessionRestoreMessage(group), 'success', 4500);
      }

      setTimeout(() => {
        chrome.runtime.sendMessage({
          type: 'OPEN_TABS',
          data: { tabs: tabsPayload },
        });
      }, 50);
    },
    [dispatch, showToast]
  );

  if (groups.length === 0) return null;

  return (
    <section
      aria-label="收藏会话"
      className="rounded-xl border border-amber-200/70 bg-amber-50/60 p-3 dark:border-amber-500/20 dark:bg-amber-500/10"
    >
      <header className="mb-2 flex items-center justify-between px-1">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M11.48 3.499a.563.563 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.386a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.563.563 0 00-.182-.557L3.041 10.385a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
          </svg>
          收藏
        </h3>
        <span className="text-[11px] text-gray-500 dark:text-gray-400">{groups.length} 个</span>
      </header>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {groups.map(group => {
          const firstTab = group.tabs[0];
          return (
            <button
              key={group.id}
              type="button"
              onClick={() => handleOpenGroup(group)}
              className="flex items-center gap-2 rounded-lg border border-amber-200 bg-white/80 px-3 py-2 text-left text-sm font-medium text-gray-800 transition hover:border-amber-300 hover:bg-white dark:border-amber-500/20 dark:bg-gray-900/40 dark:text-gray-100 dark:hover:bg-gray-900/70"
              aria-label={`打开收藏会话 ${group.name}（${group.tabs.length} 个标签页）`}
            >
              {firstTab ? (
                <SafeFavicon src={firstTab.favicon} alt="" className="h-4 w-4 flex-shrink-0" />
              ) : (
                <span className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1 truncate" title={group.name}>
                {group.name}
              </span>
              <span className="flex-shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                {group.tabs.length}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
};

export default FavoriteStrip;
