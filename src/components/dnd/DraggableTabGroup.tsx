import React, { useRef } from 'react';
import { TabGroup as TabGroupType } from '@/types/tab';
import { TabGroup } from '@/components/tabs/TabGroup';

interface DraggableTabGroupProps {
  group: TabGroupType;
}

export const DraggableTabGroup: React.FC<DraggableTabGroupProps> = ({ group }) => {
  const ref = useRef<HTMLDivElement>(null);

  // 会话组级拖拽保持禁用（产品决策：组固定位置，只允许组内标签重排）。
  // 标签级拖拽见 DraggableTab（2026-10-10 已转正为真实可用）。

  return (
    <div
      ref={ref}
      style={{
        opacity: 1,
        cursor: 'default',
        contentVisibility: 'auto',
        containIntrinsicSize: '320px',
      }}
      /* `min-w-0`（= min-width: 0）：这张卡现在**直接**是 CSS grid 的子项
       * （双栏布局改成行主序，见 TabList.tsx 的 R-11 注释）⇒ grid item 的
       * 默认 `min-width: auto` 会按内容撑开，长标题/长网址会把卡片顶出格子。
       * 旧的「两列各一个 div」布局里这个 `min-width: 0` 长在列容器上，
       * 改行主序后必须跟着搬到这里 —— 否则双栏会横向溢出。 */
      className="transition-material min-w-0"
    >
      <TabGroup group={group} />
    </div>
  );
};
