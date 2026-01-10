/**
 * 无障碍工具
 * 提供 WCAG 2.1 AA 级别的无障碍支持
 */

// ARIA 属性类型
export interface AriaProps {
  role?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  'aria-expanded'?: boolean;
  'aria-selected'?: boolean;
  'aria-hidden'?: boolean;
  'aria-disabled'?: boolean;
  'aria-busy'?: boolean;
  'aria-live'?: 'off' | 'polite' | 'assertive';
  'aria-atomic'?: boolean;
  'aria-relevant'?: 'additions' | 'removals' | 'text' | 'all';
  'aria-haspopup'?: boolean | 'menu' | 'listbox' | 'tree' | 'grid' | 'dialog';
  'aria-controls'?: string;
  'aria-owns'?: string;
  'aria-activedescendant'?: string;
  'aria-checked'?: boolean | 'mixed';
  'aria-pressed'?: boolean | 'mixed';
  'aria-current'?: boolean | 'page' | 'step' | 'location' | 'date' | 'time';
  'aria-sort'?: 'none' | 'ascending' | 'descending' | 'other';
  'aria-valuemin'?: number;
  'aria-valuemax'?: number;
  'aria-valuenow'?: number;
  'aria-valuetext'?: string;
  tabIndex?: number;
}

/**
 * 生成唯一的 ID
 */
let idCounter = 0;
export function generateId(prefix: string = 'a11y'): string {
  return `${prefix}-${++idCounter}`;
}

/**
 * 创建按钮的无障碍属性
 */
export function createButtonA11y(
  label: string,
  options: {
    disabled?: boolean;
    pressed?: boolean;
    expanded?: boolean;
    controls?: string;
    haspopup?: AriaProps['aria-haspopup'];
  } = {}
): AriaProps {
  return {
    role: 'button',
    'aria-label': label,
    'aria-disabled': options.disabled,
    'aria-pressed': options.pressed,
    'aria-expanded': options.expanded,
    'aria-controls': options.controls,
    'aria-haspopup': options.haspopup,
    tabIndex: options.disabled ? -1 : 0,
  };
}

/**
 * 创建可展开内容的无障碍属性
 */
export function createExpandableA11y(
  label: string,
  expanded: boolean,
  contentId: string
): { trigger: AriaProps; content: AriaProps } {
  return {
    trigger: {
      'aria-label': label,
      'aria-expanded': expanded,
      'aria-controls': contentId,
    },
    content: {
      role: 'region',
      'aria-labelledby': contentId,
      'aria-hidden': !expanded,
    },
  };
}

/**
 * 创建列表的无障碍属性
 */
export function createListA11y(
  label: string,
  options: {
    multiselectable?: boolean;
    orientation?: 'horizontal' | 'vertical';
  } = {}
): AriaProps {
  return {
    role: 'listbox',
    'aria-label': label,
    'aria-multiselectable': options.multiselectable,
    'aria-orientation': options.orientation,
  } as AriaProps;
}

/**
 * 创建列表项的无障碍属性
 */
export function createListItemA11y(
  label: string,
  options: {
    selected?: boolean;
    disabled?: boolean;
    index?: number;
    setSize?: number;
  } = {}
): AriaProps & { 'aria-posinset'?: number; 'aria-setsize'?: number } {
  return {
    role: 'option',
    'aria-label': label,
    'aria-selected': options.selected,
    'aria-disabled': options.disabled,
    'aria-posinset': options.index !== undefined ? options.index + 1 : undefined,
    'aria-setsize': options.setSize,
    tabIndex: options.selected ? 0 : -1,
  };
}

/**
 * 创建对话框的无障碍属性
 */
export function createDialogA11y(
  titleId: string,
  descriptionId?: string
): AriaProps {
  return {
    role: 'dialog',
    'aria-modal': true,
    'aria-labelledby': titleId,
    'aria-describedby': descriptionId,
  } as AriaProps & { 'aria-modal': boolean };
}

