/**
 * 虚拟滚动标签列表组件
 * 
 * 当标签组数量超过阈值时启用虚拟滚动，
 * 只渲染可视区域内的元素以提升性能。
 */

import React, { useCallback, useRef, useMemo } from 'react';
import { VariableSizeList as List, ListChildComponentProps } from 'react-window';
import { AutoSizer } from 'react-virtualized-auto-sizer';
import { TabGroup } from '@/types/tab';
import { DraggableTabGroup } from '@/components/dnd/DraggableTabGroup';

// 虚拟滚动启用阈值
const VIRTUALIZATION_THRESHOLD = 50;

// 默认标签组高度估算
const DEFAULT_GROUP_HEIGHT = 120;
const TAB_HEIGHT = 32;
const GROUP_HEADER_HEIGHT = 48;
const GROUP_PADDING = 16;

interface VirtualizedTabListProps {
  groups: TabGroup[];
  onMoveGroup: (dragIndex: number, hoverIndex: number) => void;
  className?: string;
}

/**
 * 计算标签组的预估高度
 */
function estimateGroupHeight(group: TabGroup): number {
  const tabsHeight = Math.min(group.tabs.length, 10) * TAB_HEIGHT;
  return GROUP_HEADER_HEIGHT + tabsHeight + GROUP_PADDING;
}

/**
 * 虚拟滚动行渲染组件
 */
const VirtualRow: React.FC<ListChildComponentProps<{
  groups: TabGroup[];
  onMoveGroup: (dragIndex: number, hoverIndex: number) => void;
}>> = ({ index, style, data }) => {
  const { groups, onMoveGroup } = data;
  const group = groups[index];

  if (!group) return null;

  return (
    <div style={style}>
      <div className="pr-2 pb-2">
        <DraggableTabGroup
          group={group}
          index={index}
          moveGroup={onMoveGroup}
        />
      </div>
    </div>
  );
};

/**
 * 虚拟滚动标签列表
 */
export const VirtualizedTabList: React.FC<VirtualizedTabListProps> = ({
  groups,
  onMoveGroup,
  className = '',
}) => {
  const listRef = useRef<List>(null);
  
  // 缓存每个标签组的高度
  const heightCache = useRef<Map<string, number>>(new Map());

  // 获取标签组高度
  const getItemSize = useCallback((index: number): number => {
    const group = groups[index];
    if (!group) return DEFAULT_GROUP_HEIGHT;

    // 检查缓存
    const cached = heightCache.current.get(group.id);
    if (cached) return cached;

    // 计算并缓存高度
    const height = estimateGroupHeight(group);
    heightCache.current.set(group.id, height);
    return height;
  }, [groups]);

  // 当标签组变化时重置高度缓存
  const itemData = useMemo(() => ({
    groups,
    onMoveGroup,
  }), [groups, onMoveGroup]);

  // 如果标签组数量少于阈值，不使用虚拟滚动
  if (groups.length < VIRTUALIZATION_THRESHOLD) {
    return (
      <div className={`space-y-2 ${className}`}>
        {groups.map((group, index) => (
          <DraggableTabGroup
            key={group.id}
            group={group}
            index={index}
            moveGroup={onMoveGroup}
          />
        ))}
      </div>
    );
  }

  return (
    <div className={`h-full min-h-[400px] ${className}`}>
      <AutoSizer
        renderProp={({ height, width }) => {
          if (height === undefined || width === undefined) {
            return <div>Loading...</div>;
          }
          return (
            <List
              ref={listRef}
              height={height}
              width={width}
              itemCount={groups.length}
              itemSize={getItemSize}
              itemData={itemData}
              overscanCount={3}
              className="scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-600"
            >
              {VirtualRow}
            </List>
          );
        }}
      />
    </div>
  );
};

/**
 * 检查是否应该使用虚拟滚动
 */
export function shouldUseVirtualization(groupCount: number): boolean {
  return groupCount >= VIRTUALIZATION_THRESHOLD;
}

export default VirtualizedTabList;
