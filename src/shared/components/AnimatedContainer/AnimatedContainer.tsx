/**
 * 统一的动画容器组件
 * 基于空标签页面的设计规范，提供一致的动画效果
 */

import React, { useState, useEffect } from 'react';
import { cn } from '@/shared/utils/cn';

export interface AnimatedContainerProps {
  children: React.ReactNode;
  animation?: 'fadeIn' | 'slideUp' | 'slideDown' | 'slideLeft' | 'slideRight' | 'scale' | 'none';
  delay?: number;
  duration?: number;
  className?: string;
  trigger?: boolean;
}

export interface StaggeredContainerProps {
  children: React.ReactNode;
  staggerDelay?: number;
  className?: string;
}

const AnimatedContainer: React.FC<AnimatedContainerProps> = ({
  children,
  animation = 'fadeIn',
  delay = 0,
  duration = 300,
  className,
  trigger = true,
}) => {
  const [isVisible, setIsVisible] = useState(!trigger);

  useEffect(() => {
    if (trigger) {
      const timer = setTimeout(() => {
        setIsVisible(true);
      }, delay);

      return () => clearTimeout(timer);
    }
  }, [trigger, delay]);

  const animationClasses = {
    fadeIn: {
      initial: 'opacity-0',
      animate: 'opacity-100',
      transition: 'transition-opacity ease-out',
    },
    slideUp: {
      initial: 'opacity-0 translate-y-4',
      animate: 'opacity-100 translate-y-0',
      transition: 'transition-all ease-out',
    },
    slideDown: {
      initial: 'opacity-0 -translate-y-4',
      animate: 'opacity-100 translate-y-0',
      transition: 'transition-all ease-out',
    },
    slideLeft: {
      initial: 'opacity-0 translate-x-4',
      animate: 'opacity-100 translate-x-0',
      transition: 'transition-all ease-out',
    },
    slideRight: {
      initial: 'opacity-0 -translate-x-4',
      animate: 'opacity-100 translate-x-0',
      transition: 'transition-all ease-out',
    },
    scale: {
      initial: 'opacity-0 scale-95',
      animate: 'opacity-100 scale-100',
      transition: 'transition-all ease-out',
    },
    none: {
      initial: '',
      animate: '',
      transition: '',
    },
  };

  const animationStyle = animationClasses[animation];
  const durationClass = `duration-${duration}`;

  return (
    <div
      className={cn(
        animationStyle.transition,
        durationClass,
        isVisible ? animationStyle.animate : animationStyle.initial,
        className
      )}
    >
      {children}
    </div>
  );
};

const StaggeredContainer: React.FC<StaggeredContainerProps> = ({
  children,
  staggerDelay = 150,
  className,
}) => {
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());

  useEffect(() => {
    const childrenArray = React.Children.toArray(children);
    
    childrenArray.forEach((_, index) => {
      setTimeout(() => {
        setVisibleItems(prev => new Set(prev).add(index));
      }, index * staggerDelay);
    });
  }, [children, staggerDelay]);

  return (
    <div className={className}>
      {React.Children.map(children, (child, index) => (
        <AnimatedContainer
          key={index}
          animation="slideUp"
          trigger={visibleItems.has(index)}
          duration={700}
        >
          {child}
        </AnimatedContainer>
      ))}
    </div>
  );
};

export { AnimatedContainer, StaggeredContainer };
export default AnimatedContainer;
