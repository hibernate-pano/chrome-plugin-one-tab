import React from 'react';
import { TapStackLogo } from './TapStackIcon';

interface PersonalizedWelcomeProps {
  userName?: string;
  className?: string;
}

/**
 * 个性化欢迎组件
 * 提供温暖的情感化设计
 *
 * ── 2026-10-18 C 组：只剩空态形态，`tabCount` 已移除 ────────────────────
 * 唯一调用方（TabList.tsx）只在 `filteredGroups.length === 0` 时渲染本组件，
 * 此时标签总数**恒为 0**。于是原先的 `{tabCount > 0 && (...)}` 统计块 DOM
 * 根本不存在，`getMotivationalMessage` / `getEmoji` 里 `tabCount < 10` / `< 50`
 * / 其它三个分支同样不可达 —— 一条永远走不到的分支比没有更糟：它看起来像
 * 一个已实现的功能（「N 个标签页 · 绿点 可恢复」），而绿点从来没有被任何数据
 * 检查过。整块删除；如果将来要在有数据的分支里显示统计，必须重新接真值。
 */
export const PersonalizedWelcome: React.FC<PersonalizedWelcomeProps> = ({
  userName,
  className = ''
}) => {
  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return '早上好';
    if (hour < 18) return '下午好';
    return '晚上好';
  };

  return (
    <div className={`text-center py-8 px-4 ${className}`}>
      {/* 欢迎图标 */}
      <div className="mb-4">
        <div className="theme-accent-soft inline-flex items-center justify-center w-16 h-16 rounded-full mb-3">
          <span className="text-2xl">🚀</span>
        </div>
      </div>

      {/* 欢迎文字 */}
      <div className="mb-4">
        <h1 className="flat-text-primary mb-2">
          {getGreeting()}，{userName ? `${userName}！` : '欢迎使用 TapStack！'}
        </h1>
        <p className="flat-text-tertiary text-sm max-w-md mx-auto">
          先保存一个工作会话，让稍后找回变得轻松
        </p>
      </div>

      {/* 品牌标识 */}
      <div className="mt-6 flex justify-center">
        <TapStackLogo size="sm" showIcon={true} />
      </div>
    </div>
  );
};

export default PersonalizedWelcome;
