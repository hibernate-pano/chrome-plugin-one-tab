/**
 * 工具提示组件
 * 悬停显示的信息提示
 */
import React, { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/shared/utils/cn';
import { useAutoCleanupTimer } from '@/shared/hooks/useComponentCleanup';

export interface TooltipProps {
  content: React.ReactNode;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
  disabled?: boolean;
  className?: string;
  children: React.ReactElement;
}

const Tooltip: React.FC<TooltipProps> = ({
  content,
  placement = 'top',
  delay = 500,
  disabled = false,
  className,
  children,
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const triggerRef = useRef<HTMLElement>(null);
  const timeoutRef = useRef<NodeJS.Timeout>();

  useAutoCleanupTimer(() => {
    setIsVisible(true);
  }, isVisible ? null : delay);

  const handleMouseEnter = (e: React.MouseEvent) => {
    if (disabled) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const scrollX = window.pageXOffset;
    const scrollY = window.pageYOffset;

    // 计算tooltip位置
    let x = 0;
    let y = 0;

    switch (placement) {
      case 'top':
        x = rect.left + scrollX + rect.width / 2;
        y = rect.top + scrollY;
        break;
      case 'bottom':
        x = rect.left + scrollX + rect.width / 2;
        y = rect.bottom + scrollY;
        break;
      case 'left':
        x = rect.left + scrollX;
        y = rect.top + scrollY + rect.height / 2;
        break;
      case 'right':
        x = rect.right + scrollX;
        y = rect.top + scrollY + rect.height / 2;
        break;
    }

    setPosition({ x, y });

    // 延迟显示
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(() => {
      setIsVisible(true);
    }, delay);
  };

  const handleMouseLeave = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    setIsVisible(false);
  };

  const placementClasses = {
    top: 'transform -translate-x-1/2 -translate-y-full mb-2',
    bottom: 'transform -translate-x-1/2 mt-2',
    left: 'transform -translate-y-1/2 -translate-x-full mr-2',
    right: 'transform -translate-y-1/2 ml-2',
  };

  const arrowClasses = {
    top: 'top-full left-1/2 transform -translate-x-1/2 border-l-transparent border-r-transparent border-b-transparent border-t-gray-900',
    bottom: 'bottom-full left-1/2 transform -translate-x-1/2 border-l-transparent border-r-transparent border-t-transparent border-b-gray-900',
    left: 'left-full top-1/2 transform -translate-y-1/2 border-t-transparent border-b-transparent border-r-transparent border-l-gray-900',
    right: 'right-full top-1/2 transform -translate-y-1/2 border-t-transparent border-b-transparent border-l-transparent border-r-gray-900',
  };

  const tooltipContent = isVisible && (
    <div
      className={cn(
        'fixed z-50 px-2 py-1 text-xs text-white bg-gray-900 rounded shadow-lg pointer-events-none',
        'dark:bg-gray-700 dark:text-gray-200',
        placementClasses[placement],
        className
      )}
      style={{
        left: position.x,
        top: position.y,
      }}
    >
      {content}
      <div
        className={cn(
          'absolute w-0 h-0 border-4',
          arrowClasses[placement]
        )}
      />
    </div>
  );

  return (
    <>
      {React.cloneElement(children, {
        ref: triggerRef,
        onMouseEnter: handleMouseEnter,
        onMouseLeave: handleMouseLeave,
      })}
      {tooltipContent && createPortal(tooltipContent, document.body)}
    </>
  );
};

export { Tooltip };