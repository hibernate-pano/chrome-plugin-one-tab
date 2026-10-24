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
          {/* ── 2026-10-24：回到 v1.25.1 的短形式「N 标签」 ────────────────
           * 顶栏是**紧凑位置**：药丸只有一颗「N 会话」那么宽，1.27.0 的
           * 「N 个标签页」把这枚药丸撑长了（实拍对比里可见）。
           * ⇒ 紧凑位置用短形式「标签」，句子里用全名「N 个标签页」
           *   （保存提示 / 删除确认 / aria-label 那几处不变）。
           * 守卫：tests/guards/onboardingCopyHonesty.test.ts 的 H-10 段。 */}
          <strong>{tabCount}</strong> 标签
        </span>
      )}
    </div>
  );
};

export default TabCounter;
