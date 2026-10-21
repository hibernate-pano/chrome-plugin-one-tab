import React from 'react';
import { cn } from '@/lib/utils';

/**
 * 折叠/展开指示箭头（2026-10-20 第二轮审计：从 ThemeStyleSelector 里提出来单源化）。
 *
 * 【为什么提出来】这个 SVG 此前是 `ThemeStyleSelector.tsx` 里的**局部**组件，
 * 而设置页的「自带存储配置」区块也要一个同款箭头（同一个披露控件语法）。
 * 复制一份就会有两份箭头 —— 改形状时漏改一处，两个控件的箭头就长得不一样，
 * 而用户不会知道那是「故意不同的」。
 *
 * 【为什么 aria-hidden】它是**装饰**：形状由父按钮的文字与 `aria-expanded`
 * 表达。读屏再念一句「折叠箭头」是噪音；而 `aria-hidden` 的元素不参与
 * 无障碍树，正好符合「纯装饰」的定位。
 */
export interface ChevronIconProps {
  /** 展开时箭头翻转 180°。 */
  isExpanded?: boolean;
  className?: string;
}

export const ChevronIcon: React.FC<ChevronIconProps> = ({ isExpanded = false, className }) => (
  <svg
    className={cn(
      'w-4 h-4 transition-transform duration-200',
      isExpanded && 'rotate-180',
      className
    )}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    aria-hidden="true"
    focusable="false"
  >
    <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export default ChevronIcon;
