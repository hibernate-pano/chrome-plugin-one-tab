import React, { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import { createMemoComparison } from '@/shared/utils/performanceOptimizer';

/**
 * 虚拟化列表项接口
 */
export interface VirtualizedListItem {
  id: string;
  height?: number; // 可选的固定高度
  data: any;
}

/**
 * 虚拟化列表属性接口
 */
export interface VirtualizedListProps<T extends VirtualizedListItem> {
  items: T[];
  itemHeight: number | ((item: T, index: number) => number);
  containerHeight: number;
  renderItem: (item: T, index: number, style: React.CSSProperties) => React.ReactNode;
  overscan?: number; // 预渲染的额外项目数量
  className?: string;
  onScroll?: (scrollTop: number, scrollLeft: number) => void;
  onItemsRendered?: (startIndex: number, endIndex: number, visibleItems: T[]) => void;
  estimatedItemHeight?: number; // 用于动态高度的估算值
  getItemKey?: (item: T, index: number) => string;
  scrollToIndex?: number;
  scrollToAlignment?: 'start' | 'center' | 'end' | 'auto';
}

/**
 * 虚拟化列表组件
 * 只渲染可见区域的项目，大幅提升长列表的性能
 */
const VirtualizedListComponent = <T extends VirtualizedListItem>({
  items,
  itemHeight,
  containerHeight,
  renderItem,
  overscan = 5,
  className = '',
  onScroll,
  onItemsRendered,
  estimatedItemHeight = 50,
  getItemKey,
  scrollToIndex,
  scrollToAlignment = 'auto'
}: VirtualizedListProps<T>) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [isScrolling, setIsScrolling] = useState(false);
  const scrollTimeoutRef = useRef<NodeJS.Timeout>();

  // 缓存项目高度
  const itemHeights = useRef<Map<number, number>>(new Map());
  const itemOffsets = useRef<Map<number, number>>(new Map());

  // 获取项目高度
  const getItemHeight = useCallback((item: T, index: number): number => {
    if (typeof itemHeight === 'function') {
      // 先检查缓存
      if (itemHeights.current.has(index)) {
        return itemHeights.current.get(index)!;
      }
      
      const height = itemHeight(item, index);
      itemHeights.current.set(index, height);
      return height;
    }
    return itemHeight;
  }, [itemHeight]);

  // 计算项目偏移量
  const getItemOffset = useCallback((index: number): number => {
    if (itemOffsets.current.has(index)) {
      return itemOffsets.current.get(index)!;
    }

    let offset = 0;
    for (let i = 0; i < index; i++) {
      if (i < items.length) {
        offset += getItemHeight(items[i], i);
      } else {
        offset += estimatedItemHeight;
      }
    }

    itemOffsets.current.set(index, offset);
    return offset;
  }, [items, getItemHeight, estimatedItemHeight]);

  // 计算总高度
  const totalHeight = useMemo(() => {
    let height = 0;
    for (let i = 0; i < items.length; i++) {
      height += getItemHeight(items[i], i);
    }
    return height;
  }, [items, getItemHeight]);

  // 计算可见范围
  const visibleRange = useMemo(() => {
    if (items.length === 0) {
      return { startIndex: 0, endIndex: 0 };
    }

    let startIndex = 0;
    let endIndex = 0;
    let currentOffset = 0;

    // 找到开始索引
    for (let i = 0; i < items.length; i++) {
      const itemHeight = getItemHeight(items[i], i);
      if (currentOffset + itemHeight > scrollTop) {
        startIndex = Math.max(0, i - overscan);
        break;
      }
      currentOffset += itemHeight;
    }

    // 找到结束索引
    currentOffset = getItemOffset(startIndex);
    for (let i = startIndex; i < items.length; i++) {
      const itemHeight = getItemHeight(items[i], i);
      if (currentOffset > scrollTop + containerHeight) {
        endIndex = Math.min(items.length - 1, i + overscan);
        break;
      }
      currentOffset += itemHeight;
      endIndex = i;
    }

    return { startIndex, endIndex };
  }, [items, scrollTop, containerHeight, overscan, getItemHeight, getItemOffset]);

  // 可见项目
  const visibleItems = useMemo(() => {
    const { startIndex, endIndex } = visibleRange;
    return items.slice(startIndex, endIndex + 1);
  }, [items, visibleRange]);

  // 处理滚动事件
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const newScrollTop = e.currentTarget.scrollTop;
    const newScrollLeft = e.currentTarget.scrollLeft;
    
    setScrollTop(newScrollTop);
    setIsScrolling(true);
    
    onScroll?.(newScrollTop, newScrollLeft);

    // 清除之前的超时
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }

    // 设置新的超时来检测滚动结束
    scrollTimeoutRef.current = setTimeout(() => {
      setIsScrolling(false);
    }, 150);
  }, [onScroll]);

  // 滚动到指定索引
  const scrollToItem = useCallback((index: number, alignment: 'start' | 'center' | 'end' | 'auto' = 'auto') => {
    if (!containerRef.current || index < 0 || index >= items.length) {
      return;
    }

    const itemOffset = getItemOffset(index);
    const itemHeight = getItemHeight(items[index], index);
    
    let scrollTop: number;

    switch (alignment) {
      case 'start':
        scrollTop = itemOffset;
        break;
      case 'end':
        scrollTop = itemOffset + itemHeight - containerHeight;
        break;
      case 'center':
        scrollTop = itemOffset + itemHeight / 2 - containerHeight / 2;
        break;
      case 'auto':
      default:
        const currentScrollTop = containerRef.current.scrollTop;
        if (itemOffset < currentScrollTop) {
          scrollTop = itemOffset;
        } else if (itemOffset + itemHeight > currentScrollTop + containerHeight) {
          scrollTop = itemOffset + itemHeight - containerHeight;
        } else {
          return; // 已经在可见区域内
        }
        break;
    }

    containerRef.current.scrollTop = Math.max(0, Math.min(scrollTop, totalHeight - containerHeight));
  }, [items, getItemOffset, getItemHeight, containerHeight, totalHeight]);

  // 处理滚动到指定索引
  useEffect(() => {
    if (scrollToIndex !== undefined && scrollToIndex >= 0 && scrollToIndex < items.length) {
      scrollToItem(scrollToIndex, scrollToAlignment);
    }
  }, [scrollToIndex, scrollToAlignment, scrollToItem, items.length]);

  // 通知可见项目变化
  useEffect(() => {
    const { startIndex, endIndex } = visibleRange;
    onItemsRendered?.(startIndex, endIndex, visibleItems);
  }, [visibleRange, visibleItems, onItemsRendered]);

  // 清理定时器
  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, []);

  // 渲染可见项目
  const renderVisibleItems = () => {
    const { startIndex } = visibleRange;
    
    return visibleItems.map((item, relativeIndex) => {
      const absoluteIndex = startIndex + relativeIndex;
      const offset = getItemOffset(absoluteIndex);
      const height = getItemHeight(item, absoluteIndex);
      
      const style: React.CSSProperties = {
        position: 'absolute',
        top: offset,
        left: 0,
        right: 0,
        height: height,
        zIndex: isScrolling ? 1 : 'auto', // 滚动时降低z-index以提升性能
      };

      const key = getItemKey ? getItemKey(item, absoluteIndex) : item.id || absoluteIndex;

      return (
        <div key={key} style={style}>
          {renderItem(item, absoluteIndex, style)}
        </div>
      );
    });
  };

  return (
    <div
      ref={containerRef}
      className={`virtualized-list ${className}`}
      style={{
        height: containerHeight,
        overflow: 'auto',
        position: 'relative',
        willChange: 'scroll-position', // 优化滚动性能
      }}
      onScroll={handleScroll}
    >
      {/* 总高度占位符 */}
      <div
        style={{
          height: totalHeight,
          position: 'relative',
          pointerEvents: 'none',
        }}
      >
        {/* 可见项目容器 */}
        <div
          style={{
            position: 'relative',
            pointerEvents: 'auto',
          }}
        >
          {renderVisibleItems()}
        </div>
      </div>
    </div>
  );
};

