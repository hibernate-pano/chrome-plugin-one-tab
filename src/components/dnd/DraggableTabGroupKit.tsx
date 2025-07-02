import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { TabGroup as TabGroupType } from '@/types/tab';
import { TabGroup } from '@/components/tabs/TabGroup';

interface DraggableTabGroupKitProps {
  group: TabGroupType;
}

export const DraggableTabGroupKit: React.FC<DraggableTabGroupKitProps> = ({
  group,
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: group.id,
    data: { group, type: 'TabGroup' },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    cursor: 'default',
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="mb-2 transition-material"
    >
      <TabGroup group={group} />
    </div>
  );
};
