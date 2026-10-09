import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useAppSelector, useAppDispatch } from '@/store/hooks';
import { updateSettings, dispatchSaveSettings, loadSettings } from '@/store/slices/settingsSlice';
import { useToast } from '@/contexts/ToastContext';
import { ThemeStyle } from '@/types/tab';
import { logWarn } from '../utils/log';

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
  // ThemeProvider 嵌在 ToastProvider 内（见 AppContainer），所以这里可用 toast。
  // 加载失败与保存失败都要出声：否则「读失败 → Redux 停在默认值 →
   // 用户改动后默认值被写盘覆盖真实设置」这条链路用户全程看不见。
  const { showToast } = useToast();

  // 主题风格状态，默认为 'legacy'
  const themeStyle: ThemeStyle = themeStyleFromStore || 'legacy';

  /**
   * 保存设置并把失败说出来（2026-10-09 P1-3 / P2-1）。
   *
   * 两处主题回调都在同步路径里，原来直接 `dispatch(saveSettings())` 就走人——
   * dispatch 永远 resolve，所以写失败时**没有任何人知道**：开关停在新状态、
   * 刷新后回退，用户以为已经保存。这里统一走 helper，判据只写一处。
   */
  const persistSettings = useCallback(() => {
    void dispatchSaveSettings(dispatch).then(saveError => {
      if (saveError) showToast(saveError, 'error');
    });
  }, [dispatch, showToast]);

  // 确保刷新后优先加载已保存的主题设置，避免短暂回退到默认主题
  useEffect(() => {
    dispatch(loadSettings() as any)
      .unwrap?.()
      .catch((err: unknown) => {
        logWarn('loadSettings failed in ThemeProvider', err);
        // 读失败必须出声：沉默会让用户以为「我本来就没有设置」，
        // 而真实情况是「读不到，界面此刻显示的是出厂默认值」。
        // 这正是后续 saveSettings 用默认值覆盖真值那条链路的起点。
        showToast('设置读取失败，当前显示的是默认值；本次改动可能无法保存', 'error');
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
    persistSettings();
  }, [dispatch, persistSettings]);

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
    persistSettings();
    
    // 移除过渡类
    setTimeout(() => {
      root.classList.remove('theme-transitioning');
      setIsTransitioning(false);
    }, THEME_TRANSITION_DURATION);
  }, [dispatch, persistSettings]);

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
