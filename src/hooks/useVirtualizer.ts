import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export interface VirtualListOptions {
  itemHeight?: number;
  overscan?: number;
  threshold?: number;
  viewportHeight?: number;
  scrollOffset?: number;
}

export interface VirtualWindow {
  virtual: boolean;
  startIndex: number;
  endIndex: number;
}

/** Computes the list window without React or module-level state. */
export function computeVirtualWindow<T>(
  opts: { items: T[] } & VirtualListOptions,
): VirtualWindow {
  const { items, threshold = 30 } = opts;
  if (items.length < threshold) {
    return { virtual: false, startIndex: 0, endIndex: items.length };
  }

  const itemHeight = opts.itemHeight ?? 80;
  const viewportHeight = opts.viewportHeight ?? 600;
  const overscan = opts.overscan ?? 5;
  const scrollOffset = opts.scrollOffset ?? 0;
  const visibleCount = Math.ceil(viewportHeight / itemHeight);
  const startByScroll = Math.floor(scrollOffset / itemHeight);
  const startIndex = Math.max(0, startByScroll - overscan);
  const endIndex = Math.min(items.length, startIndex + visibleCount + overscan * 2);

  return { virtual: true, startIndex, endIndex };
}

export function useListVirtualizer<T>(items: T[], options: VirtualListOptions = {}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const itemHeight = options.itemHeight ?? 80;
  const threshold = options.threshold ?? 30;
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => itemHeight,
    overscan: options.overscan ?? 5,
    scrollMargin: 0,
  });

  return { virtualizer, parentRef, enabled: items.length >= threshold };
}
