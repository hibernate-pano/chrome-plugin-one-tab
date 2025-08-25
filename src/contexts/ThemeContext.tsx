import React, { createContext, useContext, useEffect, useState } from 'react';
import { useAppSelector, useAppDispatch } from '@/app/store/hooks';
import { updateSettings, saveSettings } from '@/features/settings/store/settingsSlice';

type ThemeMode = 'light' | 'dark' | 'auto';
type Theme = 'light' | 'dark';

interface ThemeContextType {
  themeMode: ThemeMode;
  currentTheme: Theme;
  setThemeMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const dispatch = useAppDispatch();
  const themeMode = useAppSelector((state) => state.settings.themeMode);
  const [currentTheme, setCurrentTheme] = useState<Theme>('light');

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

  // 获取当前设置
  const settings = useAppSelector((state) => state.settings);

  // 更新主题模式
  const setThemeMode = (mode: ThemeMode) => {
    // 更新Redux状态
    dispatch(updateSettings({ themeMode: mode }));

    // 同时保存到存储
    dispatch(saveSettings({ ...settings, themeMode: mode }));
  };

  return (
    <ThemeContext.Provider value={{ themeMode, currentTheme, setThemeMode }}>
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
