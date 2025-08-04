import React, { ReactNode, useRef, useEffect } from 'react';
import {
  DndContext,
  DragStartEvent,
  DragEndEvent,
  DragOverEvent,
  DragMoveEvent,
  SensorDescriptor,
  CollisionDetection,
  MeasuringConfiguration,
} from '@dnd-kit/core';

interface DndKitProviderProps {
  children: ReactNode;
  sensors?: SensorDescriptor<any>[];
  collisionDetection: CollisionDetection;
  measuring?: MeasuringConfiguration;
  onDragStart?: (event: DragStartEvent) => void;
  onDragEnd?: (event: DragEndEvent) => void;
  onDragOver?: (event: DragOverEvent) => void;
  onDragMove?: (event: DragMoveEvent) => void;
}

export const DndKitProvider: React.FC<DndKitProviderProps> = ({
  children,
  sensors,
  collisionDetection,
  measuring,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragMove,
}) => {
  // 使用ref跟踪组件是否已卸载
  const isMounted = useRef(true);

  useEffect(() => {
    // 组件挂载时设置为true
    isMounted.current = true;

    // 组件卸载时设置为false
    return () => {
      isMounted.current = false;
    };
  }, []);

  // 安全的事件处理函数，确保组件未卸载时才调用原始函数
  const handleDragStart = (event: DragStartEvent) => {
    if (isMounted.current && onDragStart) {
      try {
        onDragStart(event);
      } catch (error) {
        console.error('拖拽开始处理失败:', error);
      }
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    if (isMounted.current && onDragEnd) {
      try {
        onDragEnd(event);
      } catch (error) {
        console.error('拖拽结束处理失败:', error);
      }
    }
  };

  const handleDragOver = (event: DragOverEvent) => {
    if (isMounted.current && onDragOver) {
      try {
        onDragOver(event);
      } catch (error) {
        console.error('拖拽悬停处理失败:', error);
      }
    }
  };

  const handleDragMove = (event: DragMoveEvent) => {
    if (isMounted.current && onDragMove) {
      try {
        onDragMove(event);
      } catch (error) {
        console.error('拖拽移动处理失败:', error);
      }
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      measuring={measuring}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDragMove={handleDragMove}
    >
      {children}
    </DndContext>
  );
};
