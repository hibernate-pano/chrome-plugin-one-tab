import React, { useCallback } from 'react';
import { useAppDispatch } from '@/store/hooks';
import { deleteGroup } from '@/store/slices/tabSlice';
import { SafeFavicon } from '@/components/common/SafeFavicon';
import { useToast } from '@/contexts/ToastContext';
import { useEnhancedToast } from '@/utils/toastHelper';
import { trackProductEvent } from '@/utils/productEvents';
import { buildSessionRestoreMessage } from '@/utils/sessionPresentation';
import type { TabGroup as TabGroupType } from '@/types/tab';

interface FavoriteStripProps {
  groups: TabGroupType[];
  /**
   * 关闭/卸载回调（可选）。FavoriteStrip 自身不做弹层关闭，但保持签名
   * 兼容后续可能的弹层封装。
   */
  onClose?: () => void;
}

/**
 * S3 §3: 收藏会话独立区（FavoriteStrip）。
 *
 * - 渲染在 TabList 顶部、虚拟化列表**之外**（spec §3.2 强调"独立于 virtualizer"）。
 * - 2 列网格布局（popup 宽度友好）。
 * - 每张卡片：⭐ + 第一 tab favicon + 会话名 + tab 数量。
 * - 点击卡片 → 复用 TabGroup 的恢复逻辑（dispatch deleteGroup + chrome.runtime.sendMessage
 *   OPEN_TABS + buildSessionRestoreMessage toast）。
 * - 0 个收藏时返回 null（spec §3.2 行为）。
 *
 * 视觉规范（spec §3.2）：
 *   `rounded-lg border border-primary/20 bg-primary/5 dark:bg-primary-900/20 p-3`
 *
 * 无障碍：外层 region + aria-label；卡片为 button 元素（语义可激活）。
 */
export const FavoriteStrip: React.FC<FavoriteStripProps> = ({ groups, onClose }) => {
  const dispatch = useAppDispatch();
  const { showToast } = useToast();
  const { showDeleteError } = useEnhancedToast();

  const handleOpenGroup = useCallback(
    (group: TabGroupType) => {
      const tabsPayload = group.tabs.map((tab) => ({
        url: tab.url,
        pinned: !!tab.pinned,
      }));

      void trackProductEvent('session_restored', {
        sessionId: group.id,
        sessionName: group.name,
        source: 'favorites_strip',
        tabCount: group.tabs.length,
      });

      // 复制 TabGroup.handleOpenAllTabs 行为：未锁定 → 通过软删清理原会话；锁定 → 保留。
      if (!group.isLocked) {
        dispatch({ type: 'tabs/deleteGroup/fulfilled', payload: group.id });
        dispatch(deleteGroup(group.id))
          .unwrap()
          .then(() => {
            showToast(buildSessionRestoreMessage(group), 'success', 4500);
          })
          .catch((error) => {
            console.error('恢复收藏会话后删除原会话失败:', error);
            showDeleteError(`恢复收藏会话后清理失败: ${error?.message || '未知错误'}`);
          });
      } else {
        showToast(buildSessionRestoreMessage(group), 'success', 4500);
      }

      setTimeout(() => {
        chrome.runtime.sendMessage({
          type: 'OPEN_TABS',
          data: { tabs: tabsPayload },
        });

        onClose?.();
      }, 50);
    },
    [dispatch, onClose, showToast, showDeleteError]
  );

  // 0 收藏不渲染（spec §3.2 + spec §3.2 "仅当有 favorite"）
  // 必须在所有 hooks 之后 —— 见上方 useCallback 先于 early-return 的修复。
  if (groups.length === 0) {
    return null;
  }

  return (
    <section
      aria-label="收藏会话"
      data-testid="favorite-strip"
      className="rounded-lg border border-primary/20 bg-primary/5 dark:bg-primary-900/20 p-3"
    >
      <header className="flex items-center justify-between mb-2 px-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-primary-700 dark:text-primary-300">
          ⭐ 收藏
        </h3>
        <span className="text-[11px] text-gray-500 dark:text-gray-400">
          {groups.length} 个
        </span>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {groups.map((group) => {
          const firstTab = group.tabs[0];
          return (
            <button
              key={group.id}
              type="button"
              onClick={() => handleOpenGroup(group)}
              data-testid="favorite-card"
              data-group-id={group.id}
              className="flex items-center gap-2 rounded-lg border border-primary/15 bg-white/80 dark:bg-gray-900/40
                         px-3 py-2 text-left text-sm font-medium text-gray-800 dark:text-gray-100
                         transition-all duration-150 hover:bg-primary/10 hover:border-primary/40
                         focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2
                         active:scale-[0.98]"
              aria-label={`打开收藏会话 ${group.name}（${group.tabs.length} 个标签页）`}
            >
              <span className="text-amber-500" aria-hidden="true">⭐</span>
              {firstTab ? (
                <SafeFavicon
                  src={firstTab.favicon}
                  alt=""
                  className="w-4 h-4 flex-shrink-0"
                />
              ) : (
                <span className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
              )}
              <span className="flex-1 min-w-0 truncate" title={group.name}>
                {group.name}
              </span>
              <span
                className="rounded-full bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 text-[11px] font-medium text-gray-600 dark:text-gray-300 flex-shrink-0"
                aria-label={`${group.tabs.length} 个标签页`}
              >
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
