import React from 'react';
import { useAppSelector } from '@/store/hooks';

export const TabCounter: React.FC = () => {
  const { groups } = useAppSelector(state => state.tabs);
  // ── 2026-10-20 审计 A-9：showTabCount 从「死设置」变成**真被读**的开关 ──
  // 「N 标签」这枚药丸就是标签数量的第三个呈现点。关掉开关时不渲染它
  // （「N 会话」是会话数，不受这个开关管 —— 开关的名字与语义只覆盖标签数）。
  const showTabCount = useAppSelector(state => state.settings.showTabCount);

  const groupCount = groups.length;
  const tabCount = groups.reduce((total, group) => total + group.tabs.length, 0);

  return (
    <div className="flex items-center gap-2">
      <span
        className="whitespace-nowrap text-xs font-medium px-2 py-0.5 rounded-full"
        style={{
          background: 'var(--color-bg-tertiary)',
          color: 'var(--color-text-secondary)'
        }}
      >
        <strong style={{ color: 'var(--color-accent)' }}>{groupCount}</strong> 会话
      </span>
      {showTabCount && (
        <span
          className="text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap"
          style={{
            background: 'var(--color-bg-tertiary)',
            color: 'var(--color-text-secondary)'
          }}
        >
          <strong>{tabCount}</strong> 标签
        </span>
      )}
    </div>
  );
};

export default TabCounter;
