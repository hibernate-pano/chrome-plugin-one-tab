import React from 'react';
import { TabStackLogo } from './TabVaultIcon';

interface PersonalizedWelcomeProps {
  userName?: string;
  tabCount?: number;
  className?: string;
}

/**
 * 个性化欢迎组件
 * 提供温暖的情感化设计
 */
export const PersonalizedWelcome: React.FC<PersonalizedWelcomeProps> = ({ 
  userName, 
  tabCount = 0,
  className = '' 
}) => {
  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return '早上好';
    if (hour < 18) return '下午好';
    return '晚上好';
  };

  const getMotivationalMessage = () => {
    if (tabCount === 0) {
      return '先保存一个工作会话，让稍后找回变得轻松';
    } else if (tabCount < 10) {
      return '继续保持，您的工作会话已经开始变得清晰有序';
    } else if (tabCount < 50) {
      return '管理得很好，您已经在稳定积累可恢复的工作现场';
    } else {
      return '会话管理专家，随时都能从上次中断的位置继续工作';
    }
  };

  // SVG icon components (replacing emoji for Chrome Web Store compatibility)
  const RocketIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6 text-blue-500">
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09zM12 15l-3-3a22 22 0 0 1 2-2.95c.37-1.68-.35-3.05-2.11-2.95-1.13-.05-2.31.35-3.16 1.27L3 10l1.41-1.41c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09L2 5.59"/>
      <path d="M14 11.5c1 1 2 2.5 2 2.5s1.5-1 2.5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/>
      <path d="M17 7l-3 3M17 17l-3-3M7 7L4 4M7 17L4 20"/>
    </svg>
  );
  const SparkleIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6 text-yellow-500">
      <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/>
      <path d="M5 19l1 3 1-3M5 5l1-3 1 3M19 5l-1-3-1 3M19 19l-1 3-1-3"/>
    </svg>
  );
  const TargetIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6 text-orange-500">
      <circle cx="12" cy="12" r="10"/>
      <circle cx="12" cy="12" r="6"/>
      <circle cx="12" cy="12" r="2"/>
    </svg>
  );
  const TrophyIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6 text-amber-500">
      <path d="M6 9H4.5a2.5 2.5 0 0 0 0 5h1.5"/>
      <path d="M18 9h1.5a2.5 2.5 0 0 1 0 5H18"/>
      <path d="M4 22h16"/>
      <path d="M10 22V10a2 2 0 0 1 2-2h0a2 2 0 0 1 2 2v12"/>
      <path d="M8 6a6 6 0 0 0 8 0"/>
    </svg>
  );
  const getIcon = () => {
    if (tabCount === 0) return <RocketIcon />;
    if (tabCount < 10) return <SparkleIcon />;
    if (tabCount < 50) return <TargetIcon />;
    return <TrophyIcon />;
  };

  return (
    <div className={`text-center py-8 px-4 ${className}`}>
      {/* 欢迎图标 */}
      <div className="mb-4">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-blue-100 dark:bg-blue-900 mb-3">
          {getIcon()}
        </div>
      </div>

      {/* 欢迎文字 */}
      <div className="mb-4">
        <h1 className="flat-text-primary mb-2">
          {getGreeting()}，{userName ? `${userName}！` : '欢迎使用 TabStack！'}
        </h1>
        <p className="flat-text-tertiary text-sm max-w-md mx-auto">
          {getMotivationalMessage()}
        </p>
      </div>

      {/* 统计信息 */}
      {tabCount > 0 && (
        <div className="inline-flex items-center space-x-4 px-4 py-2 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="flex items-center space-x-1">
            <div className="w-2 h-2 bg-blue-500 rounded-full"></div>
            <span className="text-sm text-gray-600 dark:text-gray-300">
              {tabCount} 个标签页
            </span>
          </div>
          <div className="w-px h-4 bg-gray-300 dark:bg-gray-600"></div>
          <div className="flex items-center space-x-1">
            <div className="w-2 h-2 bg-green-500 rounded-full"></div>
            <span className="text-sm text-gray-600 dark:text-gray-300">
              可恢复
            </span>
          </div>
        </div>
      )}

      {/* 品牌标识 */}
      <div className="mt-6 flex justify-center">
        <TabStackLogo size="sm" showIcon={true} />
      </div>
    </div>
  );
};

/**
 * 快速操作提示组件
 */
export const QuickActionTips: React.FC<{ className?: string }> = ({ className = '' }) => {
  const LightbulbIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <path d="M9 18h6M10 22h4"/>
      <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.65 4.65 0 0 0 9 14"/>
    </svg>
  );
  const tips = [
    { key: 'Ctrl+S', desc: '保存当前窗口为会话' },
    { key: 'Ctrl+F', desc: '快速搜索会话' },
    { key: 'Ctrl+L', desc: '切换布局' },
  ];

  return (
    <div className={`${className}`}>
      <div className="text-center mb-4">
        <h3 className="flat-text-secondary text-sm mb-2 flex items-center justify-center gap-2">
          <LightbulbIcon />
          <span>快捷键提示</span>
        </h3>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {tips.map((tip, index) => (
          <div
            key={index}
            className="flex items-center space-x-1 px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-xs"
          >
            <kbd className="px-1 py-0.5 bg-white dark:bg-gray-600 rounded text-gray-600 dark:text-gray-300 font-mono">
              {tip.key}
            </kbd>
            <span className="text-gray-600 dark:text-gray-300">{tip.desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default PersonalizedWelcome;
