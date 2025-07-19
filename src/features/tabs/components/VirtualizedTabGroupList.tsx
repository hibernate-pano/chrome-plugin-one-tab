import React, { useState, useCallback, useMemo, memo } from 'react';
import { TabGroup } from '@/shared/types/tab';
import { VirtualizedList, VirtualizedListItem } from '@/shared/components/VirtualizedList';
import { TabGroupCard } from './TabGroupCard';
import { createMemoComparison } from '@/shared/utils/performanceOptimizer';
import { useAppSelector } from '@/app/store/hooks';

/**
 * 虚拟化标签组列表项接口
 */
interface VirtualizedTabGroupItem extends VirtualizedListItem {
  id: string;
  data: TabGroup;
  height: number;
}

/**
 * 虚拟化标签组列表属性接口
 */
interface VirtualizedTabGroupListProps {
  groups: TabGroup[];
  containerHeight: number;
  onGroupClick?: (group: TabGroup) => void;
  onGroupEdit?: (group: TabGroup) => void;
  onGroupDelete?: (group: TabGroup) => void;
  onTabClick?: (tab: any, group: TabGroup) => void;
  className?: string;
  searchQuery?: string;
  selectedGroupIds?: string[];
  onGroupSelect?: (groupId: string, selected: boolean) => void;
  isSelectionMode?: boolean;
}

/**
 * 计算标签组卡片高度的函数
 */
const calculateGroupCardHeight = (group: TabGroup, isCollapsed: boolean = false): number => {
  const baseHeight = 120; // 基础高度：标题、元信息等
  const tabItemHeight = 32; // 每个标签项的高度
  const maxVisibleTabs = 5; // 最多显示的标签数量
  const padding = 24; // 内边距
  
  if (isCollapsed) {
    return baseHeight;
  }
  
  const visibleTabCount = Math.min(group.tabs.length, maxVisibleTabs);
  const tabsHeight = visibleTabCount * tabItemHeight;
  const showMoreHeight = group.tabs.length > maxVisibleTabs ? 24 : 0; // "显示更多"按钮高度
  
  return baseHeight + tabsHeight + showMoreHeight + padding;
};

/**
 * 虚拟化标签组列表组件
 * 使用虚拟化技术优化大量标签组的渲染性能
 */
const VirtualizedTabGroupListComponent: React.FC<VirtualizedTabGroupListProps> = ({
  groups,
  containerHeight,
  onGroupClick,
  onGroupEdit,
  onGroupDelete,
  onTabClick,
  className = '',
  searchQuery = '',
  selectedGroupIds = [],
  onGroupSelect,
  isSelectionMode = false
}) => {
  const { collapsedGroups } = useAppSelector(state => state.ui);
  const [scrollToIndex, setScrollToIndex] = useState<number | undefined>();

  // 转换标签组为虚拟化列表项
  const virtualizedItems = useMemo((): VirtualizedTabGroupItem[] => {
    return groups.map((group, index) => {
      const isCollapsed = collapsedGroups.includes(group.id);
      const height = calculateGroupCardHeight(group, isCollapsed);
      
      return {
        id: group.id,
        data: group,
        height
      };
    });
  }, [groups, collapsedGroups]);

  // 获取项目高度
  const getItemHeight = useCallback((item: VirtualizedTabGroupItem): number => {
    return item.height;
  }, []);

  // 获取项目唯一键
  const getItemKey = useCallback((item: VirtualizedTabGroupItem, index: number): string => {
    return item.id;
  }, []);

  // 渲染标签组卡片
  const renderTabGroupCard = useCallback((
    item: VirtualizedTabGroupItem,
    index: number,
    style: React.CSSProperties
  ) => {
    const group = item.data;
    const isSelected = selectedGroupIds.includes(group.id);
    const isCollapsed = collapsedGroups.includes(group.id);

    return (
      <div style={{ ...style, padding: '8px 16px' }}>
        <TabGroupCard
          group={group}
          onClick={() => onGroupClick?.(group)}
          onEdit={() => onGroupEdit?.(group)}
          onDelete={() => onGroupDelete?.(group)}
          onTabClick={(tab) => onTabClick?.(tab, group)}
          searchQuery={searchQuery}
          isSelected={isSelected}
          onSelect={(selected) => onGroupSelect?.(group.id, selected)}
          showCheckbox={isSelectionMode}
          isCollapsed={isCollapsed}
          className="virtualized-group-card"
        />
      </div>
    );
  }, [
    onGroupClick,
    onGroupEdit,
    onGroupDelete,
    onTabClick,
    searchQuery,
    selectedGroupIds,
    onGroupSelect,
    isSelectionMode,
    collapsedGroups
  ]);

  // 处理可见项目变化
  const handleItemsRendered = useCallback((
    startIndex: number,
    endIndex: number,
    visibleItems: VirtualizedTabGroupItem[]
  ) => {
    // 可以在这里添加性能监控或其他逻辑
    console.debug('虚拟化列表渲染范围:', { startIndex, endIndex, visibleCount: visibleItems.length });
  }, []);

  // 处理滚动事件
  const handleScroll = useCallback((scrollTop: number, scrollLeft: number) => {
    // 可以在这里添加滚动相关的逻辑，比如懒加载
  }, []);

  // 滚动到指定标签组
  const scrollToGroup = useCallback((groupId: string) => {
    const index = virtualizedItems.findIndex(item => item.id === groupId);
    if (index !== -1) {
      setScrollToIndex(index);
      // 重置滚动索引，避免重复滚动
      setTimeout(() => setScrollToIndex(undefined), 100);
    }
  }, [virtualizedItems]);

  // 暴露滚动方法给父组件
  React.useImperativeHandle(React.useRef(), () => ({
    scrollToGroup
  }), [scrollToGroup]);

  // 如果没有标签组，显示空状态
  if (virtualizedItems.length === 0) {
    return (
      <div 
        className={`flex items-center justify-center ${className}`}
        style={{ height: containerHeight }}
      >
        <div className="text-center text-gray-500 dark:text-gray-400">
          <div className="text-lg mb-2">暂无标签组</div>
          <div className="text-sm">创建您的第一个标签组开始使用</div>
        </div>
      </div>
    );
  }

  return (
    <div className={`virtualized-tab-group-list ${className}`}>
      <VirtualizedList
        items={virtualizedItems}
        itemHeight={getItemHeight}
        containerHeight={containerHeight}
        renderItem={renderTabGroupCard}
        overscan={3} // 预渲染3个额外项目
        getItemKey={getItemKey}
        onItemsRendered={handleItemsRendered}
        onScroll={handleScroll}
        scrollToIndex={scrollToIndex}
        scrollToAlignment="center"
        estimatedItemHeight={200} // 估算高度
      />
    </div>
  );
};

