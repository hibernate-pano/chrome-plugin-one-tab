import React from 'react';
import { useTheme } from '@/contexts/ThemeContext';
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
  const { currentTheme, setThemeMode } = useTheme();

  // 判定一律基于 currentTheme（**屏幕上实际生效的配色**），不基于 themeMode 字符串。
  //
  // 2026-10-18 修。themeMode 有三个取值（light / dark / auto），拿它做二元判断必然把
  // auto 归错边，于是同一处冒出两个用户可见的毛病：
  //   ① 默认设置就是 auto（见 DEFAULT_SETTINGS.themeMode），系统为浅色时点第一下算出的
  //      newMode 仍是 'light'：配色不变、图标不变、tooltip 不变 —— 屏幕上一个像素都没动，
  //      用户以为按钮坏了；而设置已经从「跟随系统」被静默改成「浅色」，此后系统切深色
  //      它也不再跟随。
  //   ② 系统为深色 + auto 时图标是太阳（因为 themeMode !== 'dark'），宣称「点了变深色」，
  //      可屏幕现在就是深色。
  // 取反「你看到的那套配色」、按「你看到的配色」画图标，三处声明与行为才对得上
  // （tooltip 原写法恰好已经是「看屏幕」，正好说明分歧就在另外两处）。
  const isDark = currentTheme === 'dark';
  const nextModeLabel = isDark ? '切换浅色模式' : '切换深色模式';
  const nextModeAriaLabel = isDark ? '切换到浅色模式' : '切换到深色模式';

  const toggleTheme = () => {
    setThemeMode(isDark ? 'light' : 'dark');
    // setThemeMode 内部已经处理了保存，不需要再次调用 saveSettings
  };

  return (
    <Tooltip content={nextModeLabel} position="bottom">
      <button
        onClick={toggleTheme}
        className="btn-icon flat-interaction"
        aria-label={nextModeAriaLabel}
      >
        {isDark ? <MoonIcon /> : <SunIcon />}
      </button>
    </Tooltip>
  );
};

export default SimpleThemeToggle;
