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
          {/* ── 2026-10-23 审计 H-10：同一个实体不许有三种叫法 ────────────
           * 「会话里的一条 URL」在本仓曾有三种叫法：标签页（保存提示、
           * aria-label）/ 标签（本计数器、卡头徽章）/ 标签记录（删除确认）。
           * 同一个东西三个名字 ⇒ 用户在三个界面看到三个词，会以为是三样东西。
           * ⇒ 统一成「标签页」（与 `saveActionCopy` / `saveFeedbackCopy`
           *   / TabGroup 的 aria-label 同源）。
           * 注意「会话数」那一颗**不归这个开关管**（开关只管标签数），
           * 它的文案本来就是「N 会话」，与「标签页」不冲突。 */}
          <strong>{tabCount}</strong> 个标签页
        </span>
      )}
    </div>
  );
};

export default TabCounter;