// 使用memo优化组件性能
export const VirtualizedTabGroupList = memo(
  VirtualizedTabGroupListComponent,
  createMemoComparison([
    'groups',
    'containerHeight',
    'onGroupClick',
    'onGroupEdit',
    'onGroupDelete',
    'onTabClick',
    'className',
    'searchQuery',
    'selectedGroupIds',
    'onGroupSelect',
    'isSelectionMode'
  ])
);

/**
 * 虚拟化标签组网格组件属性接口
 */
interface VirtualizedTabGroupGridProps extends Omit<VirtualizedTabGroupListProps, 'containerHeight'> {
  containerWidth: number;
  containerHeight: number;
  itemWidth?: number;
  itemHeight?: number;
  gap?: number;
}

/**
 * 虚拟化标签组网格组件
 * 用于网格布局的标签组显示
 */
const VirtualizedTabGroupGridComponent: React.FC<VirtualizedTabGroupGridProps> = ({
  groups,
  containerWidth,
  containerHeight,
  itemWidth = 320,
  itemHeight = 240,
  gap = 16,
  onGroupClick,
  onGroupEdit,
  onGroupDelete,
  onTabClick,
  className = '',
  searchQuery = '',
  selectedGroupIds = [],
  onGroupSelect,
  isSelectionMode = false
}) => {
  // 转换标签组为虚拟化列表项
  const virtualizedItems = useMemo((): VirtualizedTabGroupItem[] => {
    return groups.map((group) => ({
      id: group.id,
      data: group,
      height: itemHeight
    }));
  }, [groups, itemHeight]);

  // 获取项目唯一键
  const getItemKey = useCallback((item: VirtualizedTabGroupItem, index: number): string => {
    return item.id;
  }, []);

  // 渲染标签组卡片
  const renderTabGroupCard = useCallback((
    item: VirtualizedTabGroupItem,
    index: number,
    style: React.CSSProperties
  ) => {
    const group = item.data;
    const isSelected = selectedGroupIds.includes(group.id);

    return (
      <div style={{ ...style, padding: gap / 2 }}>
        <TabGroupCard
          group={group}
          onClick={() => onGroupClick?.(group)}
          onEdit={() => onGroupEdit?.(group)}
          onDelete={() => onGroupDelete?.(group)}
          onTabClick={(tab) => onTabClick?.(tab, group)}
          searchQuery={searchQuery}
          isSelected={isSelected}
          onSelect={(selected) => onGroupSelect?.(group.id, selected)}
          showCheckbox={isSelectionMode}
          className="virtualized-group-card grid-layout"
          style={{
            width: itemWidth - gap,
            height: itemHeight - gap
          }}
        />
      </div>
    );
  }, [
    itemWidth,
    itemHeight,
    gap,
    onGroupClick,
    onGroupEdit,
    onGroupDelete,
    onTabClick,
    searchQuery,
    selectedGroupIds,
    onGroupSelect,
    isSelectionMode
  ]);

  // 如果没有标签组，显示空状态
  if (virtualizedItems.length === 0) {
    return (
      <div 
        className={`flex items-center justify-center ${className}`}
        style={{ width: containerWidth, height: containerHeight }}
      >
        <div className="text-center text-gray-500 dark:text-gray-400">
          <div className="text-lg mb-2">暂无标签组</div>
          <div className="text-sm">创建您的第一个标签组开始使用</div>
        </div>
      </div>
    );
  }

  return (
    <div className={`virtualized-tab-group-grid ${className}`}>
      {/* 这里需要实现VirtualizedGrid组件，暂时使用简化版本 */}
      <div 
        style={{
          width: containerWidth,
          height: containerHeight,
          overflow: 'auto',
          display: 'grid',
          gridTemplateColumns: `repeat(auto-fill, minmax(${itemWidth}px, 1fr))`,
          gap: gap,
          padding: gap / 2
        }}
      >
        {virtualizedItems.map((item, index) => 
          renderTabGroupCard(item, index, {})
        )}
      </div>
    </div>
  );
};

// 使用memo优化组件性能
export const VirtualizedTabGroupGrid = memo(
  VirtualizedTabGroupGridComponent,
  createMemoComparison([
    'groups',
    'containerWidth',
    'containerHeight',
    'itemWidth',
    'itemHeight',
    'gap',
    'onGroupClick',
    'onGroupEdit',
    'onGroupDelete',
    'onTabClick',
    'className',
    'searchQuery',
    'selectedGroupIds',
    'onGroupSelect',
    'isSelectionMode'
  ])
);
