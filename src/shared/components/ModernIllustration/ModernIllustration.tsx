/**
 * 现代插画和装饰性元素组件
 * 提供各种精美的插画和装饰元素，提升视觉冲击力
 */

import React from 'react';
import { cn } from '@/shared/utils/cn';

export interface ModernIllustrationProps {
  name: string;
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  className?: string;
  animated?: boolean;
}

export interface DecorativeElementProps {
  type: 'dots' | 'lines' | 'circles' | 'waves' | 'grid' | 'gradient-orb';
  size?: 'sm' | 'md' | 'lg';
  color?: 'primary' | 'secondary' | 'accent' | 'neutral';
  className?: string;
  animated?: boolean;
}

const ModernIllustration: React.FC<ModernIllustrationProps> = ({
  name,
  size = 'md',
  className,
  animated = false,
}) => {
  const sizeClasses = {
    sm: 'w-24 h-24',
    md: 'w-32 h-32',
    lg: 'w-48 h-48',
    xl: 'w-64 h-64',
    '2xl': 'w-80 h-80',
  };

  const illustrations = {
    emptyTabs: (
      <svg viewBox="0 0 400 300" className={cn(sizeClasses[size], animated && 'animate-float', className)}>
        <defs>
          <linearGradient id="tabGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#667eea" />
            <stop offset="100%" stopColor="#764ba2" />
          </linearGradient>
          <linearGradient id="screenGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#f093fb" />
            <stop offset="100%" stopColor="#f5576c" />
          </linearGradient>
        </defs>
        
        {/* 背景装饰圆圈 */}
        <circle cx="350" cy="50" r="30" fill="url(#tabGradient)" opacity="0.1" className={animated ? 'animate-pulse' : ''} />
        <circle cx="50" cy="250" r="20" fill="url(#screenGradient)" opacity="0.1" className={animated ? 'animate-pulse animate-delay-300' : ''} />
        
        {/* 主要插画 - 浏览器窗口 */}
        <rect x="80" y="80" width="240" height="160" rx="12" fill="white" stroke="#e5e7eb" strokeWidth="2" />
        <rect x="80" y="80" width="240" height="30" rx="12" fill="#f3f4f6" />
        
        {/* 浏览器控制按钮 */}
        <circle cx="100" cy="95" r="4" fill="#ef4444" />
        <circle cx="115" cy="95" r="4" fill="#f59e0b" />
        <circle cx="130" cy="95" r="4" fill="#10b981" />
        
        {/* 标签页 */}
        <rect x="160" y="85" width="60" height="20" rx="8" fill="url(#tabGradient)" className={animated ? 'animate-pulse animate-delay-500' : ''} />
        <rect x="225" y="85" width="60" height="20" rx="8" fill="#e5e7eb" />
        
        {/* 内容区域 */}
        <rect x="100" y="130" width="200" height="8" rx="4" fill="#e5e7eb" />
        <rect x="100" y="150" width="160" height="8" rx="4" fill="#e5e7eb" />
        <rect x="100" y="170" width="180" height="8" rx="4" fill="#e5e7eb" />
        
        {/* 空状态图标 */}
        <circle cx="200" cy="200" r="25" fill="url(#screenGradient)" opacity="0.2" className={animated ? 'animate-scale-in animate-delay-700' : ''} />
        <path d="M185 200 L200 185 L215 200 L200 215 Z" fill="url(#screenGradient)" className={animated ? 'animate-bounce-in animate-delay-1000' : ''} />
      </svg>
    ),

    tabsOrganized: (
      <svg viewBox="0 0 400 300" className={cn(sizeClasses[size], animated && 'animate-fade-in-up', className)}>
        <defs>
          <linearGradient id="orgGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#4facfe" />
            <stop offset="100%" stopColor="#00f2fe" />
          </linearGradient>
        </defs>
        
        {/* 文件夹组 */}
        <g className={animated ? 'animate-slide-in-left stagger-1' : ''}>
          <rect x="50" y="80" width="80" height="60" rx="8" fill="url(#orgGradient)" opacity="0.8" />
          <rect x="45" y="75" width="80" height="60" rx="8" fill="url(#orgGradient)" />
          <text x="85" y="110" textAnchor="middle" fill="white" fontSize="12" fontWeight="bold">工作</text>
        </g>
        
        <g className={animated ? 'animate-slide-in-left stagger-2' : ''}>
          <rect x="160" y="80" width="80" height="60" rx="8" fill="#10b981" opacity="0.8" />
          <rect x="155" y="75" width="80" height="60" rx="8" fill="#10b981" />
          <text x="195" y="110" textAnchor="middle" fill="white" fontSize="12" fontWeight="bold">学习</text>
        </g>
        
        <g className={animated ? 'animate-slide-in-left stagger-3' : ''}>
          <rect x="270" y="80" width="80" height="60" rx="8" fill="#f59e0b" opacity="0.8" />
          <rect x="265" y="75" width="80" height="60" rx="8" fill="#f59e0b" />
          <text x="305" y="110" textAnchor="middle" fill="white" fontSize="12" fontWeight="bold">娱乐</text>
        </g>
        
        {/* 连接线 */}
        <path d="M200 180 Q200 200 120 220" stroke="url(#orgGradient)" strokeWidth="2" fill="none" strokeDasharray="5,5" className={animated ? 'animate-fade-in animate-delay-1000' : ''} />
        <path d="M200 180 Q200 200 280 220" stroke="#10b981" strokeWidth="2" fill="none" strokeDasharray="5,5" className={animated ? 'animate-fade-in animate-delay-1200' : ''} />
        
        {/* 中心图标 */}
        <circle cx="200" cy="180" r="20" fill="white" stroke="#e5e7eb" strokeWidth="2" className={animated ? 'animate-scale-in animate-delay-800' : ''} />
        <path d="M190 180 L200 170 L210 180 L200 190 Z" fill="#667eea" className={animated ? 'animate-rotate-in animate-delay-1500' : ''} />
      </svg>
    ),

    productivity: (
      <svg viewBox="0 0 400 300" className={cn(sizeClasses[size], animated && 'animate-zoom-in', className)}>
        <defs>
          <linearGradient id="prodGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#43e97b" />
            <stop offset="100%" stopColor="#38f9d7" />
          </linearGradient>
        </defs>
        
        {/* 背景网格 */}
        <defs>
          <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#e5e7eb" strokeWidth="1" opacity="0.3" />
          </pattern>
        </defs>
        <rect width="400" height="300" fill="url(#grid)" />
        
        {/* 图表 */}
        <rect x="100" y="200" width="20" height="60" fill="url(#prodGradient)" className={animated ? 'animate-slide-in-up stagger-1' : ''} />
        <rect x="140" y="180" width="20" height="80" fill="url(#prodGradient)" className={animated ? 'animate-slide-in-up stagger-2' : ''} />
        <rect x="180" y="160" width="20" height="100" fill="url(#prodGradient)" className={animated ? 'animate-slide-in-up stagger-3' : ''} />
        <rect x="220" y="140" width="20" height="120" fill="url(#prodGradient)" className={animated ? 'animate-slide-in-up stagger-4' : ''} />
        <rect x="260" y="120" width="20" height="140" fill="url(#prodGradient)" className={animated ? 'animate-slide-in-up stagger-5' : ''} />
        
        {/* 趋势线 */}
        <path d="M110 240 L150 220 L190 200 L230 180 L270 160" stroke="#10b981" strokeWidth="3" fill="none" className={animated ? 'animate-fade-in animate-delay-1000' : ''} />
        
        {/* 装饰元素 */}
        <circle cx="320" cy="80" r="15" fill="url(#prodGradient)" opacity="0.3" className={animated ? 'animate-heartbeat animate-delay-1500' : ''} />
        <circle cx="80" cy="100" r="10" fill="#f59e0b" opacity="0.3" className={animated ? 'animate-heartbeat animate-delay-1700' : ''} />
      </svg>
    ),
  };

  const illustration = illustrations[name as keyof typeof illustrations];
  
  if (!illustration) {
    console.warn(`ModernIllustration: Illustration "${name}" not found`);
    return null;
  }

  return illustration;
};

