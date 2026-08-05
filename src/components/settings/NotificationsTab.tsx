import React from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import {
  toggleShowNotifications,
  toggleConfirmBeforeDelete,
  toggleCollectPinnedTabs,
  saveSettings,
} from '@/store/slices/settingsSlice';
import { cn } from '@/lib/utils';

interface ToggleRowProps {
  label: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
}

const ToggleRow: React.FC<ToggleRowProps> = ({ label, description, checked, onToggle }) => {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div>
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{label}</p>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{description}</p>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        onClick={onToggle}
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors flat-interaction',
          checked ? 'bg-primary-600' : 'bg-gray-200 dark:bg-gray-600'
        )}
      >
        <span
          className={cn(
            'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
            checked ? 'translate-x-6' : 'translate-x-1'
          )}
        />
      </button>
    </div>
  );
};

/**
 * Notifications tab. Migrated the three toggle rows from
 * `HeaderDropdown`: 通知提醒 / 删除前确认 / 保存固定标签页.
 */
export const NotificationsTab: React.FC = () => {
  const dispatch = useAppDispatch();
  const settings = useAppSelector(state => state.settings);

  const toggle = (action: () => void) => async () => {
    action();
    await dispatch(saveSettings() as any);
  };

  return (
    <div className="max-w-xl space-y-6">
      <section className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          提醒与确认
        </h3>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          控制 TabStack 在什么时候弹出通知、什么时候要求二次确认。
        </p>
        <div className="mt-3 divide-y divide-gray-100 dark:divide-gray-700">
          <ToggleRow
            label="通知提醒"
            description="保存会话、同步完成等事件触发浏览器通知。"
            checked={settings.showNotifications}
            onToggle={toggle(() => dispatch(toggleShowNotifications()))}
          />
          <ToggleRow
            label="删除前确认"
            description="每次删除会话前先弹窗确认。"
            checked={settings.confirmBeforeDelete}
            onToggle={toggle(() => dispatch(toggleConfirmBeforeDelete()))}
          />
        </div>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          标签页设置
        </h3>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          决定保存会话时是否一并收集已固定的标签页。
        </p>
        <div className="mt-3 divide-y divide-gray-100 dark:divide-gray-700">
          <ToggleRow
            label="保存固定标签页"
            description="保存当前窗口时把固定的标签页也加进会话。"
            checked={settings.collectPinnedTabs}
            onToggle={toggle(() => dispatch(toggleCollectPinnedTabs()))}
          />
        </div>
      </section>
    </div>
  );
};

export default NotificationsTab;
