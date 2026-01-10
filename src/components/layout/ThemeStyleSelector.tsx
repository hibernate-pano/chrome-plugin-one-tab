import React, { useState } from 'react';
import { useTheme } from '@/contexts/ThemeContext';
import { ThemeStyle } from '@/types/tab';

interface ThemeStyleSelectorProps {
  className?: string;
}

// 经典主题图标 - Material Design 风格
const ClassicIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <rect x="3" y="3" width="18" height="18" rx="2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M3 9h18" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M9 21V9" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// 精致主题图标 - 极简现代风格
const RefinedIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <circle cx="12" cy="12" r="9" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M12 8v8" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8 12h8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// 极光主题图标 - 北极光/雪花风格
const AuroraIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <path d="M3 12c2-3 4-4 6-2s4 1 6-2 4-1 6 2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M3 16c2-3 4-4 6-2s4 1 6-2 4-1 6 2" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" />
    <path d="M3 8c2-3 4-4 6-2s4 1 6-2 4-1 6 2" strokeLinecap="round" strokeLinejoin="round" opacity="0.3" />
    <circle cx="18" cy="6" r="1" fill="currentColor" />
    <circle cx="6" cy="18" r="0.5" fill="currentColor" />
  </svg>
);

// Legacy 主题图标 - 原始简约风格
const LegacyIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <rect x="4" y="4" width="16" height="16" rx="1" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M4 8h16" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8 4v4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// 奶油主题图标 - 温暖柔和风格
const CreamyIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="12" cy="12" r="4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// 粉色主题图标 - 甜美风格
const PinkIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// 薄荷主题图标 - 清新风格
const MintIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <path d="M12 2L2 7l10 5 10-5-10-5z" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M2 17l10 5 10-5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M2 12l10 5 10-5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// 赛博朋克主题图标 - 霓虹科技风格
const CyberpunkIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    {/* 电路板/芯片图案 */}
    <rect x="4" y="4" width="16" height="16" rx="2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M9 4v4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M15 4v4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M9 16v4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M15 16v4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M4 9h4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M4 15h4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M16 9h4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M16 15h4" strokeLinecap="round" strokeLinejoin="round" />
    {/* 中心发光点 */}
    <circle cx="12" cy="12" r="2" fill="currentColor" />
  </svg>
);

// 调色板图标
const PaletteIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c3.31 0 6-2.69 6-6 0-4.96-4.49-9-10-9z" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="6.5" cy="11.5" r="1.5" fill="currentColor" />
    <circle cx="9.5" cy="7.5" r="1.5" fill="currentColor" />
    <circle cx="14.5" cy="7.5" r="1.5" fill="currentColor" />
    <circle cx="17.5" cy="11.5" r="1.5" fill="currentColor" />
  </svg>
);

interface ThemeOption {
  value: ThemeStyle;
  label: string;
  description: string;
  icon: React.ReactNode;
  color: string; // 主题代表色
}

const themeOptions: ThemeOption[] = [
  {
    value: 'refined',
    label: '精致',
    description: '极简现代风格',
    icon: <RefinedIcon />,
    color: '#2563eb',
  },
  {
    value: 'classic',
    label: '经典',
    description: 'Material Design',
    icon: <ClassicIcon />,
    color: '#3b82f6',
  },
  {
    value: 'aurora',
    label: '极光',
    description: '北欧冷色调',
    icon: <AuroraIcon />,
    color: '#06b6d4',
  },
  {
    value: 'legacy',
    label: '原始',
    description: '经典 TabVault',
    icon: <LegacyIcon />,
    color: '#007acc',
  },
  {
    value: 'creamy',
    label: '奶油',
    description: '温暖柔和',
    icon: <CreamyIcon />,
    color: '#d4a574',
  },
  {
    value: 'pink',
    label: '粉红',
    description: '甜美可爱',
    icon: <PinkIcon />,
    color: '#e891a8',
  },
  {
    value: 'mint',
    label: '薄荷',
    description: '清新自然',
    icon: <MintIcon />,
    color: '#38b2ac',
  },
  {
    value: 'cyberpunk',
    label: '赛博',
    description: '霓虹科技',
    icon: <CyberpunkIcon />,
    color: '#d946ef',
  },
];

export const ThemeStyleSelector: React.FC<ThemeStyleSelectorProps> = ({ className = '' }) => {
  const { themeStyle, setThemeStyle } = useTheme();
  const [isExpanded, setIsExpanded] = useState(false);

  const handleThemeChange = (style: ThemeStyle) => {
    setThemeStyle(style);
  };

  const currentTheme = themeOptions.find(t => t.value === themeStyle) || themeOptions[0];

  return (
    <div className={`theme-style-selector ${className}`}>
      {/* 主题入口按钮 */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-between"
      >
        <div className="flex items-center">
          <span className="mr-2 text-gray-500">
            <PaletteIcon />
          </span>
          <span>主题风格</span>
          <span 
            className="ml-2 px-2 py-0.5 text-xs rounded-full text-white"
            style={{ backgroundColor: currentTheme.color }}
          >
            {currentTheme.label}
          </span>
        </div>
        <svg 
          className={`w-4 h-4 text-gray-500 transition-transform ${isExpanded ? 'rotate-90' : ''}`} 
          viewBox="0 0 24 24" 
          fill="none" 
          stroke="currentColor" 
          strokeWidth={2}
        >
          <path d="M9 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* 展开的主题列表 */}
      {isExpanded && (
        <div className="bg-gray-50 dark:bg-gray-800/50 border-t border-b border-gray-200 dark:border-gray-700">
          <div className="grid grid-cols-2 gap-1 p-2">
            {themeOptions.map((option) => (
              <button
                key={option.value}
                onClick={() => handleThemeChange(option.value)}
                className={`relative p-2 rounded-lg text-left transition-all ${
                  themeStyle === option.value
                    ? 'bg-white dark:bg-gray-700 shadow-sm ring-2 ring-offset-1'
                    : 'hover:bg-white dark:hover:bg-gray-700/50'
                }`}
                style={{
                  // @ts-expect-error ringColor is a valid CSS custom property
                  '--tw-ring-color': themeStyle === option.value ? option.color : 'transparent',
                }}
                aria-pressed={themeStyle === option.value}
                aria-label={`选择${option.label}主题`}
              >
                <div className="flex items-center gap-2">
                  {/* 颜色指示器 */}
                  <div 
                    className="w-6 h-6 rounded-full flex items-center justify-center text-white"
                    style={{ backgroundColor: option.color }}
                  >
                    {themeStyle === option.value ? (
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
                        <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : (
                      <span className="text-xs font-medium">{option.label[0]}</span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-gray-900 dark:text-gray-100 truncate">
                      {option.label}
                    </div>
                    <div className="text-[10px] text-gray-500 dark:text-gray-400 truncate">
                      {option.description}
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default ThemeStyleSelector;
