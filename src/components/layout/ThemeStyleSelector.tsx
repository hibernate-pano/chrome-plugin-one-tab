import React, { useState, useCallback, useMemo } from 'react';
import { useTheme } from '@/contexts/ThemeContext';
import { ThemeStyle } from '@/types/tab';
import { cn } from '@/lib/utils';

interface ThemeStyleSelectorProps {
  className?: string;
}

// 极光主题图标 - 北极光/雪花风格
const AuroraIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <path d="M3 12c2-3 4-4 6-2s4 1 6-2 4-1 6 2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M3 16c2-3 4-4 6-2s4 1 6-2 4-1 6 2" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" />
    <path d="M3 8c2-3 4-4 6-2s4 1 6-2 4-1 6 2" strokeLinecap="round" strokeLinejoin="round" opacity="0.3" />
    <circle cx="18" cy="6" r="1" fill="currentColor" />
    <circle cx="6" cy="18" r="0.5" fill="currentColor" />
  </svg>
);

// Legacy 主题图标 - 原始简约风格
const LegacyIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <rect x="4" y="4" width="16" height="16" rx="1" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M4 8h16" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8 4v4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// 奶油主题图标 - 温暖柔和风格
const CreamyIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="12" cy="12" r="4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);


// 奶油主题图标 - 温暖柔和风格
// 棱镜主题图标 - 毛玻璃/棱镜风格
const PrismIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <path d="M12 2L3 8.5V15.5L12 22L21 15.5V8.5L12 2Z" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M12 2V22" strokeLinecap="round" strokeLinejoin="round" opacity="0.4" />
    <path d="M3 8.5L21 15.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.3" />
    <path d="M21 8.5L3 15.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.3" />
  </svg>
);

// Apple 主题图标 - 系统质感（SF 风格圆角窗格）
const AppleIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <rect x="3" y="4" width="18" height="14" rx="3" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M3 9h18" strokeLinecap="round" />
    <circle cx="6" cy="6.5" r="0.5" fill="currentColor" />
    <circle cx="8" cy="6.5" r="0.5" fill="currentColor" />
    <path d="M9 21h6" strokeLinecap="round" />
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

