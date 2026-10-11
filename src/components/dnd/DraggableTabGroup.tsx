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
      className="transition-material"
    >
      <TabGroup group={group} />
    </div>
  );
};
