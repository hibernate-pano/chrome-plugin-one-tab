/**
 * 新手引导遮罩层组件
 * 提供聚光灯效果和背景遮罩
 */

import React, { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useOnboarding } from './OnboardingProvider';
import { OnboardingTooltip } from './OnboardingTooltip';
import { OnboardingProgress } from './OnboardingProgress';

interface ElementPosition {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface OnboardingOverlayProps {
  className?: string;
  zIndex?: number;
}

export const OnboardingOverlay: React.FC<OnboardingOverlayProps> = ({
  className = '',
  zIndex = 9999,
}) => {
  const {
    isActive,
    currentStep,
    currentStepIndex,
    totalSteps,
    stop,
    next,
    prev,
    skip,
    canGoNext,
    canGoPrev,
    canSkip,
  } = useOnboarding();
  
  const [targetPosition, setTargetPosition] = useState<ElementPosition | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  
  // 计算目标元素位置
  const updateTargetPosition = useCallback(() => {
    if (!currentStep?.targetElement) {
      setTargetPosition(null);
      return;
    }
    
    const element = document.querySelector(currentStep.targetElement) as HTMLElement;
    if (!element) {
      setTargetPosition(null);
      return;
    }
    
    const rect = element.getBoundingClientRect();
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
    
    setTargetPosition({
      top: rect.top + scrollTop,
      left: rect.left + scrollLeft,
      width: rect.width,
      height: rect.height,
    });
  }, [currentStep?.targetElement]);
  
  // 监听窗口大小变化和滚动
  useEffect(() => {
    if (!isActive) return;
    
    updateTargetPosition();
    
    const handleResize = () => updateTargetPosition();
    const handleScroll = () => updateTargetPosition();
    
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleScroll);
    
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleScroll);
    };
  }, [isActive, updateTargetPosition]);
  
  // 显示/隐藏动画
  useEffect(() => {
    if (isActive) {
      setIsVisible(true);
    } else {
      const timer = setTimeout(() => setIsVisible(false), 300);
      return () => clearTimeout(timer);
    }
  }, [isActive]);
  
  // 键盘事件处理
  useEffect(() => {
    if (!isActive) return;
    
    const handleKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case 'Escape':
          stop();
          break;
        case 'ArrowRight':
        case 'Enter':
          if (canGoNext) {
            next();
          }
          break;
        case 'ArrowLeft':
          if (canGoPrev) {
            prev();
          }
          break;
        case 'Tab':
          if (canSkip) {
            event.preventDefault();
            skip();
          }
          break;
      }
    };
    
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isActive, canGoNext, canGoPrev, canSkip, stop, next, prev, skip]);
  
  if (!isVisible) return null;
  
  // 生成聚光灯路径
  const generateSpotlightPath = () => {
    if (!targetPosition) {
      return 'M0,0 L100vw,0 L100vw,100vh L0,100vh Z';
    }
    
    const { top, left, width, height } = targetPosition;
    const padding = 8; // 聚光灯边距
    
    const spotlightLeft = Math.max(0, left - padding);
    const spotlightTop = Math.max(0, top - padding);
    const spotlightWidth = width + padding * 2;
    const spotlightHeight = height + padding * 2;
    
    // 创建带圆角的聚光灯区域
    const borderRadius = 8;
    
    return `
      M0,0 
      L100vw,0 
      L100vw,100vh 
      L0,100vh 
      Z
      M${spotlightLeft + borderRadius},${spotlightTop}
      L${spotlightLeft + spotlightWidth - borderRadius},${spotlightTop}
      Q${spotlightLeft + spotlightWidth},${spotlightTop} ${spotlightLeft + spotlightWidth},${spotlightTop + borderRadius}
      L${spotlightLeft + spotlightWidth},${spotlightTop + spotlightHeight - borderRadius}
      Q${spotlightLeft + spotlightWidth},${spotlightTop + spotlightHeight} ${spotlightLeft + spotlightWidth - borderRadius},${spotlightTop + spotlightHeight}
      L${spotlightLeft + borderRadius},${spotlightTop + spotlightHeight}
      Q${spotlightLeft},${spotlightTop + spotlightHeight} ${spotlightLeft},${spotlightTop + spotlightHeight - borderRadius}
      L${spotlightLeft},${spotlightTop + borderRadius}
      Q${spotlightLeft},${spotlightTop} ${spotlightLeft + borderRadius},${spotlightTop}
      Z
    `;
  };
  
  const overlayContent = (
    <div
      className={`fixed inset-0 transition-all duration-300 ${
        isActive ? 'opacity-100' : 'opacity-0'
      } ${className}`}
      style={{ zIndex }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      aria-describedby="onboarding-description"
    >
      {/* 背景遮罩 */}
      <div className="absolute inset-0 bg-black bg-opacity-50 transition-opacity duration-300" />
      
      {/* 聚光灯效果 */}
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none"
        style={{ zIndex: zIndex + 1 }}
      >
        <defs>
          <mask id="spotlight-mask">
            <rect width="100%" height="100%" fill="white" />
            <path
              d={generateSpotlightPath()}
              fill="black"
              fillRule="evenodd"
            />
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="rgba(0, 0, 0, 0.7)"
          mask="url(#spotlight-mask)"
        />
      </svg>
      
      {/* 聚光灯边框动画 */}
      {targetPosition && (
        <div
          className="absolute border-2 border-blue-400 rounded-lg pointer-events-none animate-pulse"
          style={{
            top: targetPosition.top - 8,
            left: targetPosition.left - 8,
            width: targetPosition.width + 16,
            height: targetPosition.height + 16,
            zIndex: zIndex + 2,
            boxShadow: '0 0 20px rgba(59, 130, 246, 0.5)',
          }}
        />
      )}
      
      {/* 引导提示框 */}
      {currentStep && (
        <OnboardingTooltip
          step={currentStep}
          targetPosition={targetPosition}
          onNext={canGoNext ? next : undefined}
          onPrev={canGoPrev ? prev : undefined}
          onSkip={canSkip ? skip : undefined}
          onClose={stop}
          style={{ zIndex: zIndex + 3 }}
        />
      )}
      
      {/* 进度指示器 */}
      <OnboardingProgress
        currentStep={currentStepIndex + 1}
        totalSteps={totalSteps}
        className="fixed top-4 left-1/2 transform -translate-x-1/2"
        style={{ zIndex: zIndex + 3 }}
      />
      
      {/* 跳过按钮 */}
      <button
        onClick={stop}
        className="fixed top-4 right-4 text-white hover:text-gray-300 transition-colors"
        style={{ zIndex: zIndex + 3 }}
        title="跳过引导 (Esc)"
      >
        <svg
          className="w-6 h-6"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>
  );
  
  // 使用 Portal 渲染到 body
  return createPortal(overlayContent, document.body);
};

// 聚光灯动画样式
const spotlightStyles = `
  @keyframes spotlight-pulse {
    0%, 100% {
      box-shadow: 0 0 20px rgba(59, 130, 246, 0.5);
    }
    50% {
      box-shadow: 0 0 30px rgba(59, 130, 246, 0.8);
    }
  }
  
  .spotlight-border {
    animation: spotlight-pulse 2s ease-in-out infinite;
  }
`;

// 注入样式（仅在浏览器环境）
if (typeof document !== 'undefined' && !document.querySelector('#onboarding-styles')) {
  const styleElement = document.createElement('style');
  styleElement.id = 'onboarding-styles';
  styleElement.textContent = spotlightStyles;
  document.head.appendChild(styleElement);
}