// 展开/收起图标
const ChevronIcon = ({ isExpanded }: { isExpanded: boolean }) => (
  <svg
    className={cn(
      "w-4 h-4 transition-transform duration-200",
      isExpanded && "rotate-180"
    )}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
  >
    <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// 选中图标
const CheckIcon = () => (
  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
    <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);


interface ThemeOption {
  value: ThemeStyle;
  label: string;
  description: string;
  icon: React.ReactNode;
  primaryColor: string;
  secondaryColor: string;
  previewColors: {
    bg: string;
    card: string;
    accent: string;
    text: string;
  };
}

const themeOptions: ThemeOption[] = [
  {
    value: 'legacy',
    label: '原始',
    description: '默认主题',
    icon: <LegacyIcon />,
    primaryColor: '#007acc',
    secondaryColor: '#0ea5e9',
    previewColors: {
      bg: '#f5f5f5',
      card: '#ffffff',
      accent: '#007acc',
      text: '#333333',
    },
  },
  {
    value: 'aurora',
    label: '极光',
    description: '北欧冷调',
    icon: <AuroraIcon />,
    primaryColor: '#06b6d4',
    secondaryColor: '#22d3ee',
    previewColors: {
      bg: '#f8fafc',
      card: '#ffffff',
      accent: '#06b6d4',
      text: '#0f172a',
    },
  },
  {
    value: 'creamy',
    label: '奶油',
    description: '温暖柔和',
    icon: <CreamyIcon />,
    primaryColor: '#d4a574',
    secondaryColor: '#e8c9a8',
    previewColors: {
      bg: '#faf8f5',
      card: '#fffdf9',
      accent: '#d4a574',
      text: '#5c4a3a',
    },
  },
  {
    value: 'apple',
    label: 'Apple',
    description: '系统质感',
    icon: <AppleIcon />,
    primaryColor: '#0071e3',
    secondaryColor: '#0a84ff',
    previewColors: {
      bg: '#f5f5f7',
      card: '#ffffff',
      accent: '#0071e3',
      text: '#1d1d1f',
    },
  },
  {
    value: 'prism',
    label: '棱镜',
    description: '毛玻璃渐变',
    icon: <PrismIcon />,
    primaryColor: '#667eea',
    secondaryColor: '#764ba2',
    previewColors: {
      bg: '#f5f3ff',
      card: 'rgba(255,255,255,0.85)',
      accent: '#667eea',
      text: '#1e1b4b',
    },
  },
];


// 主题预览卡片组件
const ThemePreviewCard: React.FC<{
  option: ThemeOption;
  isSelected: boolean;
  isHovered: boolean;
}> = ({ option, isSelected, isHovered }) => {
  const { previewColors } = option;

  return (
    <div
      className={cn(
        "w-full h-10 rounded-md overflow-hidden border transition-all duration-200",
        isSelected
          ? "border-blue-500 ring-2 ring-blue-500/20"
          : isHovered
            ? "border-gray-300 dark:border-gray-600"
            : "border-gray-200 dark:border-gray-700"
      )}
      style={{ backgroundColor: previewColors.bg }}
    >
      {/* 迷你预览布局 */}
      <div className="flex h-full">
        {/* 侧边栏预览 */}
        <div
          className="w-2 h-full"
          style={{ backgroundColor: previewColors.accent }}
        />
        {/* 内容区预览 */}
        <div className="flex-1 p-1 flex flex-col justify-center gap-0.5">
          {/* 标题栏 */}
          <div
            className="h-1.5 w-8 rounded-full"
            style={{ backgroundColor: previewColors.text, opacity: 0.7 }}
          />
          {/* 卡片预览 */}
          <div className="flex gap-0.5">
            <div
              className="h-3 w-6 rounded-sm"
              style={{ backgroundColor: previewColors.card, boxShadow: '0 1px 2px rgba(0,0,0,0.1)' }}
            />
            <div
              className="h-3 w-6 rounded-sm"
              style={{ backgroundColor: previewColors.card, boxShadow: '0 1px 2px rgba(0,0,0,0.1)' }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export const ThemeStyleSelector: React.FC<ThemeStyleSelectorProps> = ({ className = '' }) => {
  const { themeStyle, setThemeStyle, isTransitioning } = useTheme();
  const [isExpanded, setIsExpanded] = useState(false);
  const [hoveredTheme, setHoveredTheme] = useState<ThemeStyle | null>(null);

  const handleThemeChange = useCallback((style: ThemeStyle) => {
    if (style !== themeStyle && !isTransitioning) {
      setThemeStyle(style);
    }
  }, [themeStyle, setThemeStyle, isTransitioning]);

  const toggleExpanded = useCallback(() => {
    setIsExpanded(prev => !prev);
  }, []);

  const currentTheme = useMemo(() =>
    themeOptions.find(t => t.value === themeStyle) || themeOptions[0],
    [themeStyle]
  );

  return (
    <div className={cn("theme-style-selector", className)}>
      {/* 主题入口按钮 */}
      <button
        onClick={toggleExpanded}
        className={cn(
          "w-full text-left px-4 py-2.5 text-sm flat-interaction",
          "text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50",
          "flex items-center justify-between gap-2",
          "transition-colors duration-150",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
        )}
        aria-expanded={isExpanded}
        aria-controls="theme-options-panel"
        aria-label="选择主题风格"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-gray-500 dark:text-gray-400 flex-shrink-0">
            <PaletteIcon />
          </span>
          <span className="font-medium">主题风格</span>
          {/* 当前主题：灰底 pill + 主题色圆点。实心主题色块会把菜单视线抢走（pill 不是 CTA）。 */}
          <span
            className={cn(
              "inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded-full",
              "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300"
            )}
          >
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: currentTheme.primaryColor }}
            />
            {currentTheme.label}
          </span>
        </div>
        <ChevronIcon isExpanded={isExpanded} />
      </button>

      {/* 展开的主题列表 - 内容可滚动以确保所有主题（含生产力）可见。
          与 TabGroup 的折叠会话组同一个根因：max-h-0/opacity-0 只改视觉，
          收起时 4 个主题选项按钮仍在 Tab 序列里，键盘用户能 Tab 进一片空白、
          盲按 Enter 就改了主题。外层容器保留（aria-controls 要指得到、还要过渡），
          内容用 hidden（display:none，真正移出可交互树）而不是只改透明度。 */}
      <div
        id="theme-options-panel"
        className={cn(
          "overflow-hidden transition-all duration-200 ease-out",
          isExpanded ? "max-h-[400px] opacity-100 overflow-y-auto" : "max-h-0 opacity-0"
        )}
        role="listbox"
        aria-label="可用主题列表"
        aria-hidden={!isExpanded}
      >
        <div
          hidden={!isExpanded}
          className="bg-gray-50/50 dark:bg-gray-800/30 border-y border-gray-200/50 dark:border-gray-700/50"
        >
          <div className="grid grid-cols-2 gap-1.5 p-2">
            {themeOptions.map((option) => {
              const isSelected = themeStyle === option.value;
              const isHovered = hoveredTheme === option.value;

              return (
                <button
                  key={option.value}
                  onClick={() => handleThemeChange(option.value)}
                  onMouseEnter={() => setHoveredTheme(option.value)}
                  onMouseLeave={() => setHoveredTheme(null)}
                  disabled={isTransitioning}
                  className={cn(
                    "relative p-2 rounded-lg text-left flat-interaction",
                    "transition-all duration-150",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
                    isSelected
                      ? "bg-white dark:bg-gray-700 shadow-sm ring-2 ring-blue-500/30"
                      : "hover:bg-white/80 dark:hover:bg-gray-700/80",
                    isTransitioning && "opacity-50 cursor-not-allowed"
                  )}
                  role="option"
                  aria-selected={isSelected}
                  aria-label={`选择${option.label}主题: ${option.description}`}
                >
                  {/* 主题预览 */}
                  <ThemePreviewCard
                    option={option}
                    isSelected={isSelected}
                    isHovered={isHovered}
                  />

                  {/* 主题信息 */}
                  <div className="flex items-center gap-2 mt-2">
                    {/* 颜色指示器 */}
                    <div
                      className={cn(
                        "w-5 h-5 rounded-full flex items-center justify-center",
                        "text-white transition-transform duration-150",
                        isSelected && "scale-110"
                      )}
                      style={{
                        backgroundColor: option.primaryColor,
                        boxShadow: isSelected ? `0 0 8px ${option.primaryColor}50` : 'none'
                      }}
                    >
                      {isSelected ? (
                        <CheckIcon />
                      ) : (
                        <span className="opacity-80">{option.icon}</span>
                      )}
                    </div>

                    {/* 标签和描述 */}
                    <div className="flex-1 min-w-0">
                      <div className={cn(
                        "text-xs font-medium truncate",
                        isSelected ? "text-gray-900 dark:text-gray-100" : "text-gray-700 dark:text-gray-300"
                      )}>
                        {option.label}
                      </div>
                      <div className="text-[10px] text-gray-500 dark:text-gray-400 truncate">
                        {option.description}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* 过渡状态提示 */}
          {isTransitioning && (
            <div className="px-3 py-1.5 text-xs text-gray-500 dark:text-gray-400 text-center border-t border-gray-200/50 dark:border-gray-700/50">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                正在切换主题...
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ThemeStyleSelector;
