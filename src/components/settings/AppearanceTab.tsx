import React from 'react';
import { useAppSelector, useAppDispatch } from '@/store/hooks';
import { updateSettings, saveSettings } from '@/store/slices/settingsSlice';
import { ThemeStyleSelector } from '../layout/ThemeStyleSelector';
import { cn } from '@/lib/utils';

type ThemeMode = 'light' | 'dark' | 'auto';

/**
 * Appearance settings: 明暗模式 + 主题风格（3 选 1，已精简）。
 * ThemeStyleSelector 仍然以紧凑面板方式渲染，置于全宽容器内，
 * 让用户可以预览更大的主题卡片。
 */
export const AppearanceTab: React.FC = () => {
  const dispatch = useAppDispatch();
  const themeMode = useAppSelector(s => s.settings.themeMode) ?? 'auto';

  const handleSetMode = (mode: ThemeMode) => {
    if (mode === themeMode) return;
    dispatch(updateSettings({ themeMode: mode }));
    void dispatch(saveSettings() as any);
  };

  return (
    <div className="max-w-3xl space-y-6">
      <section className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          明暗模式
        </h3>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          选择界面主题；自动模式会跟随系统设置。
        </p>
        <div className="mt-4 grid grid-cols-3 gap-2">
          {(
            [
              { value: 'light', label: '浅色' },
              { value: 'dark', label: '深色' },
              { value: 'auto', label: '跟随系统' },
            ] as { value: ThemeMode; label: string }[]
          ).map(opt => (
            <button
              key={opt.value}
              onClick={() => handleSetMode(opt.value)}
              className={cn(
                'rounded-md border px-3 py-2 text-sm flat-interaction',
                themeMode === opt.value
                  ? 'border-primary-500 bg-primary-50 text-primary-700 dark:bg-primary-900/30 dark:text-primary-200'
                  : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'
              )}
              aria-pressed={themeMode === opt.value}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          主题风格
        </h3>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          从 3 个精心挑选的主题中选择。每个主题都有独立的配色与排版细节。
        </p>
        <div className="mt-4">
          <ThemeStyleSelector />
        </div>
      </section>
    </div>
  );
};

export default AppearanceTab;
