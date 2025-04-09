import React, { useRef } from 'react';
import { useDrag, useDrop } from 'react-dnd';
import { TabGroup as TabGroupType } from '@/types/tab';
import { TabGroup } from '@/components/tabs/TabGroup';
import { ItemTypes, TabGroupDragItem } from './DndTypes';

interface DraggableTabGroupProps {
  group: TabGroupType;
  index: number;
  moveGroup: (dragIndex: number, hoverIndex: number) => void;
}

export const DraggableTabGroup: React.FC<DraggableTabGroupProps> = ({ group, index, moveGroup }) => {
  const ref = useRef<HTMLDivElement>(null);

  // 拖拽源
  const [{ isDragging }, drag] = useDrag({
    type: ItemTypes.TAB_GROUP,
    item: { type: ItemTypes.TAB_GROUP, id: group.id, index } as TabGroupDragItem,
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
  });

  // 放置目标
  const [, drop] = useDrop({
    accept: ItemTypes.TAB_GROUP,
    hover: (item: TabGroupDragItem, monitor) => {
      if (!ref.current) {
        return;
      }

      const dragIndex = item.index;
      const hoverIndex = index;

      // 如果拖拽的是自己，不做任何操作
      if (dragIndex === hoverIndex) {
        return;
      }

      // 确定鼠标位置
      const hoverBoundingRect = ref.current.getBoundingClientRect();
      const hoverMiddleY = (hoverBoundingRect.bottom - hoverBoundingRect.top) / 2;
      const clientOffset = monitor.getClientOffset();
      const hoverClientY = clientOffset!.y - hoverBoundingRect.top;

      // 向上拖动时，只有当鼠标超过目标的一半高度时才移动
      if (dragIndex < hoverIndex && hoverClientY < hoverMiddleY) {
        return;
      }

      // 向下拖动时，只有当鼠标超过目标的一半高度时才移动
      if (dragIndex > hoverIndex && hoverClientY > hoverMiddleY) {
        return;
      }

      // 执行移动
      moveGroup(dragIndex, hoverIndex);

      // 更新拖拽项的索引
      item.index = hoverIndex;
    },
  });

  // 将拖拽源和放置目标应用到同一个元素
  drag(drop(ref));

  return (
    <div
      ref={ref}
      style={{
        opacity: isDragging ? 0.5 : 1,
        cursor: 'default',
      }}
      className="transition-material"
    >
      <TabGroup group={group} />
    </div>
  );
};
