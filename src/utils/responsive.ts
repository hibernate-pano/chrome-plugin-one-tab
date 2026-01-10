/**
 * 响应式设计工具
 * 提供断点检测、响应式值管理和自适应布局功能
 */

export type Breakpoint = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';

export interface ResponsiveConfig {
  breakpoints: Record<Breakpoint, number>;
  containerWidths: Record<Breakpoint, number>;
}

const DEFAULT_CONFIG: ResponsiveConfig = {
  breakpoints: {
    xs: 0,
    sm: 640,
    md: 768,
    lg: 1024,
    xl: 1280,
    '2xl': 1536,
  },
  containerWidths: {
    xs: 320,
    sm: 640,
    md: 768,
    lg: 1024,
    xl: 1280,
    '2xl': 1536,
  },
};

/**
 * 获取当前断点
 */
export function getCurrentBreakpoint(): Breakpoint {
  const width = window.innerWidth;
  const breakpoints = DEFAULT_CONFIG.breakpoints;

  if (width >= breakpoints['2xl']) return '2xl';
  if (width >= breakpoints.xl) return 'xl';
  if (width >= breakpoints.lg) return 'lg';
  if (width >= breakpoints.md) return 'md';
  if (width >= breakpoints.sm) return 'sm';
  return 'xs';
}

/**
 * 检查是否为移动设备
 */
export function isMobile(): boolean {
  return window.innerWidth < DEFAULT_CONFIG.breakpoints.md;
}

/**
 * 检查是否为平板设备
 */
export function isTablet(): boolean {
  const width = window.innerWidth;
  return width >= DEFAULT_CONFIG.breakpoints.md && width < DEFAULT_CONFIG.breakpoints.lg;
}

/**
 * 检查是否为桌面设备
 */
export function isDesktop(): boolean {
  return window.innerWidth >= DEFAULT_CONFIG.breakpoints.lg;
}

/**
 * 获取设备方向
 */
export function getOrientation(): 'portrait' | 'landscape' {
  return window.innerHeight > window.innerWidth ? 'portrait' : 'landscape';
}

/**
 * 响应式值工具
 * 根据当前断点返回相应的值
 */
export function getResponsiveValue<T>(values: Partial<Record<Breakpoint, T>>): T | undefined {
  const currentBreakpoint = getCurrentBreakpoint();

  // 按优先级查找值：当前断点 -> 更小的断点 -> 默认值
  const breakpoints: Breakpoint[] = ['xs', 'sm', 'md', 'lg', 'xl', '2xl'];
  const currentIndex = breakpoints.indexOf(currentBreakpoint);

  for (let i = currentIndex; i >= 0; i--) {
    const breakpoint = breakpoints[i];
    if (values[breakpoint] !== undefined) {
      return values[breakpoint];
    }
  }

  return undefined;
}

/**
 * 响应式样式工具
 */
export class ResponsiveStyles {
  static getContainerWidth(breakpoint: Breakpoint): number {
    return DEFAULT_CONFIG.containerWidths[breakpoint];
  }

  static getMaxWidth(breakpoint: Breakpoint): string {
    return `${DEFAULT_CONFIG.containerWidths[breakpoint]}px`;
  }

  static createResponsiveClass(
    baseClass: string,
    responsiveClasses: Partial<Record<Breakpoint, string>>
  ): string {
    const classes = [baseClass];

    Object.entries(responsiveClasses).forEach(([breakpoint, responsiveClass]) => {
      if (responsiveClass) {
        classes.push(`${breakpoint}:${responsiveClass}`);
      }
    });

    return classes.join(' ');
  }

  static createGridClasses(columns: Partial<Record<Breakpoint, number>>): string {
    const classes: string[] = [];

    Object.entries(columns).forEach(([breakpoint, cols]) => {
      if (breakpoint === 'xs') {
        classes.push(`grid-cols-${cols}`);
      } else {
        classes.push(`${breakpoint}:grid-cols-${cols}`);
      }
    });

    return classes.join(' ');
  }

  static createSpacingClasses(spacing: Partial<Record<Breakpoint, string>>): string {
    const classes: string[] = [];

    Object.entries(spacing).forEach(([breakpoint, space]) => {
      if (breakpoint === 'xs') {
        classes.push(`gap-${space}`);
      } else {
        classes.push(`${breakpoint}:gap-${space}`);
      }
    });

    return classes.join(' ');
  }
}

/**
 * 媒体查询工具
 */
export function matchMediaQuery(query: string): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia(query).matches;
}

/**
 * 常用媒体查询检查
 */
export const mediaQueries = {
  isMobile: () => matchMediaQuery('(max-width: 767px)'),
  isTablet: () => matchMediaQuery('(min-width: 768px) and (max-width: 1023px)'),
  isDesktop: () => matchMediaQuery('(min-width: 1024px)'),
  isLargeDesktop: () => matchMediaQuery('(min-width: 1280px)'),

  prefersDark: () => matchMediaQuery('(prefers-color-scheme: dark)'),
  prefersLight: () => matchMediaQuery('(prefers-color-scheme: light)'),
  prefersReducedMotion: () => matchMediaQuery('(prefers-reduced-motion: reduce)'),
};
