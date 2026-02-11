import React from 'react';
import { useTheme } from '@/contexts/ThemeContext';
import { ThemeStyle } from '@/types/tab';

/**
 * 欢迎步骤 - 品牌介绍 + 版本亮点
 */
export const WelcomeStep: React.FC<{ version: string }> = ({ version }) => (
    <div className="onboarding-content">
        <div className="onboarding-icon-wrapper">
            <span>🎉</span>
        </div>
        <h2 className="onboarding-title">欢迎使用 TabVault Pro</h2>
        <div className="flex justify-center">
            <span className="onboarding-version-badge">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                v{version}
            </span>
        </div>
        <p className="onboarding-description">
            高效管理你的浏览器标签页<br />
            让你的浏览体验更加有序
        </p>
        <div className="onboarding-feature-grid">
            <div className="onboarding-feature-card">
                <div className="onboarding-feature-icon">💾</div>
                <div className="onboarding-feature-title">一键保存</div>
                <div className="onboarding-feature-desc">快速收集所有标签</div>
            </div>
            <div className="onboarding-feature-card">
                <div className="onboarding-feature-icon">🎨</div>
                <div className="onboarding-feature-title">多彩主题</div>
                <div className="onboarding-feature-desc">7种风格任选</div>
            </div>
            <div className="onboarding-feature-card">
                <div className="onboarding-feature-icon">☁️</div>
                <div className="onboarding-feature-title">云端同步</div>
                <div className="onboarding-feature-desc">跨设备无缝体验</div>
            </div>
            <div className="onboarding-feature-card">
                <div className="onboarding-feature-icon">🔍</div>
                <div className="onboarding-feature-title">智能搜索</div>
                <div className="onboarding-feature-desc">快速找到标签</div>
            </div>
        </div>
    </div>
);

/**
 * 保存标签步骤
 */
export const SaveTabsStep: React.FC = () => (
    <div className="onboarding-content">
        <div className="onboarding-icon-wrapper">
            <span>💾</span>
        </div>
        <h2 className="onboarding-title">一键保存所有标签</h2>
        <p className="onboarding-description">
            点击扩展图标或使用「保存全部」按钮，<br />
            即可将当前窗口的所有标签页保存到 TabVault
        </p>
        <div className="onboarding-feature-grid">
            <div className="onboarding-feature-card">
                <div className="onboarding-feature-icon">🖱️</div>
                <div className="onboarding-feature-title">点击图标</div>
                <div className="onboarding-feature-desc">自动收集并关闭标签</div>
            </div>
            <div className="onboarding-feature-card">
                <div className="onboarding-feature-icon">📌</div>
                <div className="onboarding-feature-title">固定标签</div>
                <div className="onboarding-feature-desc">可选择是否收集</div>
            </div>
            <div className="onboarding-feature-card">
                <div className="onboarding-feature-icon">📂</div>
                <div className="onboarding-feature-title">分组管理</div>
                <div className="onboarding-feature-desc">自动按时间分组</div>
            </div>
            <div className="onboarding-feature-card">
                <div className="onboarding-feature-icon">🔄</div>
                <div className="onboarding-feature-title">一键恢复</div>
                <div className="onboarding-feature-desc">随时打开已保存标签</div>
            </div>
        </div>
    </div>
);

// 主题数据
const themeData: Array<{ value: ThemeStyle; label: string; color: string }> = [
    { value: 'legacy', label: '原始', color: '#007acc' },
    { value: 'classic', label: '经典', color: '#3b82f6' },
    { value: 'aurora', label: '极光', color: '#06b6d4' },
    { value: 'creamy', label: '奶油', color: '#d4a574' },
    { value: 'pink', label: '粉红', color: '#e891a8' },
    { value: 'mint', label: '薄荷', color: '#38b2ac' },
    { value: 'cyberpunk', label: '赛博', color: '#d946ef' },
    { value: 'prism', label: '棱镜', color: '#667eea' },
];

/**
 * 主题切换步骤 - 可实时切换主题
 */
export const ThemeStep: React.FC = () => {
    const { themeStyle, setThemeStyle, setThemeMode, currentTheme } = useTheme();

    return (
        <div className="onboarding-content">
            <div className="onboarding-icon-wrapper">
                <span>🎨</span>
            </div>
            <h2 className="onboarding-title">选择你喜欢的主题</h2>
            <p className="onboarding-description">
                7种精心设计的主题风格，点击即可实时预览
            </p>

            {/* 明暗模式切换 */}
            <div className="flex justify-center gap-2 mb-4">
                <button
                    onClick={() => setThemeMode('light')}
                    className={`px-4 py-1.5 rounded-full text-xs font-medium transition-all ${currentTheme === 'light'
                        ? 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300 shadow-sm'
                        : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
                        }`}
                >
                    ☀️ 浅色
                </button>
                <button
                    onClick={() => setThemeMode('dark')}
                    className={`px-4 py-1.5 rounded-full text-xs font-medium transition-all ${currentTheme === 'dark'
                        ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300 shadow-sm'
                        : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
                        }`}
                >
                    🌙 深色
                </button>
            </div>

            {/* 主题选择网格 */}
            <div className="onboarding-theme-grid">
                {themeData.map((theme) => (
                    <button
                        key={theme.value}
                        onClick={() => setThemeStyle(theme.value)}
                        className={`onboarding-theme-card ${themeStyle === theme.value ? 'selected' : ''}`}
                    >
                        <div
                            className="onboarding-theme-swatch"
                            style={{ backgroundColor: theme.color }}
                        />
                        <div className="onboarding-theme-name">{theme.label}</div>
                    </button>
                ))}
            </div>
        </div>
    );
};

