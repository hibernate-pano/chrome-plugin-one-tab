import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useAppSelector, useAppDispatch } from '@/store/hooks';
import { updateSettings, saveSettings, loadSettings } from '@/store/slices/settingsSlice';
import { ThemeStyle } from '@/types/tab';

type ThemeMode = 'light' | 'dark' | 'auto';
type Theme = 'light' | 'dark';

interface ThemeContextType {
  themeMode: ThemeMode;
  currentTheme: Theme;
  setThemeMode: (mode: ThemeMode) => void;
  // 主题风格
  themeStyle: ThemeStyle;
  setThemeStyle: (style: ThemeStyle) => void;
  // 主题切换状态
  isTransitioning: boolean;
}

// 主题切换过渡时间 (ms)
const THEME_TRANSITION_DURATION = 250;

// 主题 <link> id — S2 P4 Task 4.5：动态 <link> 注入，避免 3 个主题同时打入 dist。
const THEME_LINK_ID = 'theme-stylesheet';

// S2 P4 Task 4.5：注入/切换主题 CSS。
// 首次切换有 50-100ms 加载，之后瞬切（同一会话内 id 已存在时只换 href）。
// CSP style-src 'self' 'unsafe-inline' — 走 chrome-extension:// 内置资源，OK。
function setThemeStylesheet(themeName: string): void {
  const existing = document.getElementById(THEME_LINK_ID) as HTMLLinkElement | null;
  if (existing) {
    // 已注入：直接换 href（同源，浏览器只换样式表，不重排）
    if (!existing.href.endsWith(`/themes/${themeName}.css`)) {
      existing.href = chrome.runtime.getURL(`themes/${themeName}.css`);
    }
    return;
  }
  const link = document.createElement('link');
  link.id = THEME_LINK_ID;
  link.rel = 'stylesheet';
  link.href = chrome.runtime.getURL(`themes/${themeName}.css`);
  document.head.appendChild(link);
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const dispatch = useAppDispatch();
  // S2 P1 Task 1.3: 直接从 settings slice 读 themeMode / themeStyle。
  // 不再独立 chrome.storage.local.get —— popup bootstrap 已经把 settings
  // 塞进 preloadedState，此处从 redux 读即可（settings slice 已经在 store 中）。
  // 同时：若 redux 还没拿到 settings（例如 options 页面或未来其它入口），
  // 走 loadSettings() 兜底拉一次。
  const themeModeFromStore = useAppSelector((state) => state.settings.themeMode);
  const themeStyleFromStore = useAppSelector((state) => state.settings.themeStyle);

  // 兜底：如果 settings 还没有 lastLoaded 标记（preloadedState 没传 settings
  // 或 settings 是默认空对象），仍然 loadSettings() 拉一次存储。
  // 旧实现里 settingsReady 标志是「chrome.storage.local 读盘完成」，但现在
  // settings 已经在 preloadedState 里——所以这个 effect 只在极端兜底时跑。
  useEffect(() => {
    dispatch(loadSettings() as any);
  }, [dispatch]);

  const [isTransitioning, setIsTransitioning] = useState(false);

  // themeMode / themeStyle 直接从 redux 读
  const themeMode: ThemeMode = themeModeFromStore;
  const themeStyle: ThemeStyle = themeStyleFromStore || 'aurora';

  // 派生 currentTheme：auto 时跟随系统，其它取 themeMode
  const [currentTheme, setCurrentTheme] = useState<Theme>(() => {
    if (themeMode === 'dark') return 'dark';
    if (themeMode === 'light') return 'light';
    if (themeMode === 'auto') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'light';
  });

  // 检测系统主题并设置当前主题
  useEffect(() => {
    const setThemeBasedOnMode = () => {
      if (themeMode === 'auto') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        setCurrentTheme(prefersDark ? 'dark' : 'light');
      } else {
        setCurrentTheme(themeMode as Theme);
      }
    };

    setThemeBasedOnMode();

    // 监听系统主题变化
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      if (themeMode === 'auto') {
        setCurrentTheme(mediaQuery.matches ? 'dark' : 'light');
      }
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [themeMode]);

  // 应用主题到HTML元素（带过渡效果）
  useEffect(() => {
    const root = document.documentElement;

    // 添加过渡类
    root.style.setProperty('--theme-transition', `${THEME_TRANSITION_DURATION}ms`);
    root.classList.add('theme-transitioning');
    setIsTransitioning(true);

    // 应用主题
    if (currentTheme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }

    // 移除过渡类
    const timer = setTimeout(() => {
      root.classList.remove('theme-transitioning');
      setIsTransitioning(false);
    }, THEME_TRANSITION_DURATION);

    return () => clearTimeout(timer);
  }, [currentTheme]);

  // 应用主题风格到HTML元素的 data-theme 属性
  // S2 P4 Task 4.5：同时动态注入主题 CSS（lazy <link>）
  useEffect(() => {
    document.documentElement.dataset.theme = themeStyle;
    setThemeStylesheet(themeStyle);
  }, [themeStyle]);

  // 更新主题模式
  const setThemeMode = useCallback((mode: ThemeMode) => {
    // 更新Redux状态（会自动触发保存到存储）
    dispatch(updateSettings({ themeMode: mode }));

    // 保存到存储 - 使用 thunk 从 store 获取最新状态
    dispatch(saveSettings() as any);
  }, [dispatch]);

  // 更新主题风格（保留当前明暗模式）
  const setThemeStyle = useCallback((style: ThemeStyle) => {
    const root = document.documentElement;

    // 添加过渡效果
    root.classList.add('theme-transitioning');
    setIsTransitioning(true);

    // 同步更新 DOM data-theme 属性（即时应用）
    root.dataset.theme = style;

    // 更新Redux状态（会自动触发保存到存储）
    dispatch(updateSettings({ themeStyle: style }));

    // 保存到存储 - 使用 thunk 从 store 获取最新状态
    dispatch(saveSettings() as any);

    // 移除过渡类
    setTimeout(() => {
      root.classList.remove('theme-transitioning');
      setIsTransitioning(false);
    }, THEME_TRANSITION_DURATION);
  }, [dispatch]);

  return (
    <ThemeContext.Provider value={{
      themeMode,
      currentTheme,
      setThemeMode,
      themeStyle,
      setThemeStyle,
      isTransitioning
    }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};