const DecorativeElement: React.FC<DecorativeElementProps> = ({
  type,
  size = 'md',
  color = 'primary',
  className,
  animated = false,
}) => {
  const sizeClasses = {
    sm: 'w-16 h-16',
    md: 'w-24 h-24',
    lg: 'w-32 h-32',
  };

  const colorClasses = {
    primary: 'text-blue-500',
    secondary: 'text-purple-500',
    accent: 'text-pink-500',
    neutral: 'text-gray-400',
  };

  const elements = {
    dots: (
      <div className={cn('grid grid-cols-3 gap-2', sizeClasses[size], className)}>
        {Array.from({ length: 9 }).map((_, i) => (
          <div
            key={i}
            className={cn(
              'w-2 h-2 rounded-full',
              colorClasses[color],
              'bg-current opacity-60',
              animated && 'animate-pulse',
              animated && `animate-delay-${i * 100}`
            )}
          />
        ))}
      </div>
    ),

    lines: (
      <svg className={cn(sizeClasses[size], className)} viewBox="0 0 100 100">
        {Array.from({ length: 5 }).map((_, i) => (
          <line
            key={i}
            x1="10"
            y1={20 + i * 15}
            x2="90"
            y2={20 + i * 15}
            stroke="currentColor"
            strokeWidth="2"
            className={cn(
              colorClasses[color],
              'opacity-40',
              animated && 'animate-fade-in',
              animated && `animate-delay-${i * 200}`
            )}
          />
        ))}
      </svg>
    ),

    circles: (
      <svg className={cn(sizeClasses[size], className)} viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="40" fill="none" stroke="currentColor" strokeWidth="2" className={cn(colorClasses[color], 'opacity-20')} />
        <circle cx="50" cy="50" r="25" fill="none" stroke="currentColor" strokeWidth="2" className={cn(colorClasses[color], 'opacity-40')} />
        <circle cx="50" cy="50" r="10" fill="currentColor" className={cn(colorClasses[color], 'opacity-60', animated && 'animate-pulse')} />
      </svg>
    ),

    waves: (
      <svg className={cn(sizeClasses[size], className)} viewBox="0 0 100 100">
        <path
          d="M0,50 Q25,30 50,50 T100,50"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={cn(colorClasses[color], 'opacity-60', animated && 'animate-float')}
        />
        <path
          d="M0,60 Q25,40 50,60 T100,60"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={cn(colorClasses[color], 'opacity-40', animated && 'animate-float animate-delay-300')}
        />
        <path
          d="M0,70 Q25,50 50,70 T100,70"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={cn(colorClasses[color], 'opacity-20', animated && 'animate-float animate-delay-500')}
        />
      </svg>
    ),

    grid: (
      <svg className={cn(sizeClasses[size], className)} viewBox="0 0 100 100">
        <defs>
          <pattern id={`grid-${color}`} width="10" height="10" patternUnits="userSpaceOnUse">
            <path d="M 10 0 L 0 0 0 10" fill="none" stroke="currentColor" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="100" height="100" fill={`url(#grid-${color})`} className={cn(colorClasses[color], 'opacity-30')} />
      </svg>
    ),

    'gradient-orb': (
      <div className={cn(sizeClasses[size], 'relative', className)}>
        <div
          className={cn(
            'absolute inset-0 rounded-full',
            'bg-gradient-to-br from-blue-400 via-purple-500 to-pink-500',
            'opacity-60 blur-sm',
            animated && 'animate-glow'
          )}
        />
        <div
          className={cn(
            'absolute inset-2 rounded-full',
            'bg-gradient-to-br from-blue-300 via-purple-400 to-pink-400',
            'opacity-80',
            animated && 'animate-pulse'
          )}
        />
      </div>
    ),
  };

  return elements[type] || null;
};

export { ModernIllustration, DecorativeElement };
export default ModernIllustration;
