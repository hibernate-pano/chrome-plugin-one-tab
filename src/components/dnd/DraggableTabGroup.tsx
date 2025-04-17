import React, { useRef, useState, useEffect } from 'react';
import { useDrag, useDrop } from 'react-dnd';
import { TabGroup as TabGroupType } from '@/types/tab';
import { TabGroup } from '@/components/tabs/TabGroup';
import { ItemTypes, TabGroupDragItem } from './DndTypes';
import { debounce } from 'lodash';

interface DraggableTabGroupProps {
  group: TabGroupType;
  index: number;
  moveGroup: (dragIndex: number, hoverIndex: number) => void;
}

export const DraggableTabGroup: React.FC<DraggableTabGroupProps> = ({ group, index, moveGroup }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [isHovering, setIsHovering] = useState(false);

  // 创建一个防抖动的移动函数，避免频繁更新
  const debouncedMoveGroup = useRef(
    debounce((dragIndex, hoverIndex) => {
      moveGroup(dragIndex, hoverIndex);
    }, 50) // 50ms 的防抖时间
  ).current;

  // 清理防抖函数
  useEffect(() => {
    return () => {
      debouncedMoveGroup.cancel();
    };
  }, [debouncedMoveGroup]);

  // 拖拽源
  const [{ isDragging }, drag] = useDrag({
    type: ItemTypes.TAB_GROUP,
    item: { type: ItemTypes.TAB_GROUP, id: group.id, index } as TabGroupDragItem,
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
    end: () => {
      // 拖拽结束时重置悬停状态
      setIsHovering(false);
    }
  });

  // 放置目标
  const [{ isOver }, drop] = useDrop({
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
      const hoverHeight = hoverBoundingRect.bottom - hoverBoundingRect.top;
      const hoverMiddleY = hoverHeight / 2;

      // 添加一个阈值区域，避免在中间区域频繁触发
      const thresholdSize = Math.min(hoverHeight * 0.2, 20); // 阈值区域为高度的20%，最多20像素

      const clientOffset = monitor.getClientOffset();
      if (!clientOffset) return;

      const hoverClientY = clientOffset.y - hoverBoundingRect.top;

      // 判断拖拽方向和鼠标位置
      // 向上拖动时（即从下到上），鼠标应该在目标元素的上半部分
      if (dragIndex > hoverIndex && hoverClientY > hoverMiddleY + thresholdSize) {
        // 如果鼠标还在下半部分，不触发移动
        return;
      }

      // 向下拖动时（即从上到下），鼠标应该在目标元素的下半部分
      if (dragIndex < hoverIndex && hoverClientY < hoverMiddleY - thresholdSize) {
        // 如果鼠标还在上半部分，不触发移动
        return;
      }

      // 设置悬停状态
      setIsHovering(true);

      // 使用防抖函数执行移动
      debouncedMoveGroup(dragIndex, hoverIndex);

      // 更新拖拽项的索引
      item.index = hoverIndex;
    },
    collect: (monitor) => ({
      isOver: monitor.isOver(),
    }),
  });

  // 将拖拽源和放置目标应用到同一个元素
  drag(drop(ref));

  return (
    <div
      ref={ref}
      style={{
        opacity: isDragging ? 0.5 : 1,
        cursor: 'move',
        transform: isOver && isHovering ? 'scale(1.01) translateY(3px)' : 'none',
        transition: 'transform 0.2s ease, opacity 0.2s ease, box-shadow 0.2s ease, background-color 0.2s ease',
        boxShadow: isOver && isHovering ? '0 3px 10px rgba(0, 0, 0, 0.15)' : 'none',
        backgroundColor: isOver && isHovering ? 'rgba(243, 244, 246, 0.5)' : 'transparent',
      }}
      className={`transition-material ${isOver && isHovering ? 'border border-blue-200 rounded-md' : ''}`}
    >
      <TabGroup group={group} />
    </div>
  );
};
