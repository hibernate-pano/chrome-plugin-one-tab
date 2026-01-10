import React, { useState, useCallback, useMemo } from 'react';

/**
 * 虚拟化列表组件
 * 优化大列表渲染性能，只渲染可见区域的项
 */

interface VirtualizedListProps<T> {
  items: T[];
  itemHeight: number;
  containerHeight: number;
  renderItem: (item: T, index: number) => React.ReactNode;
  overscan?: number; // 预渲染的额外项数
  className?: string;
  onScroll?: (scrollTop: number) => void;
}

export function VirtualizedList<T>({
  items,
  itemHeight,
  containerHeight,
  renderItem,
  overscan = 5,
  className = '',
  onScroll,
}: VirtualizedListProps<T>) {
  const [scrollTop, setScrollTop] = useState(0);

  const totalHeight = items.length * itemHeight;

  // 计算可见区域的起始和结束索引
  const visibleRange = useMemo(() => {
    const startIndex = Math.floor(scrollTop / itemHeight);
    const endIndex = Math.min(
      items.length - 1,
      Math.ceil((scrollTop + containerHeight) / itemHeight)
    );

    // 添加预渲染范围
    const overscanStart = Math.max(0, startIndex - overscan);
    const overscanEnd = Math.min(items.length - 1, endIndex + overscan);

    return { start: overscanStart, end: overscanEnd };
  }, [scrollTop, itemHeight, containerHeight, items.length, overscan]);

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const newScrollTop = e.currentTarget.scrollTop;
      setScrollTop(newScrollTop);
      onScroll?.(newScrollTop);
    },
    [onScroll]
  );

  // 渲染可见的项
  const visibleItems = useMemo(() => {
    const itemsToRender: React.ReactNode[] = [];
    for (let i = visibleRange.start; i <= visibleRange.end; i++) {
      itemsToRender.push(
        <div
          key={i}
          style={{
            position: 'absolute',
            top: i * itemHeight,
            height: itemHeight,
            width: '100%',
          }}
        >
          {renderItem(items[i], i)}
        </div>
      );
    }
    return itemsToRender;
  }, [items, visibleRange, itemHeight, renderItem]);

  return (
    <div
      className={`virtualized-list ${className}`}
      style={{ height: containerHeight, overflow: 'auto', position: 'relative' }}
      onScroll={handleScroll}
    >
      {/* 占位元素，保持滚动条正确 */}
      <div style={{ height: totalHeight, position: 'relative' }}>{visibleItems}</div>
    </div>
  );
}

/**
 * 自适应虚拟化列表
 * 根据内容动态调整项高度
 */
interface AdaptiveVirtualizedListProps<T> {
  items: T[];
  containerHeight: number;
  renderItem: (
    item: T,
    index: number,
    measureElement: (element: HTMLElement) => void
  ) => React.ReactNode;
  overscan?: number;
  className?: string;
  onScroll?: (scrollTop: number) => void;
}

