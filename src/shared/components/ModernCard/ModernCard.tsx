/**
 * 现代化卡片组件
 * 具有吸引力的卡片样式，包括渐变背景、立体阴影、创新边框设计等
 */

import React from 'react';
import { cn } from '@/shared/utils/cn';

export interface ModernCardProps {
  children: React.ReactNode;
  variant?: 'default' | 'elevated' | 'glass' | 'gradient' | 'neon' | 'minimal' | 'bordered';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  interactive?: boolean;
  glowColor?: 'primary' | 'secondary' | 'success' | 'warning' | 'danger';
  className?: string;
  onClick?: () => void;
}

export interface ModernCardHeaderProps {
  children: React.ReactNode;
  className?: string;
}

export interface ModernCardContentProps {
  children: React.ReactNode;
  className?: string;
}

export interface ModernCardFooterProps {
  children: React.ReactNode;
  className?: string;
}

const ModernCard: React.FC<ModernCardProps> = ({
  children,
  variant = 'default',
  size = 'md',
  interactive = false,
  glowColor = 'primary',
  className,
  onClick,
}) => {
  const baseClasses = 'relative overflow-hidden transition-all duration-500 ease-out';
  
  const variantClasses = {
    default: 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-lg hover:shadow-xl',
    
    elevated: 'bg-white dark:bg-gray-800 shadow-xl hover:shadow-2xl border-0',
    
    glass: `
      bg-white/10 dark:bg-black/10 
      backdrop-blur-xl 
      border border-white/20 dark:border-white/10 
      shadow-2xl 
      hover:bg-white/20 dark:hover:bg-black/20
    `,
    
    gradient: `
      bg-gradient-to-br from-blue-500 via-purple-500 to-pink-500 
      text-white 
      shadow-2xl 
      hover:shadow-3xl 
      border-0
      before:absolute before:inset-0 before:bg-gradient-to-br before:from-white/20 before:to-transparent before:opacity-0 before:transition-opacity before:duration-300
      hover:before:opacity-100
    `,
    
    neon: `
      bg-gray-900 dark:bg-black 
      border-2 border-cyan-400 
      shadow-lg shadow-cyan-400/50 
      hover:shadow-xl hover:shadow-cyan-400/70
      text-cyan-100
    `,
    
    minimal: 'bg-transparent border-0 shadow-none hover:bg-gray-50 dark:hover:bg-gray-800/50',
    
    bordered: `
      bg-white dark:bg-gray-800 
      border-2 border-gray-300 dark:border-gray-600 
      hover:border-blue-400 dark:hover:border-blue-500
      shadow-md hover:shadow-lg
    `,
  };

  const sizeClasses = {
    sm: 'p-4 rounded-xl',
    md: 'p-6 rounded-2xl',
    lg: 'p-8 rounded-3xl',
    xl: 'p-10 rounded-3xl',
  };

  const interactiveClasses = interactive
    ? `cursor-pointer transform hover:scale-[1.02] active:scale-[0.98] 
       focus:outline-none focus:ring-4 focus:ring-blue-500/20`
    : '';

  const glowClasses = {
    primary: 'hover:shadow-blue-500/25',
    secondary: 'hover:shadow-purple-500/25',
    success: 'hover:shadow-green-500/25',
    warning: 'hover:shadow-yellow-500/25',
    danger: 'hover:shadow-red-500/25',
  };

  return (
    <div
      className={cn(
        baseClasses,
        variantClasses[variant],
        sizeClasses[size],
        interactiveClasses,
        interactive && glowClasses[glowColor],
        className
      )}
      onClick={onClick}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
    >
      {/* 装饰性光效 */}
      {variant === 'gradient' && (
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent -skew-x-12 -translate-x-full group-hover:translate-x-full transition-transform duration-1000" />
      )}
      
      {/* 边框光效 */}
      {variant === 'neon' && (
        <div className="absolute inset-0 rounded-inherit border-2 border-cyan-400 animate-pulse" />
      )}
      
      {children}
    </div>
  );
};

const ModernCardHeader: React.FC<ModernCardHeaderProps> = ({ children, className }) => {
  return (
    <div className={cn('mb-6 relative', className)}>
      {children}
    </div>
  );
};

const ModernCardContent: React.FC<ModernCardContentProps> = ({ children, className }) => {
  return (
    <div className={cn('relative', className)}>
      {children}
    </div>
  );
};

const ModernCardFooter: React.FC<ModernCardFooterProps> = ({ children, className }) => {
  return (
    <div className={cn('mt-6 pt-6 border-t border-gray-200 dark:border-gray-700 relative', className)}>
      {children}
    </div>
  );
};

// 特殊卡片变体组件
export const ModernCardSpotlight: React.FC<ModernCardProps> = (props) => {
  return (
    <div className="group relative">
      <div className="absolute -inset-0.5 bg-gradient-to-r from-pink-600 to-purple-600 rounded-2xl blur opacity-30 group-hover:opacity-100 transition duration-1000 group-hover:duration-200 animate-tilt"></div>
      <ModernCard {...props} variant="elevated" className={cn("relative", props.className)} />
    </div>
  );
};

export const ModernCardHolographic: React.FC<ModernCardProps> = (props) => {
  return (
    <div className="relative group">
      <div className="absolute inset-0 bg-gradient-to-r from-blue-600 via-purple-600 to-pink-600 rounded-2xl opacity-0 group-hover:opacity-20 transition-opacity duration-500"></div>
      <ModernCard 
        {...props} 
        variant="glass" 
        className={cn(
          "relative border-2 border-transparent bg-gradient-to-r from-blue-500/10 via-purple-500/10 to-pink-500/10",
          "hover:border-gradient-to-r hover:from-blue-500 hover:via-purple-500 hover:to-pink-500",
          props.className
        )} 
      />
    </div>
  );
};

export const ModernCardFloating: React.FC<ModernCardProps> = (props) => {
  return (
    <ModernCard 
      {...props} 
      variant="elevated"
      className={cn(
        "animate-float shadow-2xl hover:shadow-3xl",
        "before:absolute before:inset-0 before:bg-gradient-to-br before:from-white/5 before:to-transparent before:rounded-inherit",
        props.className
      )}
    />
  );
};

// 导出组件
export { ModernCard, ModernCardHeader, ModernCardContent, ModernCardFooter };
export default ModernCard;
