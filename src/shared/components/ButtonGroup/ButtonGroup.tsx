/**
 * 按钮组组件
 * 将多个相关按钮组合在一起
 */

import React, { Children, cloneElement, isValidElement } from 'react';
import { cn } from '@/shared/utils/cn';
import { getButtonGroupItemStyles, buttonGroupStyles, ButtonStyleOptions } from '@/shared/utils/buttonStyles';

export interface ButtonGroupProps {
  children: React.ReactNode;
  orientation?: 'horizontal' | 'vertical';
  variant?: ButtonStyleOptions['variant'];
  size?: ButtonStyleOptions['size'];
  className?: string;
}

const ButtonGroup: React.FC<ButtonGroupProps> = ({
  children,
  orientation = 'horizontal',
  variant,
  size,
  className,
}) => {
  const childrenArray = Children.toArray(children);
  const validChildren = childrenArray.filter(child => isValidElement(child));

  const getChildPosition = (index: number, total: number) => {
    if (total === 1) return 'only';
    if (index === 0) return 'first';
    if (index === total - 1) return 'last';
    return 'middle';
  };

  const enhancedChildren = validChildren.map((child, index) => {
    if (!isValidElement(child)) return child;

    const position = getChildPosition(index, validChildren.length);
    const childProps = child.props;

    // 合并样式选项
    const styleOptions: ButtonStyleOptions = {
      variant: childProps.variant || variant,
      size: childProps.size || size,
      ...childProps,
    };

    // 生成按钮组项目样式
    const groupItemStyles = getButtonGroupItemStyles(position, styleOptions);

    return cloneElement(child, {
      ...childProps,
      className: cn(groupItemStyles, childProps.className),
      key: index,
    });
  });

  return (
    <div
      className={cn(
        buttonGroupStyles[orientation],
        className
      )}
      role="group"
    >
      {enhancedChildren}
    </div>
  );
};

export { ButtonGroup };
export default ButtonGroup;
