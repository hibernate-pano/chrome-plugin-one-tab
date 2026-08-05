import React, { lazy, Suspense, useState } from 'react';
import { AccountTab } from './AccountTab';
import { SyncTab } from './SyncTab';
import { AppearanceTab } from './AppearanceTab';
import { ImportExportTab } from './ImportExportTab';
import { NotificationsTab } from './NotificationsTab';
import { DangerZoneTab } from './DangerZoneTab';
import { cn } from '@/lib/utils';

// 统计面板懒加载（复用原 MainApp 中的 lazy 入口，使 StatsPanel 可达）
const StatsPanel = lazy(() =>
  import('@/components/stats/StatsPanel').then(m => ({ default: m.StatsPanel }))
);

type TabId =
  | 'account'
  | 'sync'
  | 'appearance'
  | 'import-export'
  | 'notifications'
  | 'danger'
  | 'stats';

interface TabMeta {
  id: TabId;
  label: string;
  description: string;
  component: React.FC<{ onClose?: () => void }>;
}

const TABS: TabMeta[] = [
  { id: 'account', label: '账户', description: '登录 / 登出 / 账户信息', component: AccountTab },
  { id: 'sync', label: '同步', description: '云端同步状态与手动操作', component: SyncTab },
  { id: 'appearance', label: '外观', description: '主题与明暗模式', component: AppearanceTab },
  {
    id: 'import-export',
    label: '导入 / 导出',
    description: 'JSON / OneTab 格式数据备份',
    component: ImportExportTab,
  },
  {
    id: 'notifications',
    label: '通知',
    description: '通知提醒 / 确认 / 收集固定页',
    component: NotificationsTab,
  },
  { id: 'danger', label: '危险区', description: '清空所有本地会话', component: DangerZoneTab },
  {
    id: 'stats',
    label: '统计',
    description: '会话 / 标签 / 本周活动概览',
    component: StatsPanel,
  },
];

interface SettingsTabsProps {
  onClose: () => void;
}

/**
 * Full-screen settings shell with vertical sidebar of 6 categories.
 * Replaces the old floating `HeaderDropdown` popup. Content from that
 * component has been migrated to the sibling `*Tab` components.
 */
export const SettingsTabs: React.FC<SettingsTabsProps> = ({ onClose }) => {
  const [active, setActive] = useState<TabId>('account');
  const activeMeta = TABS.find(t => t.id === active) ?? TABS[0];
  const Active = activeMeta.component;

  return (
    <div className="grid h-screen grid-cols-[160px_1fr] bg-white text-gray-900 dark:bg-gray-900 dark:text-gray-100">
      <aside className="flex flex-col overflow-y-auto border-r border-gray-200 dark:border-gray-700">
        <button
          onClick={onClose}
          className="m-3 inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-left text-sm text-primary-600 hover:bg-gray-100 dark:text-primary-400 dark:hover:bg-gray-800 flat-interaction"
          aria-label="返回主界面"
        >
          ← 返回
        </button>
        <h2 className="px-4 pb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          设置
        </h2>
        <nav className="flex-1 px-2 pb-3" aria-label="设置分类">
          {TABS.map(tab => {
            const isActive = tab.id === active;
            return (
              <button
                key={tab.id}
                onClick={() => setActive(tab.id)}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'mb-1 block w-full rounded-md px-3 py-2 text-left text-sm flat-interaction',
                  isActive
                    ? 'bg-primary-50 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300'
                    : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'
                )}
              >
                <span className="block font-medium">{tab.label}</span>
                <span
                  className={cn(
                    'mt-0.5 block text-[11px] leading-snug',
                    isActive
                      ? 'text-primary-600/80 dark:text-primary-300/80'
                      : 'text-gray-500 dark:text-gray-400'
                  )}
                >
                  {tab.description}
                </span>
              </button>
            );
          })}
        </nav>
      </aside>
      <main className="overflow-y-auto p-6">
        <header className="mb-4 border-b border-gray-200 pb-3 dark:border-gray-700">
          <h1 className="text-lg font-semibold">{activeMeta.label}</h1>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            {activeMeta.description}
          </p>
        </header>
        <Suspense fallback={<div className="py-10 text-center text-sm text-gray-500 dark:text-gray-400">加载中...</div>}>
          <Active onClose={onClose} />
        </Suspense>
      </main>
    </div>
  );
};

export default SettingsTabs;
