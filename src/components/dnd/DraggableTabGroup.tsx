import React, { useRef } from 'react';
import { TabGroup as TabGroupType } from '@/types/tab';
import { TabGroup } from '@/components/tabs/TabGroup';

interface DraggableTabGroupProps {
  group: TabGroupType;
  index: number;
  moveGroup: (dragIndex: number, hoverIndex: number) => void;
}

export const DraggableTabGroup: React.FC<DraggableTabGroupProps> = ({ group }) => {
  const ref = useRef<HTMLDivElement>(null);

  // 禁用标签组拖拽功能 - 标签组应该保持固定位置

  return (
    <div
      ref={ref}
      style={{
        opacity: 1,
        cursor: 'default',
      }}
      className="transition-material"
    >
      <TabGroup group={group} />
    </div>
  );
};