/**
 * 设置菜单步骤
 */
export const SettingsStep: React.FC = () => (
    <div className="onboarding-content">
        <div className="onboarding-icon-wrapper">
            <span>⚙️</span>
        </div>
        <h2 className="onboarding-title">个性化设置</h2>
        <p className="onboarding-description">
            通过右上角的菜单按钮，自定义你的使用体验
        </p>
        <div className="onboarding-feature-grid">
            <div className="onboarding-feature-card">
                <div className="onboarding-feature-icon">🔔</div>
                <div className="onboarding-feature-title">通知提醒</div>
                <div className="onboarding-feature-desc">控制通知开关</div>
            </div>
            <div className="onboarding-feature-card">
                <div className="onboarding-feature-icon">⚠️</div>
                <div className="onboarding-feature-title">删除确认</div>
                <div className="onboarding-feature-desc">防止误删操作</div>
            </div>
            <div className="onboarding-feature-card">
                <div className="onboarding-feature-icon">📤</div>
                <div className="onboarding-feature-title">数据导出</div>
                <div className="onboarding-feature-desc">JSON / OneTab 格式</div>
            </div>
            <div className="onboarding-feature-card">
                <div className="onboarding-feature-icon">📥</div>
                <div className="onboarding-feature-title">数据导入</div>
                <div className="onboarding-feature-desc">迁移已有数据</div>
            </div>
        </div>
    </div>
);

/**
 * 快捷键步骤
 */
export const ShortcutsStep: React.FC = () => {
    // 检测是否为 macOS
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

    const shortcuts = [
        {
            desc: '打开标签管理器',
            keys: isMac ? ['⌘', '⇧', 'S'] : ['Ctrl', 'Shift', 'S'],
        },
        {
            desc: '保存所有标签页',
            keys: isMac ? ['⌥', '⇧', 'S'] : ['Alt', 'Shift', 'S'],
        },
        {
            desc: '保存当前标签页',
            keys: isMac ? ['⌥', 'S'] : ['Alt', 'S'],
        },
        {
            desc: '搜索标签',
            keys: isMac ? ['⌘', 'F'] : ['Ctrl', 'F'],
        },
        {
            desc: '切换布局模式',
            keys: isMac ? ['⌘', 'L'] : ['Ctrl', 'L'],
        },
    ];

    return (
        <div className="onboarding-content">
            <div className="onboarding-icon-wrapper">
                <span>⌨️</span>
            </div>
            <h2 className="onboarding-title">高效快捷键</h2>
            <p className="onboarding-description">
                使用快捷键让操作更加高效快捷
            </p>
            <div className="onboarding-shortcut-list">
                {shortcuts.map((shortcut, index) => (
                    <div key={index} className="onboarding-shortcut-item">
                        <span className="onboarding-shortcut-desc">{shortcut.desc}</span>
                        <div className="onboarding-shortcut-keys">
                            {shortcut.keys.map((key, i) => (
                                <React.Fragment key={i}>
                                    {i > 0 && <span className="text-gray-400 text-xs">+</span>}
                                    <kbd className="onboarding-kbd">{key}</kbd>
                                </React.Fragment>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

/**
 * 云同步步骤
 */
export const SyncStep: React.FC = () => (
    <div className="onboarding-content">
        <div className="onboarding-icon-wrapper">
            <span>☁️</span>
        </div>
        <h2 className="onboarding-title">云端同步</h2>
        <p className="onboarding-description">
            登录账户，即可在多台设备间同步你的标签数据
        </p>
        <div className="onboarding-feature-grid">
            <div className="onboarding-feature-card">
                <div className="onboarding-feature-icon">🔐</div>
                <div className="onboarding-feature-title">安全加密</div>
                <div className="onboarding-feature-desc">数据安全有保障</div>
            </div>
            <div className="onboarding-feature-card">
                <div className="onboarding-feature-icon">🔄</div>
                <div className="onboarding-feature-title">实时同步</div>
                <div className="onboarding-feature-desc">多设备保持一致</div>
            </div>
            <div className="onboarding-feature-card">
                <div className="onboarding-feature-icon">📱</div>
                <div className="onboarding-feature-title">跨设备</div>
                <div className="onboarding-feature-desc">家里公司无缝切换</div>
            </div>
            <div className="onboarding-feature-card">
                <div className="onboarding-feature-icon">💼</div>
                <div className="onboarding-feature-title">云端备份</div>
                <div className="onboarding-feature-desc">再也不怕丢失数据</div>
            </div>
        </div>
    </div>
);

/**
 * 准备就绪步骤 - 引导完成
 */
export const ReadyStep: React.FC = () => (
    <div className="onboarding-content text-center">
        <div className="onboarding-icon-wrapper">
            <span className="onboarding-confetti">🚀</span>
        </div>
        <h2 className="onboarding-title">一切就绪！</h2>
        <p className="onboarding-description">
            你已经了解了 TabVault Pro 的核心功能<br />
            现在开始高效管理你的标签页吧！
        </p>
        <div className="flex justify-center gap-3 mt-4">
            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-green-50 dark:bg-green-900/30 rounded-full">
                <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                <span className="text-xs font-medium text-green-700 dark:text-green-400">准备就绪</span>
            </div>
        </div>
    </div>
);
