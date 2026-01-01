import React from 'react';
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

// 选中标记图标
const CheckIcon = () => (
  <svg className="w-4 h-4 text-green-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

interface ThemeOption {
  value: ThemeStyle;
  label: string;
  description: string;
  icon: React.ReactNode;
}

const themeOptions: ThemeOption[] = [
  {
    value: 'refined',
    label: '精致',
    description: '极简现代风格',
    icon: <RefinedIcon />,
  },
  {
    value: 'classic',
    label: '经典',
    description: 'Material Design 风格',
    icon: <ClassicIcon />,
  },
];

export const ThemeStyleSelector: React.FC<ThemeStyleSelectorProps> = ({ className = '' }) => {
  const { themeStyle, setThemeStyle } = useTheme();

  const handleThemeChange = (style: ThemeStyle) => {
    setThemeStyle(style);
  };

  return (
    <div className={`theme-style-selector ${className}`}>
      <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2 px-4">
        主题风格
      </p>
      <div className="space-y-1">
        {themeOptions.map((option) => (
          <button
            key={option.value}
            onClick={() => handleThemeChange(option.value)}
            className={`w-full text-left px-4 py-2 text-sm flex items-center justify-between transition-colors ${
              themeStyle === option.value
                ? 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-gray-100'
                : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50'
            }`}
            aria-pressed={themeStyle === option.value}
            aria-label={`选择${option.label}主题`}
          >
            <div className="flex items-center">
              <span className="mr-3 text-gray-500 dark:text-gray-400">
                {option.icon}
              </span>
              <div>
                <span className="font-medium">{option.label}</span>
                <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                  {option.description}
                </span>
              </div>
            </div>
            {themeStyle === option.value && <CheckIcon />}
          </button>
        ))}
      </div>
    </div>
  );
};

export default ThemeStyleSelector;