// 使用memo优化组件性能
export const VirtualizedList = memo(
  VirtualizedListComponent,
  createMemoComparison([
    'items',
    'itemHeight',
    'containerHeight',
    'renderItem',
    'overscan',
    'className',
    'onScroll',
    'onItemsRendered',
    'estimatedItemHeight',
    'getItemKey',
    'scrollToIndex',
    'scrollToAlignment'
  ])
) as <T extends VirtualizedListItem>(props: VirtualizedListProps<T>) => JSX.Element;

/**
 * 虚拟化网格组件属性接口
 */
export interface VirtualizedGridProps<T extends VirtualizedListItem> {
  items: T[];
  itemWidth: number;
  itemHeight: number;
  containerWidth: number;
  containerHeight: number;
  renderItem: (item: T, index: number, style: React.CSSProperties) => React.ReactNode;
  overscan?: number;
  className?: string;
  onScroll?: (scrollTop: number, scrollLeft: number) => void;
  getItemKey?: (item: T, index: number) => string;
  gap?: number; // 项目间距
}

/**
 * 虚拟化网格组件
 * 用于网格布局的虚拟化渲染
 */
const VirtualizedGridComponent = <T extends VirtualizedListItem>({
  items,
  itemWidth,
  itemHeight,
  containerWidth,
  containerHeight,
  renderItem,
  overscan = 5,
  className = '',
  onScroll,
  getItemKey,
  gap = 0
}: VirtualizedGridProps<T>) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);

  // 计算列数
  const columnCount = Math.floor((containerWidth + gap) / (itemWidth + gap));
  const rowCount = Math.ceil(items.length / columnCount);

  // 计算总尺寸
  const totalWidth = columnCount * (itemWidth + gap) - gap;
  const totalHeight = rowCount * (itemHeight + gap) - gap;

  // 计算可见范围
  const visibleRange = useMemo(() => {
    const startRow = Math.max(0, Math.floor(scrollTop / (itemHeight + gap)) - overscan);
    const endRow = Math.min(rowCount - 1, Math.ceil((scrollTop + containerHeight) / (itemHeight + gap)) + overscan);
    
    const startCol = Math.max(0, Math.floor(scrollLeft / (itemWidth + gap)) - overscan);
    const endCol = Math.min(columnCount - 1, Math.ceil((scrollLeft + containerWidth) / (itemWidth + gap)) + overscan);

    return { startRow, endRow, startCol, endCol };
  }, [scrollTop, scrollLeft, containerHeight, containerWidth, itemHeight, itemWidth, gap, overscan, rowCount, columnCount]);

  // 处理滚动事件
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const newScrollTop = e.currentTarget.scrollTop;
    const newScrollLeft = e.currentTarget.scrollLeft;
    
    setScrollTop(newScrollTop);
    setScrollLeft(newScrollLeft);
    
    onScroll?.(newScrollTop, newScrollLeft);
  }, [onScroll]);

  // 渲染可见项目
  const renderVisibleItems = () => {
    const { startRow, endRow, startCol, endCol } = visibleRange;
    const visibleItems: React.ReactNode[] = [];

    for (let row = startRow; row <= endRow; row++) {
      for (let col = startCol; col <= endCol; col++) {
        const index = row * columnCount + col;
        if (index >= items.length) continue;

        const item = items[index];
        const x = col * (itemWidth + gap);
        const y = row * (itemHeight + gap);

        const style: React.CSSProperties = {
          position: 'absolute',
          left: x,
          top: y,
          width: itemWidth,
          height: itemHeight,
        };

        const key = getItemKey ? getItemKey(item, index) : item.id || index;

        visibleItems.push(
          <div key={key} style={style}>
            {renderItem(item, index, style)}
          </div>
        );
      }
    }

    return visibleItems;
  };

  return (
    <div
      ref={containerRef}
      className={`virtualized-grid ${className}`}
      style={{
        width: containerWidth,
        height: containerHeight,
        overflow: 'auto',
        position: 'relative',
      }}
      onScroll={handleScroll}
    >
      <div
        style={{
          width: totalWidth,
          height: totalHeight,
          position: 'relative',
        }}
      >
        {renderVisibleItems()}
      </div>
    </div>
  );
};

// 使用memo优化组件性能
export const VirtualizedGrid = memo(
  VirtualizedGridComponent,
  createMemoComparison([
    'items',
    'itemWidth',
    'itemHeight',
    'containerWidth',
    'containerHeight',
    'renderItem',
    'overscan',
    'className',
    'onScroll',
    'getItemKey',
    'gap'
  ])
) as <T extends VirtualizedListItem>(props: VirtualizedGridProps<T>) => JSX.Element;
