/**
 * 新手引导提示框组件
 * 显示引导步骤的详细信息和操作按钮
 */

import React, { useMemo } from 'react';
import type { OnboardingStep } from '../store/onboardingSlice';

interface ElementPosition {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface OnboardingTooltipProps {
  step: OnboardingStep;
  targetPosition: ElementPosition | null;
  onNext?: () => void;
  onPrev?: () => void;
  onSkip?: () => void;
  onClose: () => void;
  className?: string;
  style?: React.CSSProperties;
}

export const OnboardingTooltip: React.FC<OnboardingTooltipProps> = ({
  step,
  targetPosition,
  onNext,
  onPrev,
  onSkip,
  onClose,
  className = '',
  style = {},
}) => {
  // 计算提示框位置
  const tooltipPosition = useMemo(() => {
    if (!targetPosition) {
      // 居中显示
      return {
        position: 'center' as const,
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
      };
    }
    
    const { top, left, width, height } = targetPosition;
    const tooltipWidth = 320;
    const tooltipHeight = 200; // 估算高度
    const spacing = 16;
    
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const scrollTop = window.pageYOffset;
    const scrollLeft = window.pageXOffset;
    
    let position = step.position || 'bottom';
    let finalTop = 0;
    let finalLeft = 0;
    let arrowPosition = '';
    
    switch (position) {
      case 'top':
        finalTop = top - tooltipHeight - spacing;
        finalLeft = left + width / 2 - tooltipWidth / 2;
        arrowPosition = 'bottom';
        
        // 检查是否超出视口顶部
        if (finalTop < scrollTop + spacing) {
          position = 'bottom';
        }
        break;
        
      case 'bottom':
        finalTop = top + height + spacing;
        finalLeft = left + width / 2 - tooltipWidth / 2;
        arrowPosition = 'top';
        
        // 检查是否超出视口底部
        if (finalTop + tooltipHeight > scrollTop + viewportHeight - spacing) {
          position = 'top';
          finalTop = top - tooltipHeight - spacing;
        }
        break;
        
      case 'left':
        finalTop = top + height / 2 - tooltipHeight / 2;
        finalLeft = left - tooltipWidth - spacing;
        arrowPosition = 'right';
        
        // 检查是否超出视口左侧
        if (finalLeft < scrollLeft + spacing) {
          position = 'right';
        }
        break;
        
      case 'right':
        finalTop = top + height / 2 - tooltipHeight / 2;
        finalLeft = left + width + spacing;
        arrowPosition = 'left';
        
        // 检查是否超出视口右侧
        if (finalLeft + tooltipWidth > scrollLeft + viewportWidth - spacing) {
          position = 'left';
          finalLeft = left - tooltipWidth - spacing;
        }
        break;
        
      case 'center':
      default:
        return {
          position: 'center' as const,
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
        };
    }
    
    // 重新计算最终位置（处理位置调整后的情况）
    if (position !== step.position) {
      switch (position) {
        case 'top':
          finalTop = top - tooltipHeight - spacing;
          finalLeft = left + width / 2 - tooltipWidth / 2;
          arrowPosition = 'bottom';
          break;
        case 'bottom':
          finalTop = top + height + spacing;
          finalLeft = left + width / 2 - tooltipWidth / 2;
          arrowPosition = 'top';
          break;
        case 'left':
          finalTop = top + height / 2 - tooltipHeight / 2;
          finalLeft = left - tooltipWidth - spacing;
          arrowPosition = 'right';
          break;
        case 'right':
          finalTop = top + height / 2 - tooltipHeight / 2;
          finalLeft = left + width + spacing;
          arrowPosition = 'left';
          break;
      }
    }
    
    // 确保提示框在视口内
    finalLeft = Math.max(spacing, Math.min(finalLeft, viewportWidth - tooltipWidth - spacing));
    finalTop = Math.max(spacing, Math.min(finalTop, viewportHeight - tooltipHeight - spacing));
    
    return {
      position,
      top: finalTop,
      left: finalLeft,
      arrowPosition,
    };
  }, [targetPosition, step.position]);
  
  // 获取步骤图标
  const getStepIcon = () => {
    switch (step.action) {
      case 'click':
        return (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.121 2.122" />
          </svg>
        );
      case 'input':
        return (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
        );
      case 'observe':
        return (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
          </svg>
        );
      default:
        return (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        );
    }
  };
  
  const tooltipStyle = {
    ...style,
    position: 'absolute' as const,
    ...(tooltipPosition.position === 'center' 
      ? {
          top: tooltipPosition.top,
          left: tooltipPosition.left,
          transform: tooltipPosition.transform,
        }
      : {
          top: tooltipPosition.top,
          left: tooltipPosition.left,
        }
    ),
  };
  
  return (
    <div
      className={`bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 p-6 max-w-sm animate-in fade-in slide-in-from-bottom-2 duration-300 ${className}`}
      style={tooltipStyle}
      role="tooltip"
      aria-live="polite"
    >
      {/* 箭头 */}
      {tooltipPosition.position !== 'center' && tooltipPosition.arrowPosition && (
        <div
          className={`absolute w-3 h-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 transform rotate-45 ${
            tooltipPosition.arrowPosition === 'top' ? '-top-1.5 left-1/2 -translate-x-1/2 border-b-0 border-r-0' :
            tooltipPosition.arrowPosition === 'bottom' ? '-bottom-1.5 left-1/2 -translate-x-1/2 border-t-0 border-l-0' :
            tooltipPosition.arrowPosition === 'left' ? '-left-1.5 top-1/2 -translate-y-1/2 border-t-0 border-r-0' :
            '-right-1.5 top-1/2 -translate-y-1/2 border-b-0 border-l-0'
          }`}
        />
      )}
      
      {/* 头部 */}
      <div className="flex items-start space-x-3 mb-4">
        <div className="flex-shrink-0 w-8 h-8 bg-blue-100 dark:bg-blue-900 rounded-full flex items-center justify-center text-blue-600 dark:text-blue-400">
          {getStepIcon()}
        </div>
        <div className="flex-1 min-w-0">
          <h3 
            id="onboarding-title"
            className="text-lg font-semibold text-gray-900 dark:text-white mb-1"
          >
            {step.title}
          </h3>
          <p 
            id="onboarding-description"
            className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed"
          >
            {step.description}
          </p>
        </div>
      </div>
      
      {/* 操作按钮 */}
      <div className="flex items-center justify-between">
        <div className="flex space-x-2">
          {onPrev && (
            <button
              onClick={onPrev}
              className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
              title="上一步 (←)"
            >
              上一步
            </button>
          )}
        </div>
        
        <div className="flex space-x-2">
          {onSkip && (
            <button
              onClick={onSkip}
              className="px-3 py-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
              title="跳过 (Tab)"
            >
              跳过
            </button>
          )}
          
          {onNext ? (
            <button
              onClick={onNext}
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
              title="下一步 (→ 或 Enter)"
            >
              下一步
            </button>
          ) : (
            <button
              onClick={onClose}
              className="px-4 py-1.5 bg-green-600 hover:bg-green-700 text-white text-sm rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2"
            >
              完成
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
