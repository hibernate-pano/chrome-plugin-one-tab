import React from 'react';

interface MenuSectionProps {
  title: string;
  children: React.ReactNode;
  /** 分组上方是否显示分隔线（首个分组可不显示） */
  showDivider?: boolean;
}

/** 下拉菜单分组：小标题 + 子项。分隔线统一在此处理，保持菜单纵向节奏一致。 */
export const MenuSection: React.FC<MenuSectionProps> = ({ title, children, showDivider = true }) => (
  <>
    {showDivider && <div className="border-t border-gray-200 dark:border-gray-700 my-1"></div>}
    <div className="px-4 py-2">
      <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2">{title}</p>
      {children}
    </div>
  </>
);

export default MenuSection;
