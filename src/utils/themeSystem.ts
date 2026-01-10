// 增强的主题系统

/**
 * 增强的主题系统
 * 提供动态主题切换、主题变量管理和主题定制功能
 */

export type ThemeMode = 'light' | 'dark' | 'auto';
export type ThemeStyle = 'classic' | 'refined' | 'aurora' | 'legacy' | 'creamy' | 'pink' | 'mint' | 'cyberpunk';

export interface ThemeConfig {
  mode: ThemeMode;
  style: ThemeStyle;
  customColors?: Record<string, string>;
  customFonts?: {
    primary?: string;
    secondary?: string;
    mono?: string;
  };
  animations?: boolean;
  reducedMotion?: boolean;
}

export interface ThemeVariables {
  // 基础颜色
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  surface: string;
  text: string;
  textSecondary: string;
  border: string;
  error: string;
  warning: string;
  success: string;
  info: string;

  // 语义化颜色
  cardBackground: string;
  inputBackground: string;
  buttonPrimary: string;
  buttonSecondary: string;
  link: string;
  focus: string;

  // 字体
  fontFamily: string;
  fontSize: {
    xs: string;
    sm: string;
    base: string;
    lg: string;
    xl: string;
    '2xl': string;
    '3xl': string;
  };

  // 间距
  spacing: {
    xs: string;
    sm: string;
    md: string;
    lg: string;
    xl: string;
    '2xl': string;
  };

  // 圆角
  borderRadius: {
    none: string;
    sm: string;
    md: string;
    lg: string;
    xl: string;
    full: string;
  };

  // 阴影
  shadow: {
    sm: string;
    md: string;
    lg: string;
    xl: string;
  };

  // 动画
  transition: {
    fast: string;
    normal: string;
    slow: string;
  };
}

/**
 * 预定义主题样式
 */
const THEME_STYLES: Record<ThemeStyle, Partial<ThemeVariables>> = {
  classic: {
    primary: '#3b82f6',
    secondary: '#6b7280',
    accent: '#8b5cf6',
    background: '#ffffff',
    surface: '#f9fafb',
    text: '#111827',
    textSecondary: '#6b7280',
    border: '#e5e7eb',
    error: '#ef4444',
    warning: '#f59e0b',
    success: '#10b981',
    info: '#3b82f6',
    cardBackground: '#ffffff',
    inputBackground: '#ffffff',
    buttonPrimary: '#3b82f6',
    buttonSecondary: '#6b7280',
    link: '#3b82f6',
    focus: '#3b82f6',
  },
  refined: {
    primary: '#2563eb',
    secondary: '#64748b',
    accent: '#7c3aed',
    background: '#fafafa',
    surface: '#ffffff',
    text: '#0f172a',
    textSecondary: '#64748b',
    border: '#e2e8f0',
    error: '#dc2626',
    warning: '#d97706',
    success: '#059669',
    info: '#2563eb',
    cardBackground: '#ffffff',
    inputBackground: '#f8fafc',
    buttonPrimary: '#2563eb',
    buttonSecondary: '#64748b',
    link: '#2563eb',
    focus: '#2563eb',
  },
  aurora: {
    primary: '#06b6d4',
    secondary: '#64748b',
    accent: '#8b5cf6',
    background: '#0f0f23',
    surface: '#1a1a2e',
    text: '#e0e7ff',
    textSecondary: '#94a3b8',
    border: '#334155',
    error: '#ef4444',
    warning: '#f59e0b',
    success: '#10b981',
    info: '#06b6d4',
    cardBackground: '#1a1a2e',
    inputBackground: '#16213e',
    buttonPrimary: '#06b6d4',
    buttonSecondary: '#64748b',
    link: '#06b6d4',
    focus: '#06b6d4',
  },
  legacy: {
    primary: '#007acc',
    secondary: '#6c757d',
    accent: '#28a745',
    background: '#ffffff',
    surface: '#f8f9fa',
    text: '#212529',
    textSecondary: '#6c757d',
    border: '#dee2e6',
    error: '#dc3545',
    warning: '#ffc107',
    success: '#28a745',
    info: '#17a2b8',
    cardBackground: '#ffffff',
    inputBackground: '#ffffff',
    buttonPrimary: '#007acc',
    buttonSecondary: '#6c757d',
    link: '#007acc',
    focus: '#007acc',
  },
  creamy: {
    primary: '#d4a574',
    secondary: '#6b5b4f',
    accent: '#d4a574',
    background: '#fffef7',
    surface: '#ffffff',
    text: '#4a3c31',
    textSecondary: '#6b5b4f',
    border: '#f0e6d3',
    error: '#e74c3c',
    warning: '#e6a23c',
    success: '#67c23a',
    info: '#409eff',
    cardBackground: '#ffffff',
    inputBackground: '#ffffff',
    buttonPrimary: '#d4a574',
    buttonSecondary: '#6b5b4f',
    link: '#d4a574',
    focus: '#d4a574',
  },
  pink: {
    primary: '#e891a8',
    secondary: '#6b5a63',
    accent: '#e891a8',
    background: '#fff5f7',
    surface: '#ffffff',
    text: '#4a3c42',
    textSecondary: '#6b5a63',
    border: '#f5e0e8',
    error: '#e85a7a',
    warning: '#f0a875',
    success: '#7dd3a0',
    info: '#f0a8c0',
    cardBackground: '#ffffff',
    inputBackground: '#ffffff',
    buttonPrimary: '#e891a8',
    buttonSecondary: '#6b5a63',
    link: '#e891a8',
    focus: '#e891a8',
  },
  mint: {
    primary: '#38b2ac',
    secondary: '#2d6a6a',
    accent: '#38b2ac',
    background: '#f0fdf9',
    surface: '#ffffff',
    text: '#134e4a',
    textSecondary: '#2d6a6a',
    border: '#d1e7dd',
    error: '#fc8181',
    warning: '#f6ad55',
    success: '#68d391',
    info: '#5eead4',
    cardBackground: '#ffffff',
    inputBackground: '#ffffff',
    buttonPrimary: '#38b2ac',
    buttonSecondary: '#2d6a6a',
    link: '#38b2ac',
    focus: '#38b2ac',
  },
  cyberpunk: {
    primary: '#d946ef',
    secondary: '#a0a0c0',
    accent: '#00fff7',
    background: '#0a0a0f',
    surface: '#1a1a25',
    text: '#e0e0ff',
    textSecondary: '#a0a0c0',
    border: 'rgba(255, 0, 255, 0.2)',
    error: '#ff3366',
    warning: '#ffff00',
    success: '#00ff88',
    info: '#00fff7',
    cardBackground: '#12121a',
    inputBackground: '#1a1a25',
    buttonPrimary: '#d946ef',
    buttonSecondary: '#bf00ff',
    link: '#00fff7',
    focus: '#00fff7',
  },
};

