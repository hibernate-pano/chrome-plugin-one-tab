import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useAppSelector, useAppDispatch } from '@/store/hooks';
import { updateSettings, saveSettings, loadSettings, initialSettingsState } from '@/store/slices/settingsSlice';
import { ThemeStyle } from '@/types/tab';
import { resolveThemeMode } from '@/utils/themeUtils';

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
  const themeModeFromStore = useAppSelector((state) => state.settings.themeMode);
  const themeStyleFromStore = useAppSelector((state) => state.settings.themeStyle);
  const settingsFromStore = useAppSelector((state) => state.settings);

  // S2 F7（单源化兜底）：settings 已由 popup bootstrap 注入 preloadedState
  // 时（`state.settings` 与 `initialSettingsState` 引用不同），不再重复读盘；
  // 仅当入口未 preload settings（options 页 / 未来其它入口 / hydrate 失败降级）
  // 时——settings 仍是 initialSettingsState——才兜底 loadSettings() 拉一次，
  // 防设置丢失。loadSettings fulfilled 后 settings 换成新对象，effect 不再触发。
  useEffect(() => {
    if (settingsFromStore === initialSettingsState) {
      dispatch(loadSettings() as any);
    }
  }, [settingsFromStore, dispatch]);

  const [isTransitioning, setIsTransitioning] = useState(false);

  // themeMode / themeStyle 直接从 redux 读
  const themeMode: ThemeMode = themeModeFromStore;
  const themeStyle: ThemeStyle = themeStyleFromStore || 'aurora';

  // 派生 currentTheme：auto 时跟随系统，其它取 themeMode
  // S3 §2：使用纯函数 resolveThemeMode 处理 auto → dark/light 的折叠逻辑
  // （与 ThemeContext 解耦，方便单测覆盖）
  const [currentTheme, setCurrentTheme] = useState<Theme>(() => {
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    return resolveThemeMode(themeMode, systemDark);
  });

  // 检测系统主题并设置当前主题
  useEffect(() => {
    const setThemeBasedOnMode = () => {
      const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      setCurrentTheme(resolveThemeMode(themeMode, systemDark));
    };

    setThemeBasedOnMode();

    // 监听系统主题变化（仅 auto 模式有意义，但 listener 注册是廉价的，
    // effect 依赖 [themeMode] 在模式切换时自动 cleanup）。
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      if (themeMode === 'auto') {
        setCurrentTheme(resolveThemeMode('auto', mediaQuery.matches));
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
