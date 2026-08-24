import React, { useEffect, useState } from 'react';
import type { TabGroup } from '@/types/tab';
import { fetchGroups, signOut, getCurrentUser } from './webApi';

interface Props {
  onSignOut: () => void;
}

export const DashboardPage: React.FC<Props> = ({ onSignOut }) => {
  const [groups, setGroups] = useState<TabGroup[]>([]);
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const user = await getCurrentUser();
        if (user) setEmail(user.email);
        const data = await fetchGroups();
        if (active) setGroups(data);
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : '加载数据失败');
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const toggleGroup = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const totalTabs = groups.reduce((sum, g) => sum + (g.tabs?.length ?? 0), 0);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">TapStack</h1>
            <p className="text-xs text-gray-500">
              {groups.length} 个会话 · {totalTabs} 个标签页
            </p>
          </div>
          <div className="flex items-center gap-3">
            {email && <span className="text-sm text-gray-500">{email}</span>}
            <button
              onClick={async () => {
                await signOut();
                onSignOut();
              }}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 transition hover:bg-gray-100"
            >
              退出登录
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        {loading && <p className="text-center text-gray-500">加载中...</p>}

        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </div>
        )}

        {!loading && !error && groups.length === 0 && (
          <p className="text-center text-gray-500">
            暂无同步的会话数据。请先在 Chrome 扩展中登录并同步。
          </p>
        )}

        {!loading && groups.length > 0 && (
          <div className="space-y-4">
            {groups.map((group) => {
              const isOpen = expanded.has(group.id);
              const tabs = group.tabs ?? [];
              return (
                <div
                  key={group.id}
                  className="rounded-2xl border border-gray-200 bg-white shadow-sm"
                >
                  <button
                    onClick={() => toggleGroup(group.id)}
                    className="flex w-full items-center justify-between px-5 py-4 text-left"
                  >
                    <div>
                      <h2 className="font-medium text-gray-900">{group.name}</h2>
                      <p className="text-xs text-gray-500">{tabs.length} 个标签页</p>
                    </div>
                    <span className="text-gray-400">{isOpen ? '−' : '+'}</span>
                  </button>

                  {isOpen && (
                    <ul className="divide-y divide-gray-100 border-t border-gray-100">
                      {tabs.map((tab) => (
                        <li key={tab.id}>
                          <a
                            href={tab.url}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-3 px-5 py-3 transition hover:bg-gray-50"
                          >
                            {tab.favicon && (
                              <img
                                src={tab.favicon}
                                alt=""
                                className="h-4 w-4"
                                onError={(e) => {
                                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                                }}
                              />
                            )}
                            <span className="min-w-0 flex-1 truncate text-sm text-gray-700">
                              {tab.title || tab.url}
                            </span>
                            <span className="truncate text-xs text-gray-400">{tab.url}</span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
};
