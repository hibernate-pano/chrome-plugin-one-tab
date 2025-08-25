import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { logger } from '@/shared/utils/logger';

export interface VirtualListProps<T> {
  items: T[];
  itemHeight: number;
  containerHeight: number;
  renderItem: (item: T, index: number) => React.ReactNode;
  keyExtractor: (item: T, index: number) => string | number;
  overscan?: number; // 预渲染的额外项目数量
  className?: string;
  onScroll?: (scrollTop: number) => void;
}

/**
 * 虚拟化列表组件
 * 只渲染可见区域的项目，大幅减少DOM节点数量
 */
export function VirtualList<T>({
  items,
  itemHeight,
  containerHeight,
  renderItem,
  keyExtractor,
  overscan = 5,
  className = '',
  onScroll,
}: VirtualListProps<T>) {
  const [scrollTop, setScrollTop] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const isScrolling = useRef(false);
  const scrollTimer = useRef<NodeJS.Timeout | null>(null);

  // 计算可见范围
  const visibleRange = useMemo(() => {
    const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
    const endIndex = Math.min(
      items.length - 1,
      Math.ceil((scrollTop + containerHeight) / itemHeight) + overscan
    );

    return { startIndex, endIndex };
  }, [scrollTop, itemHeight, containerHeight, items.length, overscan]);

  // 计算可见项目
  const visibleItems = useMemo(() => {
    const { startIndex, endIndex } = visibleRange;
    const result = [];

    for (let i = startIndex; i <= endIndex; i++) {
      if (items[i]) {
        result.push({
          item: items[i],
          index: i,
          key: keyExtractor(items[i], i),
        });
      }
    }

    return result;
  }, [items, visibleRange, keyExtractor]);

  // 总高度
  const totalHeight = items.length * itemHeight;

  // 滚动处理
  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const newScrollTop = event.currentTarget.scrollTop;
    setScrollTop(newScrollTop);
    onScroll?.(newScrollTop);

    // 标记正在滚动
    isScrolling.current = true;

    // 清除之前的定时器
    if (scrollTimer.current) {
      clearTimeout(scrollTimer.current);
    }

    // 设置定时器，在滚动停止后清除滚动状态
    scrollTimer.current = setTimeout(() => {
      isScrolling.current = false;
    }, 150);
  }, [onScroll]);

  // 清理定时器
  useEffect(() => {
    return () => {
      if (scrollTimer.current) {
        clearTimeout(scrollTimer.current);
      }
    };
  }, []);

  // 性能监控
  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      const visibleCount = visibleItems.length;
      const totalCount = items.length;
      
      if (totalCount > 100 && visibleCount < totalCount * 0.5) {
        logger.perf('虚拟列表性能', {
          totalItems: totalCount,
          visibleItems: visibleCount,
          renderRatio: `${((visibleCount / totalCount) * 100).toFixed(1)}%`,
          memoryReduction: `${(((totalCount - visibleCount) / totalCount) * 100).toFixed(1)}%`,
        });
      }
    }
  }, [visibleItems.length, items.length]);

  return (
    <div
      ref={containerRef}
      className={`virtual-list ${className}`}
      style={{
        height: containerHeight,
        overflow: 'auto',
        position: 'relative',
      }}
      onScroll={handleScroll}
    >
      {/* 总高度占位符 */}
      <div style={{ height: totalHeight, position: 'relative' }}>
        {/* 可见项目容器 */}
        <div
          style={{
            position: 'absolute',
            top: visibleRange.startIndex * itemHeight,
            left: 0,
            right: 0,
          }}
        >
          {visibleItems.map(({ item, index, key }) => (
            <div
              key={key}
              style={{
                height: itemHeight,
                position: 'relative',
              }}
              data-index={index}
            >
              {renderItem(item, index)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * 自适应高度的虚拟列表
 * 适用于项目高度不固定的场景
 */
export interface AdaptiveVirtualListProps<T> {
  items: T[];
  estimatedItemHeight: number;
  containerHeight: number;
  renderItem: (item: T, index: number) => React.ReactNode;
  keyExtractor: (item: T, index: number) => string | number;
  overscan?: number;
  className?: string;
  onScroll?: (scrollTop: number) => void;
}

export function AdaptiveVirtualList<T>({
  items,
  estimatedItemHeight,
  containerHeight,
  renderItem,
  keyExtractor,
  overscan = 5,
  className = '',
  onScroll,
}: AdaptiveVirtualListProps<T>) {
  const [itemHeights, setItemHeights] = useState<Map<number, number>>(new Map());
  const [scrollTop, setScrollTop] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // 测量项目高度
  const measureItem = useCallback((index: number, element: HTMLDivElement | null) => {
    if (element) {
      itemRefs.current.set(index, element);
      const height = element.getBoundingClientRect().height;
      
      setItemHeights(prev => {
        if (prev.get(index) !== height) {
          const newMap = new Map(prev);
          newMap.set(index, height);
          return newMap;
        }
        return prev;
      });
    } else {
      itemRefs.current.delete(index);
    }
  }, []);

  // 计算累积高度
  const cumulativeHeights = useMemo(() => {
    const heights = [0];
    let total = 0;
    
    for (let i = 0; i < items.length; i++) {
      const height = itemHeights.get(i) || estimatedItemHeight;
      total += height;
      heights.push(total);
    }
    
    return heights;
  }, [items.length, itemHeights, estimatedItemHeight]);

  // 计算可见范围
  const visibleRange = useMemo(() => {
    let startIndex = 0;
    let endIndex = items.length - 1;

    // 二分查找起始索引
    for (let i = 0; i < cumulativeHeights.length - 1; i++) {
      if (cumulativeHeights[i] <= scrollTop && cumulativeHeights[i + 1] > scrollTop) {
        startIndex = Math.max(0, i - overscan);
        break;
      }
    }

    // 查找结束索引
    const viewportBottom = scrollTop + containerHeight;
    for (let i = startIndex; i < cumulativeHeights.length - 1; i++) {
      if (cumulativeHeights[i + 1] >= viewportBottom) {
        endIndex = Math.min(items.length - 1, i + overscan);
        break;
      }
    }

    return { startIndex, endIndex };
  }, [scrollTop, containerHeight, cumulativeHeights, items.length, overscan]);

  // 可见项目
  const visibleItems = useMemo(() => {
    const { startIndex, endIndex } = visibleRange;
    const result = [];

    for (let i = startIndex; i <= endIndex; i++) {
      if (items[i]) {
        result.push({
          item: items[i],
          index: i,
          key: keyExtractor(items[i], i),
          top: cumulativeHeights[i],
        });
      }
    }

    return result;
  }, [items, visibleRange, keyExtractor, cumulativeHeights]);

  const totalHeight = cumulativeHeights[cumulativeHeights.length - 1];

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const newScrollTop = event.currentTarget.scrollTop;
    setScrollTop(newScrollTop);
    onScroll?.(newScrollTop);
  }, [onScroll]);

  return (
    <div
      ref={containerRef}
      className={`adaptive-virtual-list ${className}`}
      style={{
        height: containerHeight,
        overflow: 'auto',
        position: 'relative',
      }}
      onScroll={handleScroll}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        {visibleItems.map(({ item, index, key, top }) => (
          <div
            key={key}
            ref={(el) => measureItem(index, el)}
            style={{
              position: 'absolute',
              top,
              left: 0,
              right: 0,
            }}
            data-index={index}
          >
            {renderItem(item, index)}
          </div>
        ))}
      </div>
    </div>
  );
}