/**
 * 主题模式调整器
 */
function applyThemeMode(baseTheme: ThemeVariables, mode: ThemeMode): ThemeVariables {
  if (mode === 'light') return baseTheme;

  if (mode === 'dark') {
    return {
      ...baseTheme,
      background: '#0f172a',
      surface: '#1e293b',
      text: '#f1f5f9',
      textSecondary: '#94a3b8',
      border: '#334155',
      cardBackground: '#1e293b',
      inputBackground: '#0f172a',
    };
  }

  // auto mode - 检测系统偏好
  if (typeof window !== 'undefined' && window.matchMedia) {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    return applyThemeMode(baseTheme, prefersDark ? 'dark' : 'light');
  }

  return baseTheme;
}

/**
 * 主题生成器
 */
export class ThemeGenerator {
  static generateTheme(config: ThemeConfig): ThemeVariables {
    const baseTheme = THEME_STYLES[config.style] as ThemeVariables;

    // 合并默认值
    const defaultTheme: ThemeVariables = {
      ...baseTheme,
      fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: {
        xs: '0.75rem',
        sm: '0.875rem',
        base: '1rem',
        lg: '1.125rem',
        xl: '1.25rem',
        '2xl': '1.5rem',
        '3xl': '1.875rem',
      },
      spacing: {
        xs: '0.25rem',
        sm: '0.5rem',
        md: '1rem',
        lg: '1.5rem',
        xl: '2rem',
        '2xl': '3rem',
      },
      borderRadius: {
        none: '0',
        sm: '0.125rem',
        md: '0.375rem',
        lg: '0.5rem',
        xl: '0.75rem',
        full: '9999px',
      },
      shadow: {
        sm: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
        md: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
        lg: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
        xl: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
      },
      transition: {
        fast: '150ms ease-in-out',
        normal: '300ms ease-in-out',
        slow: '500ms ease-in-out',
      },
    };

    // 应用主题模式
    let theme = applyThemeMode(defaultTheme, config.mode);

    // 应用自定义颜色
    if (config.customColors) {
      theme = { ...theme, ...config.customColors };
    }

    // 应用自定义字体
    if (config.customFonts) {
      if (config.customFonts.primary) {
        theme.fontFamily = config.customFonts.primary;
      }
    }

    // 处理动画偏好
    if (
      config.reducedMotion ||
      (typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
    ) {
      theme.transition = {
        fast: '0ms',
        normal: '0ms',
        slow: '0ms',
      };
    }

    return theme;
  }

  /**
   * 应用主题到DOM
   */
  static applyTheme(theme: ThemeVariables): void {
    if (typeof document === 'undefined') return;

    const root = document.documentElement;
    const cssVariables: Record<string, string> = {};

    // 转换主题变量为CSS变量
    Object.entries(theme).forEach(([key, value]) => {
      if (typeof value === 'string') {
        cssVariables[`--theme-${key}`] = value;
      } else if (typeof value === 'object' && value !== null) {
        Object.entries(value).forEach(([subKey, subValue]) => {
          if (typeof subValue === 'string') {
            cssVariables[`--theme-${key}-${subKey}`] = subValue;
          }
        });
      }
    });

    // 应用CSS变量
    Object.entries(cssVariables).forEach(([property, value]) => {
      root.style.setProperty(property, value);
    });

    // 设置主题类
    root.setAttribute('data-theme-mode', 'custom');
  }

  /**
   * 获取当前主题
   */
  static getCurrentTheme(): ThemeVariables | null {
    // 这里可以实现从CSS变量读取主题的逻辑
    // 暂时返回null，需要时实现
    return null;
  }

  /**
   * 创建主题变体
   */
  static createThemeVariant(
    baseTheme: ThemeVariables,
    overrides: Partial<ThemeVariables>
  ): ThemeVariables {
    return { ...baseTheme, ...overrides };
  }
}

/**
 * 主题切换器
 */
export class ThemeSwitcher {
  private static currentConfig: ThemeConfig | null = null;
  private static listeners: ((theme: ThemeVariables) => void)[] = [];

