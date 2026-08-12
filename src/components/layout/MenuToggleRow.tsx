import React from 'react';

interface MenuToggleRowProps {
  label: string;
  checked: boolean;
  onChange: () => void;
  ariaLabel?: string;
}

/** 菜单中的开关行：左侧文案 + 右侧滑动开关。三个设置开关共用，保证样式一致。 */
export const MenuToggleRow: React.FC<MenuToggleRowProps> = ({ label, checked, onChange, ariaLabel }) => (
  <div className="flex items-center justify-between py-1.5">
    <span className="text-sm text-gray-700 dark:text-gray-300">{label}</span>
    <button
      onClick={onChange}
      className={`relative inline-flex h-5 w-10 items-center rounded-full flat-interaction transition-colors ${
        checked ? 'bg-primary-600' : 'bg-gray-200 dark:bg-gray-600'
      }`}
      aria-label={ariaLabel ?? label}
      type="button"
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0.5'
        }`}
      />
    </button>
  </div>
);

export default MenuToggleRow;
