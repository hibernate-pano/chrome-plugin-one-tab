/**
 * 可访问性工具和组件
 * 提供ARIA支持和键盘导航
 */

import React from 'react';

/**
 * 键盘导航Hook
 */
export function useKeyboardNavigation(
  items: any[],
  onSelect: (index: number) => void,
  options: {
    loop?: boolean;
    autoFocus?: boolean;
  } = {}
) {
  const [focusedIndex, setFocusedIndex] = React.useState(0);
  const { loop = true, autoFocus = false } = options;

  React.useEffect(() => {
    if (autoFocus && items.length > 0) {
      setFocusedIndex(0);
    }
  }, [autoFocus, items.length]);

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent) => {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setFocusedIndex(prev => {
            const next = prev + 1;
            if (next >= items.length) {
              return loop ? 0 : prev;
            }
            return next;
          });
          break;

        case 'ArrowUp':
          event.preventDefault();
          setFocusedIndex(prev => {
            const next = prev - 1;
            if (next < 0) {
              return loop ? items.length - 1 : 0;
            }
            return next;
          });
          break;

        case 'Enter':
        case ' ':
          event.preventDefault();
          onSelect(focusedIndex);
          break;

        case 'Home':
          event.preventDefault();
          setFocusedIndex(0);
          break;

        case 'End':
          event.preventDefault();
          setFocusedIndex(items.length - 1);
          break;

        case 'Escape':
          event.preventDefault();
          setFocusedIndex(-1);
          break;
      }
    },
    [focusedIndex, items.length, loop, onSelect]
  );

  return {
    focusedIndex,
    setFocusedIndex,
    handleKeyDown,
  };
}

/**
 * 焦点陷阱Hook - 将焦点限制在指定元素内
 */
export function useFocusTrap(active: boolean = true) {
  const containerRef = React.useRef<HTMLElement>(null);

  React.useEffect(() => {
    if (!active || !containerRef.current) return;

    const container = containerRef.current;
    const focusableElements = container.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    const handleTabKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;

      if (e.shiftKey) {
        // Shift + Tab
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement?.focus();
        }
      } else {
        // Tab
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement?.focus();
        }
      }
    };

    container.addEventListener('keydown', handleTabKey);
    firstElement?.focus();

    return () => {
      container.removeEventListener('keydown', handleTabKey);
    };
  }, [active]);

  return containerRef;
}

/**
 * 屏幕阅读器通知Hook
 */
export function useAnnouncement() {
  const [announcement, setAnnouncement] = React.useState('');

  const announce = React.useCallback((message: string, _politeness: 'polite' | 'assertive' = 'polite') => {
    setAnnouncement(`${message}__${Date.now()}`); // 添加时间戳确保更新
  }, []);

  return {
    announce,
    announcementElement: announcement ? (
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement.split('__')[0]}
      </div>
    ) : null,
  };
}

/**
 * 跳过导航链接组件
 */
export const SkipToContent: React.FC<{ contentId: string }> = ({ contentId }) => {
  return (
    <a
      href={`#${contentId}`}
      className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:px-4 focus:py-2 focus:bg-primary-600 focus:text-white focus:rounded"
    >
      跳转到主内容
    </a>
  );
};

/**
 * 可访问的模态框组件
 */
interface AccessibleModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  className?: string;
}

export const AccessibleModal: React.FC<AccessibleModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  className = '',
}) => {
  const modalRef = useFocusTrap(isOpen);
  const titleId = React.useId();

  React.useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }

    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  React.useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      {/* 背景遮罩 */}
      <div
        className="absolute inset-0 bg-black bg-opacity-50"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* 模态框内容 */}
      <div
        ref={modalRef as any}
        className={`relative bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full mx-4 ${className}`}
      >
        <div className="p-6">
          <h2 id={titleId} className="text-xl font-bold mb-4">
            {title}
          </h2>

          <div>{children}</div>

          <button
            onClick={onClose}
            className="absolute top-4 right-4 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            aria-label="关闭对话框"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * 可访问的工具提示组件
 */
