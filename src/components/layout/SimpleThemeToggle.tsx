import React from 'react';
import { useTheme } from '@/contexts/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { saveSettings } from '@/store/slices/settingsSlice';
import { Tooltip } from '@/components/common/Tooltip';

// 太阳图标
const SunIcon = () => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
  </svg>
);

// 月亮图标
const MoonIcon = () => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
  </svg>
);

export const SimpleThemeToggle: React.FC = () => {
  const dispatch = useAppDispatch();
  const { themeMode, setThemeMode } = useTheme();
  const settings = useAppSelector(state => state.settings);

  const toggleTheme = () => {
    const newMode = themeMode === 'light' ? 'dark' : 'light';
    setThemeMode(newMode);

    dispatch(saveSettings({ ...settings, themeMode: newMode }))
      .then(() => {
        console.log('主题设置已保存:', newMode);
      })
      .catch(error => {
        console.error('保存主题设置失败:', error);
      });
  };

  return (
    <Tooltip
      content={themeMode === 'light' ? '切换深色模式' : '切换浅色模式'}
      position="bottom"
    >
      <button
        onClick={toggleTheme}
        className="btn-icon"
        aria-label={themeMode === 'light' ? '切换到深色模式' : '切换到浅色模式'}
      >
        {themeMode === 'dark' ? <MoonIcon /> : <SunIcon />}
      </button>
    </Tooltip>
  );
};

export default SimpleThemeToggle;
