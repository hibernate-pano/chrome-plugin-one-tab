import React from 'react';

/**
 * Task 4.3 placeholder. The full SettingsTabs implementation (6 vertical
 * tabs + sub-views) lands in Task 4.4. This stub exists so MainApp can route
 * to a stable onClose-shaped component while the slim Header in Task 4.3
 * wires the kebab menu to it.
 *
 * Contract (matches Task 4.4 plan):
 *   <SettingsTabs onClose={() => setShowSettings(false)} />
 *
 * Task 4.4 will:
 *   - replace this stub with the 6-tab layout from
 *     `docs/superpowers/plans/...plan.md` lines 1414-1446
 *   - create AccountTab / SyncTab / AppearanceTab / ImportExportTab /
 *     NotificationsTab / DangerZoneTab siblings in this directory
 *   - migrate content from `src/components/layout/HeaderDropdown.tsx`
 */

interface SettingsTabsProps {
  onClose: () => void;
}

export const SettingsTabs: React.FC<SettingsTabsProps> = ({ onClose }) => {
  return (
    <div className="min-h-screen bg-white dark:bg-gray-900 dark:text-gray-100 flex flex-col">
      <header className="border-b border-gray-200 dark:border-gray-700 px-4 py-3 flex items-center gap-3">
        <button
          onClick={onClose}
          className="text-sm text-primary-600 dark:text-primary-400 flat-interaction"
          aria-label="返回主界面"
        >
          ← 返回
        </button>
        <h1 className="text-base font-semibold">设置</h1>
      </header>
      <main className="flex-1 p-4 text-sm text-gray-600 dark:text-gray-300">
        <p>设置面板占位（Task 4.3 临时占位）。</p>
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          Task 4.4 将引入完整的 6 项垂直菜单（账户 / 同步 / 外观 / 导入导出 / 通知 / 危险区）。
        </p>
      </main>
    </div>
  );
};

export default SettingsTabs;