export function AdaptiveVirtualizedList<T>({
  items,
  containerHeight,
  renderItem,
  overscan = 5,
  className = '',
  onScroll,
}: AdaptiveVirtualizedListProps<T>) {
  const [scrollTop, setScrollTop] = useState(0);
  const [itemHeights, setItemHeights] = useState<Map<number, number>>(new Map());
  const [measuredItems, setMeasuredItems] = useState<Set<number>>(new Set());

  // 估算项高度（如果还没有测量到真实高度）
  const estimatedItemHeight = 100;

  // 计算每个项的偏移位置
  const itemOffsets = useMemo(() => {
    const offsets = new Map<number, number>();
    let currentOffset = 0;

    for (let i = 0; i < items.length; i++) {
      offsets.set(i, currentOffset);
      const height = itemHeights.get(i) ?? estimatedItemHeight;
      currentOffset += height;
    }

    return offsets;
  }, [items.length, itemHeights, estimatedItemHeight]);

  const totalHeight = useMemo(() => {
    if (itemOffsets.size === 0) return 0;
    const lastIndex = items.length - 1;
    const lastOffset = itemOffsets.get(lastIndex) ?? 0;
    const lastHeight = itemHeights.get(lastIndex) ?? estimatedItemHeight;
    return lastOffset + lastHeight;
  }, [itemOffsets, items.length, itemHeights, estimatedItemHeight]);

  // 计算可见区域
  const visibleRange = useMemo(() => {
    let startIndex = 0;
    let endIndex = items.length - 1;

    // 找到起始索引
    for (let i = 0; i < items.length; i++) {
      const offset = itemOffsets.get(i) ?? 0;
      const height = itemHeights.get(i) ?? estimatedItemHeight;
      if (offset + height > scrollTop) {
        startIndex = i;
        break;
      }
    }

    // 找到结束索引
    for (let i = startIndex; i < items.length; i++) {
      const offset = itemOffsets.get(i) ?? 0;
      if (offset > scrollTop + containerHeight) {
        endIndex = i - 1;
        break;
      }
    }

    // 添加预渲染范围
    const overscanStart = Math.max(0, startIndex - overscan);
    const overscanEnd = Math.min(items.length - 1, endIndex + overscan);

    return { start: overscanStart, end: overscanEnd };
  }, [
    scrollTop,
    containerHeight,
    itemOffsets,
    itemHeights,
    items.length,
    estimatedItemHeight,
    overscan,
  ]);

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const newScrollTop = e.currentTarget.scrollTop;
      setScrollTop(newScrollTop);
      onScroll?.(newScrollTop);
    },
    [onScroll]
  );

  const measureElement = useCallback(
    (index: number, element: HTMLElement) => {
      if (measuredItems.has(index)) return;

      const rect = element.getBoundingClientRect();
      const height = rect.height;

      if (height > 0) {
        setItemHeights(prev => new Map(prev).set(index, height));
        setMeasuredItems(prev => new Set(prev).add(index));
      }
    },
    [measuredItems]
  );

  // 渲染可见的项
  const visibleItems = useMemo(() => {
    const itemsToRender: React.ReactNode[] = [];
    for (let i = visibleRange.start; i <= visibleRange.end; i++) {
      const top = itemOffsets.get(i) ?? 0;
      const height = itemHeights.get(i) ?? estimatedItemHeight;

      itemsToRender.push(
        <div
          key={i}
          style={{
            position: 'absolute',
            top,
            height,
            width: '100%',
          }}
        >
          {renderItem(items[i], i, element => measureElement(i, element))}
        </div>
      );
    }
    return itemsToRender;
  }, [
    items,
    visibleRange,
    itemOffsets,
    itemHeights,
    estimatedItemHeight,
    renderItem,
    measureElement,
  ]);

  return (
    <div
      className={`adaptive-virtualized-list ${className}`}
      style={{ height: containerHeight, overflow: 'auto', position: 'relative' }}
      onScroll={handleScroll}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>{visibleItems}</div>
    </div>
  );
}

/**
 * 性能优化的列表容器
 * 自动选择是否使用虚拟化
 */
interface OptimizedListProps<T> {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  threshold?: number; // 大于此数量时使用虚拟化
  itemHeight?: number; // 固定项高度（用于虚拟化）
}

export function OptimizedList<T>({
  items,
  renderItem,
  className = '',
  style = {},
  threshold = 50,
  itemHeight = 60,
}: OptimizedListProps<T>) {
  const containerHeight = style.height || 400;

  // 对于小列表，直接渲染
  if (items.length <= threshold) {
    return (
      <div className={className} style={style}>
        {items.map((item, index) => renderItem(item, index))}
      </div>
    );
  }

  // 对于大列表，使用虚拟化
  return (
    <VirtualizedList
      items={items}
      itemHeight={itemHeight}
      containerHeight={typeof containerHeight === 'number' ? containerHeight : 400}
      renderItem={renderItem}
      className={className}
    />
  );
}
