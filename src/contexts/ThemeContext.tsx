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

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const dispatch = useAppDispatch();
  const themeMode = useAppSelector((state) => state.settings.themeMode);
  const themeStyleFromStore = useAppSelector((state) => state.settings.themeStyle);
  const [currentTheme, setCurrentTheme] = useState<Theme>('light');
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [settingsReady, setSettingsReady] = useState(false);
  
  // 主题风格状态，默认为 'legacy'
  const themeStyle: ThemeStyle = themeStyleFromStore || 'legacy';

  // 确保刷新后优先加载已保存的主题设置，避免短暂回退到默认主题
  useEffect(() => {
    dispatch(loadSettings() as any)
      .unwrap?.()
      .catch((err: unknown) => {
        console.warn('loadSettings failed in ThemeProvider', err);
      })
      .finally(() => setSettingsReady(true));
  }, [dispatch]);

  // 检测系统主题并设置当前主题
  useEffect(() => {
    if (!settingsReady) return;

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
  }, [themeMode, settingsReady]);

  // 应用主题到HTML元素（带过渡效果）
  useEffect(() => {
    if (!settingsReady) return;

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
  }, [currentTheme, settingsReady]);

  // 应用主题风格到HTML元素的 data-theme 属性
  useEffect(() => {
    if (!settingsReady) return;
    document.documentElement.dataset.theme = themeStyle;
  }, [themeStyle, settingsReady]);

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
