import React, { useEffect, useState, useMemo } from 'react';
import { useAppSelector } from '@/store/hooks';
import { storage } from '@/utils/storage';

interface StatsData {
  totalSessions: number;
  totalTabs: number;
  totalDomains: number;
  savedThisWeek: number;
  restoredThisWeek: number;
  topDomains: Array<{ domain: string; count: number }>;
  avgTabsPerSession: number;
  oldestSession: string | null;
  pinnedTabCount: number;
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return url;
  }
}

function getWeekStart(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

const StatCard: React.FC<{
  label: string;
  value: string | number;
  icon: string;
  subtitle?: string;
}> = ({ label, value, icon, subtitle }) => (
  <div className="rounded-xl border border-gray-200/80 dark:border-gray-700/80 bg-white dark:bg-gray-800 p-4">
    <div className="flex items-start justify-between">
      <div>
        <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">{label}</p>
        <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-1">{value}</p>
        {subtitle && (
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{subtitle}</p>
        )}
      </div>
      <span className="text-2xl">{icon}</span>
    </div>
  </div>
);

export const StatsPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const groups = useAppSelector(state => state.tabs.groups);
  const [events, setEvents] = useState<Array<Record<string, unknown>>>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    storage.getProductEvents().then(evts => {
      setEvents(evts);
      setIsLoading(false);
    });
  }, []);

  const stats = useMemo((): StatsData => {
    const activeGroups = groups.filter(g => !g.isDeleted);
    const weekStart = getWeekStart();

    const allTabs = activeGroups.flatMap(g => g.tabs);
    const domains = new Map<string, number>();
    allTabs.forEach(t => {
      const d = extractDomain(t.url);
      domains.set(d, (domains.get(d) || 0) + 1);
    });

    const topDomains: Array<{ domain: string; count: number }> = Array.from(domains.entries())
      .map(([domain, count]) => ({ domain, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const savedThisWeek = events.filter(
      e => e.name === 'session_saved' && new Date(e.createdAt as string) >= weekStart
    ).length;

    const restoredThisWeek = events.filter(
      e =>
        (e.name === 'session_restored' || e.name === 'session_restored_again') &&
        new Date(e.createdAt as string) >= weekStart
    ).length;

    const sortedByDate = [...activeGroups].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    return {
      totalSessions: activeGroups.length,
      totalTabs: allTabs.length,
      totalDomains: domains.size,
      savedThisWeek,
      restoredThisWeek,
      topDomains,
      avgTabsPerSession: activeGroups.length > 0 ? Math.round(allTabs.length / activeGroups.length) : 0,
      oldestSession: sortedByDate.length > 0 ? sortedByDate[0].createdAt : null,
      pinnedTabCount: allTabs.filter(t => t.pinned).length,
    };
  }, [groups, events]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin h-8 w-8 border-2 border-primary-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="w-full px-3 sm:px-4 md:px-6 lg:px-8 py-4">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">使用统计</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            你的标签管理一览
          </p>
        </div>
        <button
          onClick={onClose}
          className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
        >
          返回
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="会话总数" value={stats.totalSessions} icon="📁" />
        <StatCard label="标签总数" value={stats.totalTabs} icon="🔖" />
        <StatCard label="唯一域名" value={stats.totalDomains} icon="🌐" />
        <StatCard
          label="平均标签/会话"
          value={stats.avgTabsPerSession}
          icon="📊"
          subtitle={`${stats.pinnedTabCount} 个已固定`}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="rounded-xl border border-gray-200/80 dark:border-gray-700/80 bg-white dark:bg-gray-800 p-4">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
            本周活动
          </h3>
          <div className="flex gap-6">
            <div>
              <p className="text-3xl font-bold text-primary-600 dark:text-primary-400">
                {stats.savedThisWeek}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">保存次数</p>
            </div>
            <div>
              <p className="text-3xl font-bold text-accent-600 dark:text-accent-400">
                {stats.restoredThisWeek}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">恢复次数</p>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-gray-200/80 dark:border-gray-700/80 bg-white dark:bg-gray-800 p-4">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
            常访问域名
          </h3>
          {stats.topDomains.length === 0 ? (
            <p className="text-sm text-gray-400 dark:text-gray-500">暂无数据</p>
          ) : (
            <div className="space-y-2">
              {stats.topDomains.map(({ domain, count }) => (
                <div key={domain} className="flex items-center justify-between">
                  <span className="text-sm text-gray-700 dark:text-gray-300 truncate flex-1 mr-2">
                    {domain}
                  </span>
                  <span className="text-xs text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded-full">
                    {count}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {stats.oldestSession && (
        <div className="rounded-xl border border-gray-200/80 dark:border-gray-700/80 bg-white dark:bg-gray-800 p-4">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            最早保存的会话：
            <span className="text-gray-700 dark:text-gray-300 ml-1">
              {new Date(stats.oldestSession).toLocaleDateString('zh-CN', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </span>
          </p>
        </div>
      )}
    </div>
  );
};
