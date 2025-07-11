/**
 * 分隔符组件
 * 视觉分隔线
 */
import React from 'react';
import { cn } from '@/shared/utils/cn';

export interface DividerProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: 'horizontal' | 'vertical';
  variant?: 'solid' | 'dashed' | 'dotted';
  thickness?: 'thin' | 'medium' | 'thick';
  spacing?: 'sm' | 'md' | 'lg';
  label?: string;
}

const Divider: React.FC<DividerProps> = ({
  className,
  orientation = 'horizontal',
  variant = 'solid',
  thickness = 'thin',
  spacing = 'md',
  label,
  ...props
}) => {
  const baseStyles = 'border-gray-300 dark:border-gray-600';

  const orientationStyles = {
    horizontal: 'w-full border-t',
    vertical: 'h-full border-l',
  };

  const variantStyles = {
    solid: 'border-solid',
    dashed: 'border-dashed',
    dotted: 'border-dotted',
  };

  const thicknessStyles = {
    thin: 'border-t-1',
    medium: 'border-t-2',
    thick: 'border-t-4',
  };

  const spacingStyles = {
    horizontal: {
      sm: 'my-2',
      md: 'my-4',
      lg: 'my-6',
    },
    vertical: {
      sm: 'mx-2',
      md: 'mx-4',
      lg: 'mx-6',
    },
  };

  const classes = cn(
    baseStyles,
    orientationStyles[orientation],
    variantStyles[variant],
    orientation === 'horizontal' ? thicknessStyles[thickness] : `border-l-${thickness === 'thin' ? '1' : thickness === 'medium' ? '2' : '4'}`,
    spacingStyles[orientation][spacing],
    className
  );

  if (label && orientation === 'horizontal') {
    return (
      <div className={cn('relative', spacingStyles[orientation][spacing])} {...props}>
        <div className="absolute inset-0 flex items-center">
          <div className={cn(baseStyles, 'w-full border-t', variantStyles[variant], thicknessStyles[thickness])} />
        </div>
        <div className="relative flex justify-center text-sm">
          <span className="bg-white px-2 text-gray-500 dark:bg-gray-900 dark:text-gray-400">
            {label}
          </span>
        </div>
      </div>
    );
  }

  return <div className={classes} {...props} />;
};

export { Divider };