interface TooltipProps {
  content: string;
  children: React.ReactNode;
  position?: 'top' | 'bottom' | 'left' | 'right';
}

export const AccessibleTooltip: React.FC<TooltipProps> = ({
  content,
  children,
  position = 'top',
}) => {
  const [isVisible, setIsVisible] = React.useState(false);
  const tooltipId = React.useId();

  const positionClasses = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
    left: 'right-full top-1/2 -translate-y-1/2 mr-2',
    right: 'left-full top-1/2 -translate-y-1/2 ml-2',
  };

  return (
    <div className="relative inline-block">
      <div
        onMouseEnter={() => setIsVisible(true)}
        onMouseLeave={() => setIsVisible(false)}
        onFocus={() => setIsVisible(true)}
        onBlur={() => setIsVisible(false)}
        aria-describedby={isVisible ? tooltipId : undefined}
      >
        {children}
      </div>

      {isVisible && (
        <div
          id={tooltipId}
          role="tooltip"
          className={`absolute ${positionClasses[position]} px-3 py-2 text-sm text-white bg-gray-900 rounded shadow-lg whitespace-nowrap z-50`}
        >
          {content}
          <div
            className="absolute w-2 h-2 bg-gray-900 transform rotate-45"
            style={{
              [position === 'top' ? 'bottom' : position === 'bottom' ? 'top' : position === 'left' ? 'right' : 'left']: '-4px',
              ...((position === 'top' || position === 'bottom') && { left: '50%', marginLeft: '-4px' }),
              ...((position === 'left' || position === 'right') && { top: '50%', marginTop: '-4px' }),
            }}
          />
        </div>
      )}
    </div>
  );
};

/**
 * 仅对屏幕阅读器可见的文本
 */
export const VisuallyHidden: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <span className="sr-only">
      {children}
    </span>
  );
};

/**
 * 检查可访问性的工具函数
 */
export function checkAccessibility(element: HTMLElement): string[] {
  const issues: string[] = [];

  // 检查图片是否有alt属性
  const images = element.querySelectorAll('img');
  images.forEach((img, index) => {
    if (!img.alt) {
      issues.push(`图片 ${index + 1} 缺少alt属性`);
    }
  });

  // 检查按钮是否有可访问的名称
  const buttons = element.querySelectorAll('button');
  buttons.forEach((button, index) => {
    const hasText = button.textContent && button.textContent.trim().length > 0;
    const hasAriaLabel = button.hasAttribute('aria-label');
    const hasAriaLabelledBy = button.hasAttribute('aria-labelledby');

    if (!hasText && !hasAriaLabel && !hasAriaLabelledBy) {
      issues.push(`按钮 ${index + 1} 缺少可访问的名称`);
    }
  });

  // 检查输入框是否有label
  const inputs = element.querySelectorAll('input, select, textarea');
  inputs.forEach((input, index) => {
    const hasLabel = input.hasAttribute('id') && element.querySelector(`label[for="${input.id}"]`);
    const hasAriaLabel = input.hasAttribute('aria-label');
    const hasAriaLabelledBy = input.hasAttribute('aria-labelledby');

    if (!hasLabel && !hasAriaLabel && !hasAriaLabelledBy) {
      issues.push(`输入框 ${index + 1} 缺少label`);
    }
  });

  // 检查标题层级
  const headings = Array.from(element.querySelectorAll('h1, h2, h3, h4, h5, h6'));
  let lastLevel = 0;
  headings.forEach((heading, index) => {
    const level = parseInt(heading.tagName.substring(1));
    if (level - lastLevel > 1) {
      issues.push(`标题 ${index + 1} 跳过了层级（从h${lastLevel}到h${level}）`);
    }
    lastLevel = level;
  });

  return issues;
}