/**
 * 创建警告对话框的无障碍属性
 */
export function createAlertDialogA11y(
  titleId: string,
  descriptionId?: string
): AriaProps {
  return {
    role: 'alertdialog',
    'aria-modal': true,
    'aria-labelledby': titleId,
    'aria-describedby': descriptionId,
  } as AriaProps & { 'aria-modal': boolean };
}

/**
 * 创建进度条的无障碍属性
 */
export function createProgressA11y(
  label: string,
  value: number,
  options: {
    min?: number;
    max?: number;
    valueText?: string;
  } = {}
): AriaProps {
  const { min = 0, max = 100 } = options;
  return {
    role: 'progressbar',
    'aria-label': label,
    'aria-valuemin': min,
    'aria-valuemax': max,
    'aria-valuenow': value,
    'aria-valuetext': options.valueText || `${Math.round((value / max) * 100)}%`,
  };
}

/**
 * 创建状态消息的无障碍属性
 */
export function createStatusA11y(
  type: 'status' | 'alert' | 'log' = 'status'
): AriaProps {
  const liveValue = type === 'alert' ? 'assertive' : 'polite';
  return {
    role: type,
    'aria-live': liveValue,
    'aria-atomic': true,
  };
}

/**
 * 管理焦点陷阱
 */
export class FocusTrap {
  private container: HTMLElement;
  private firstFocusable: HTMLElement | null = null;
  private lastFocusable: HTMLElement | null = null;
  private previousActiveElement: Element | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.updateFocusableElements();
  }

  private updateFocusableElements(): void {
    const focusableSelectors = [
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(', ');

    const focusables = Array.from(
      this.container.querySelectorAll<HTMLElement>(focusableSelectors)
    ).filter(el => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });

    this.firstFocusable = focusables[0] || null;
    this.lastFocusable = focusables[focusables.length - 1] || null;
  }

  activate(): void {
    this.previousActiveElement = document.activeElement;
    this.container.addEventListener('keydown', this.handleKeyDown);
    this.firstFocusable?.focus();
  }

  deactivate(): void {
    this.container.removeEventListener('keydown', this.handleKeyDown);
    if (this.previousActiveElement instanceof HTMLElement) {
      this.previousActiveElement.focus();
    }
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab') return;

    this.updateFocusableElements();

    if (event.shiftKey) {
      if (document.activeElement === this.firstFocusable) {
        event.preventDefault();
        this.lastFocusable?.focus();
      }
    } else {
      if (document.activeElement === this.lastFocusable) {
        event.preventDefault();
        this.firstFocusable?.focus();
      }
    }
  };
}

/**
 * 屏幕阅读器通知
 */
export function announceToScreenReader(
  message: string,
  priority: 'polite' | 'assertive' = 'polite'
): void {
  const announcement = document.createElement('div');
  announcement.setAttribute('role', 'status');
  announcement.setAttribute('aria-live', priority);
  announcement.setAttribute('aria-atomic', 'true');
  announcement.className = 'sr-only';
  announcement.textContent = message;

  document.body.appendChild(announcement);

  // 延迟移除，确保屏幕阅读器能够读取
  setTimeout(() => {
    document.body.removeChild(announcement);
  }, 1000);
}

/**
 * 检查元素是否可聚焦
 */
export function isFocusable(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false;

  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') return false;

  const tabIndex = element.getAttribute('tabindex');
  if (tabIndex !== null && parseInt(tabIndex) < 0) return false;

  if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement || element instanceof HTMLButtonElement) {
    return !element.disabled;
  }

  if (element instanceof HTMLAnchorElement) {
    return element.href !== '';
  }

  return tabIndex !== null;
}

/**
 * 获取所有可聚焦元素
 */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const elements = container.querySelectorAll<HTMLElement>(
    'a, button, input, select, textarea, [tabindex]'
  );
  return Array.from(elements).filter(isFocusable);
}
