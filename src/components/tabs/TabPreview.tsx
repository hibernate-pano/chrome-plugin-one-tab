import React from 'react';
import { TabGroup as TabGroupType } from '@/types/tab';
import { SafeFavicon } from '@/components/common/SafeFavicon';

interface TabPreviewProps {
  group: TabGroupType;
}

/**
 * Hover-to-preview 浮层（S3 §1）。
 *
 * 视觉：浮在 TabGroup 卡片内右下，rounded-xl + shadow-lg，符合 S2 视觉规范。
 * 内容：前 8 个 tab 的 favicon + 截断标题，两列网格；超过 8 个显示 "+N 更多"。
 *
 * 必须挂在 `position: relative` 的父元素内（TabGroup 卡片已有 @apply relative）。
 *
 * 无障碍：role="region" + aria-label="会话预览" — 比 role="tooltip" 更合适，
 * 因为内容比一行提示更密。
 *
 * 测试要点（spec §1.4）：
 * - 0 tabs 时返回 null（不渲染浮层容器）
 * - N tabs 时最多渲染 8 个网格行
 */
const MAX_VISIBLE_TABS = 8;

export const TabPreview: React.FC<TabPreviewProps> = ({ group }) => {
  // 0 tabs：什么也不渲染（spec §1.2 行为）
  if (!group.tabs || group.tabs.length === 0) {
    return null;
  }

  const visibleTabs = group.tabs.slice(0, MAX_VISIBLE_TABS);
  const hiddenCount = group.tabs.length - visibleTabs.length;

  return (
    <div
      role="region"
      aria-label="会话预览"
      data-testid="tab-preview"
      className="absolute right-0 top-full mt-1 w-72 max-h-56 overflow-y-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg p-3 z-20"
    >
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        {visibleTabs.map((tab) => (
          <div
            key={tab.id}
            className="flex items-center gap-2 min-w-0"
            data-testid="tab-preview-row"
          >
            <SafeFavicon
              src={tab.favicon}
              alt=""
              className="w-4 h-4 flex-shrink-0"
            />
            <span className="text-xs truncate text-gray-700 dark:text-gray-200" title={tab.title}>
              {tab.title}
            </span>
          </div>
        ))}
      </div>
      {hiddenCount > 0 && (
        <div
          className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-700 text-[11px] text-gray-500 dark:text-gray-400"
          data-testid="tab-preview-overflow"
        >
          +{hiddenCount} 更多
        </div>
      )}
    </div>
  );
};

export default TabPreview;