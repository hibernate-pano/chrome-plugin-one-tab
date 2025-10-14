import React from 'react';
import { TabVaultLogo } from './TabVaultIcon';

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
      return '开始整理您的标签页，让浏览更高效';
    } else if (tabCount < 10) {
      return '保持简洁，继续优化您的浏览体验';
    } else if (tabCount < 50) {
      return '管理得很好！继续保持这种高效状态';
    } else {
      return '标签页管理专家！您的组织能力令人印象深刻';
    }
  };

  const getEmoji = () => {
    if (tabCount === 0) return '🚀';
    if (tabCount < 10) return '✨';
    if (tabCount < 50) return '🎯';
    return '🏆';
  };

  return (
    <div className={`text-center py-8 px-4 ${className}`}>
      {/* 欢迎图标 */}
      <div className="mb-4">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-blue-100 dark:bg-blue-900 mb-3">
          <span className="text-2xl">{getEmoji()}</span>
        </div>
      </div>

      {/* 欢迎文字 */}
      <div className="mb-4">
        <h1 className="flat-text-primary mb-2">
          {getGreeting()}，{userName ? `${userName}！` : '欢迎使用 TabVault Pro！'}
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
              已整理
            </span>
          </div>
        </div>
      )}

      {/* 品牌标识 */}
      <div className="mt-6 flex justify-center">
        <TabVaultLogo size="sm" showIcon={true} />
      </div>
    </div>
  );
};

/**
 * 快速操作提示组件
 */
export const QuickActionTips: React.FC<{ className?: string }> = ({ className = '' }) => {
  const tips = [
    { key: 'Ctrl+S', desc: '保存所有标签页' },
    { key: 'Ctrl+F', desc: '快速搜索' },
    { key: 'Ctrl+L', desc: '切换布局' },
  ];

  return (
    <div className={`${className}`}>
      <div className="text-center mb-4">
        <h3 className="flat-text-secondary text-sm mb-2">💡 快捷键提示</h3>
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
