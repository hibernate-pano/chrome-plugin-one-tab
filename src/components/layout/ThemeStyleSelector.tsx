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

// 精致（refined）主题图标 - 简约笔触
const RefinedIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <rect x="4" y="4" width="16" height="16" rx="3" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8 12h8" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M12 8v8" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" />
  </svg>
);

// 赛博朋克主题图标 - 霓虹科技风格
const CyberpunkIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <rect x="4" y="4" width="16" height="16" rx="2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M9 4v4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M15 4v4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M9 16v4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M15 16v4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M4 9h4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M4 15h4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M16 9h4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M16 15h4" strokeLinecap="round" strokeLinejoin="round" />
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

/**
 * S2 P4 Task 4.4: theme picker slimmed to 3 curated themes.
 * Dropped themes (legacy/classic/creamy/pink/mint/prism) were removed
 * from `themeOptions` — their CSS files are also being deleted.
 */
const themeOptions: ThemeOption[] = [
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
    value: 'refined',
    label: '精致',
    description: '现代简约',
    icon: <RefinedIcon />,
    primaryColor: '#475569',
    secondaryColor: '#94a3b8',
    previewColors: {
      bg: '#fafafa',
      card: '#ffffff',
      accent: '#475569',
      text: '#1e293b',
    },
  },
  {
    value: 'cyberpunk',
    label: '赛博',
    description: '霓虹科技',
    icon: <CyberpunkIcon />,
    primaryColor: '#d946ef',
    secondaryColor: '#f0abfc',
    previewColors: {
      bg: '#0a0a0f',
      card: '#1a1a2e',
      accent: '#d946ef',
      text: '#e0e0e0',
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

  // 当前主题可能在历史数据里是已删除的 themeStyle；如果不在新选项里，
  // 就把选中态映射到极光（第一个选项），避免 UI 显示空白选中环。
  const resolvedThemeStyle: ThemeStyle = useMemo(
    () => (themeOptions.some(t => t.value === themeStyle) ? themeStyle : themeOptions[0].value),
    [themeStyle]
  );

  const handleThemeChange = useCallback((style: ThemeStyle) => {
    if (style !== themeStyle && !isTransitioning) {
      setThemeStyle(style);
    }
  }, [themeStyle, setThemeStyle, isTransitioning]);

  const toggleExpanded = useCallback(() => {
    setIsExpanded(prev => !prev);
  }, []);

  const currentTheme = useMemo(() =>
    themeOptions.find(t => t.value === resolvedThemeStyle) || themeOptions[0],
    [resolvedThemeStyle]
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
          <span
            className={cn(
              "px-2 py-0.5 text-xs font-medium rounded-full",
              "text-white transition-colors duration-200"
            )}
            style={{ backgroundColor: currentTheme.primaryColor }}
          >
            {currentTheme.label}
          </span>
        </div>
        <ChevronIcon isExpanded={isExpanded} />
      </button>

      {/* 展开的主题列表 */}
      <div
        id="theme-options-panel"
        className={cn(
          "overflow-hidden transition-all duration-200 ease-out",
          isExpanded ? "max-h-[400px] opacity-100 overflow-y-auto" : "max-h-0 opacity-0"
        )}
        role="listbox"
        aria-label="可用主题列表"
      >
        <div className="bg-gray-50/50 dark:bg-gray-800/30 border-y border-gray-200/50 dark:border-gray-700/50">
          <div className="grid grid-cols-3 gap-1.5 p-2">
            {themeOptions.map((option) => {
              const isSelected = resolvedThemeStyle === option.value;
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
