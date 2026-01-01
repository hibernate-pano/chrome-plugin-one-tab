import React, { createContext, useContext, useEffect, useState } from 'react';
import { useAppSelector, useAppDispatch } from '@/store/hooks';
import { updateSettings, saveSettings } from '@/store/slices/settingsSlice';
import { ThemeStyle } from '@/types/tab';

type ThemeMode = 'light' | 'dark' | 'auto';
type Theme = 'light' | 'dark';

interface ThemeContextType {
  themeMode: ThemeMode;
  currentTheme: Theme;
  setThemeMode: (mode: ThemeMode) => void;
  // 新增：主题风格
  themeStyle: ThemeStyle;
  setThemeStyle: (style: ThemeStyle) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const dispatch = useAppDispatch();
  const themeMode = useAppSelector((state) => state.settings.themeMode);
  const themeStyleFromStore = useAppSelector((state) => state.settings.themeStyle);
  const [currentTheme, setCurrentTheme] = useState<Theme>('light');
  
  // 主题风格状态，默认为 'refined'
  const themeStyle: ThemeStyle = themeStyleFromStore || 'refined';

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

  // 应用主题到HTML元素
  useEffect(() => {
    if (currentTheme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [currentTheme]);

  // 应用主题风格到HTML元素的 data-theme 属性
  useEffect(() => {
    document.documentElement.dataset.theme = themeStyle;
  }, [themeStyle]);

  // 获取当前设置
  const settings = useAppSelector((state) => state.settings);

  // 更新主题模式
  const setThemeMode = (mode: ThemeMode) => {
    // 更新Redux状态
    dispatch(updateSettings({ themeMode: mode }));

    // 同时保存到存储
    dispatch(saveSettings({ ...settings, themeMode: mode }));
  };

  // 更新主题风格（保留当前明暗模式）
  const setThemeStyle = (style: ThemeStyle) => {
    // 同步更新 DOM data-theme 属性（即时应用，无需等待异步操作）
    document.documentElement.dataset.theme = style;
    
    // 更新Redux状态
    dispatch(updateSettings({ themeStyle: style }));

    // 同时保存到存储
    dispatch(saveSettings({ ...settings, themeStyle: style }));
  };

  return (
    <ThemeContext.Provider value={{ themeMode, currentTheme, setThemeMode, themeStyle, setThemeStyle }}>
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