  static initialize(config: ThemeConfig): void {
    this.currentConfig = config;
    this.applyTheme();
    this.setupSystemThemeWatcher();
  }

  static updateConfig(config: Partial<ThemeConfig>): void {
    if (!this.currentConfig) return;

    this.currentConfig = { ...this.currentConfig, ...config };
    this.applyTheme();
  }

  static getCurrentConfig(): ThemeConfig | null {
    return this.currentConfig;
  }

  static applyTheme(): void {
    if (!this.currentConfig) return;

    const theme = ThemeGenerator.generateTheme(this.currentConfig);
    ThemeGenerator.applyTheme(theme);

    // 通知监听者
    this.listeners.forEach(listener => {
      try {
        listener(theme);
      } catch (error) {
        console.error('Theme listener error:', error);
      }
    });
  }

  static addListener(callback: (theme: ThemeVariables) => void): () => void {
    this.listeners.push(callback);

    // 如果已有主题，立即调用
    if (this.currentConfig) {
      const theme = ThemeGenerator.generateTheme(this.currentConfig);
      callback(theme);
    }

    // 返回移除函数
    return () => {
      const index = this.listeners.indexOf(callback);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  private static setupSystemThemeWatcher(): void {
    if (typeof window === 'undefined' || !window.matchMedia) return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

    const handleChange = () => {
      if (this.currentConfig?.mode === 'auto') {
        this.applyTheme();
      }
    };

    mediaQuery.addEventListener('change', handleChange);
  }

  /**
   * 获取推荐的主题配置
   */
  static getRecommendedConfig(): ThemeConfig {
    const prefersDark =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;

    return {
      mode: prefersDark ? 'dark' : 'light',
      style: 'refined',
      animations: true,
      reducedMotion:
        typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    };
  }
}

/**
 * 主题预设
 */
export const THEME_PRESETS = {
  light: {
    mode: 'light' as const,
    style: 'refined' as const,
  },
  dark: {
    mode: 'dark' as const,
    style: 'aurora' as const,
  },
  auto: {
    mode: 'auto' as const,
    style: 'refined' as const,
  },
  classic: {
    mode: 'light' as const,
    style: 'classic' as const,
  },
  legacy: {
    mode: 'light' as const,
    style: 'legacy' as const,
  },
} as const;
