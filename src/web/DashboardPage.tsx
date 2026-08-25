import React, { useEffect, useState } from 'react';
import type { TabGroup } from '@/types/tab';
import {
  fetchGroups, fetchDeletedGroups, signOut, getCurrentUser,
  exportJsonBackup, exportOneTab, renameGroup, deleteGroup, deleteTab,
  restoreGroup, purgeGroupPermanent,
} from './webApi';
import { ConfirmModal, PromptModal } from './Modal';

interface Props {
  onSignOut: () => void;
}

// 只加载可安全访问的 favicon：https 且非本机/内网地址，避免 Mixed Content 和无效富环报错
function isSafeFavicon(favicon: string): boolean {
  try {
    const url = new URL(favicon);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
    if (/^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

/** 会话卡片骨架，加载中展示 */
const GroupSkeleton: React.FC = () => (
  <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
    <div className="h-4 w-1/3 animate-pulse rounded bg-gray-100" />
    <div className="mt-3 space-y-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-3 w-full animate-pulse rounded bg-gray-50" />
      ))}
    </div>
  </div>
);

export const DashboardPage: React.FC<Props> = ({ onSignOut }) => {
  const [groups, setGroups] = useState<TabGroup[]>([]);
  const [deletedGroups, setDeletedGroups] = useState<TabGroup[]>([]);
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 已删除区折叠状态
  const [trashOpen, setTrashOpen] = useState(false);

  // 模态状态：rename / deleteTab / deleteGroup 各管一个，避免互相干扰
  const [renameTarget, setRenameTarget] = useState<TabGroup | null>(null);
  const [deleteTabTarget, setDeleteTabTarget] = useState<{ groupId: string; tabId: string } | null>(null);
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<TabGroup | null>(null);
  // 彻底删除（云端 DELETE）二次确认
  const [purgeTarget, setPurgeTarget] = useState<TabGroup | null>(null);

  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

  const fail = (err: unknown, fallback: string) => {
    setError(err instanceof Error ? err.message : fallback);
  };

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const user = await getCurrentUser();
        if (user) setEmail(user.email);
        const data = await fetchGroups();
        let deleted: TabGroup[] = [];
        try {
          deleted = await fetchDeletedGroups();
        } catch (deletedErr) {
          console.warn('加载已删除会话失败:', deletedErr);
        }
        if (active) {
          setGroups(data);
          setDeletedGroups(deleted);
          // 默认展开所有标签组，避免逐一点击；仍可手动折叠单个组
          setExpanded(new Set(data.map((g) => g.id)));
        }
      } catch (err) {
        if (active) fail(err, '加载数据失败');
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
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const download = (filename: string, content: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleExportJson = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const { filename, content } = await exportJsonBackup();
      download(filename, content, 'application/json');
    } catch (err) {
      fail(err, '导出 JSON 失败');
    } finally {
      setExporting(false);
    }
  };

  const handleExportOneTab = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const { filename, content } = await exportOneTab();
      download(filename, content, 'text/plain');
    } catch (err) {
      fail(err, '导出 OneTab 失败');
    } finally {
      setExporting(false);
    }
  };

  const handleDeleteTabConfirmed = async () => {
    if (!deleteTabTarget) return;
    const { groupId, tabId } = deleteTabTarget;
    setBusy(true);
    try {
      await deleteTab(groupId, tabId);
      setGroups((prev) => prev.map((g) =>
        g.id === groupId ? { ...g, tabs: g.tabs.filter((t) => t.id !== tabId) } : g
      ));
      setDeleteTabTarget(null);
    } catch (err) {
      fail(err, '删除标签失败');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteGroupConfirmed = async () => {
    if (!deleteGroupTarget) return;
    const groupId = deleteGroupTarget.id;
    setBusy(true);
    try {
      await deleteGroup(groupId);
      setGroups((prev) => prev.filter((g) => g.id !== groupId));
      // 误删保护：被删组进入已删除恢复区（墓碑已由云端软删建好）
      setDeletedGroups((prev) => {
        if (prev.some((g) => g.id === groupId)) return prev;
        return [deleteGroupTarget, ...prev];
      });
      setDeleteGroupTarget(null);
    } catch (err) {
      fail(err, '删除标签组失败');
    } finally {
      setBusy(false);
    }
  };

  const handleRenameConfirmed = async (name: string) => {
    if (!renameTarget) return;
    const groupId = renameTarget.id;
    setBusy(true);
    try {
      await renameGroup(groupId, name);
      setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, name } : g)));
      setRenameTarget(null);
    } catch (err) {
      fail(err, '重命名标签组失败');
    } finally {
      setBusy(false);
    }
  };

  const handleRestoreDeleted = async (group: TabGroup) => {
    setBusy(true);
    try {
      await restoreGroup(group.id);
      // 云端墓碑复位 → 从已删除区移除，回到主列表（扩展端下次同步会合并恢复）
      setDeletedGroups((prev) => prev.filter((g) => g.id !== group.id));
      setGroups((prev) => {
        if (prev.some((g) => g.id === group.id)) return prev;
        return [group, ...prev];
      });
    } catch (err) {
      fail(err, '恢复会话失败');
    } finally {
      setBusy(false);
    }
  };

  const handlePurgeConfirmed = async () => {
    if (!purgeTarget) return;
    const groupId = purgeTarget.id;
    setBusy(true);
    try {
      await purgeGroupPermanent(groupId);
      setDeletedGroups((prev) => prev.filter((g) => g.id !== groupId));
      setPurgeTarget(null);
    } catch (err) {
      fail(err, '彻底删除失败');
    } finally {
      setBusy(false);
    }
  };

  const totalTabs = groups.reduce((sum, g) => sum + (g.tabs?.length ?? 0), 0);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">TapStack</h1>
            <p className="text-xs text-gray-500">
              {groups.length} 个会话 · {totalTabs} 个标签页
              {deletedGroups.length > 0 && ` · ${deletedGroups.length} 个已删除`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {email && <span className="text-sm text-gray-500">{email}</span>}
            <button
              onClick={handleExportJson}
              disabled={exporting}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 transition hover:bg-gray-100 disabled:opacity-50"
            >
              {exporting ? '导出中…' : '导出 JSON'}
            </button>
            <button
              onClick={handleExportOneTab}
              disabled={exporting}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 transition hover:bg-gray-100 disabled:opacity-50"
            >
              {exporting ? '导出中…' : '导出 OneTab'}
            </button>
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
        {loading && (
          <div className="space-y-4" aria-hidden={false}>
            {[0, 1, 2].map((i) => <GroupSkeleton key={i} />)}
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="mb-4 flex items-start justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
          >
            <span>{error}</span>
            <button
              onClick={() => setError(null)}
              aria-label="关闭错误提示"
              className="shrink-0 rounded p-0.5 text-rose-400 transition hover:bg-rose-100 hover:text-rose-600"
            >
              ✕
            </button>
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
                  <div className="flex items-center justify-between px-5 py-4">
                    <button
                      onClick={() => toggleGroup(group.id)}
                      className="flex min-w-0 flex-1 items-center justify-between text-left"
                    >
                      <div className="min-w-0">
                        <h2 className="truncate font-medium text-gray-900">{group.name}</h2>
                        <p className="text-xs text-gray-500">{tabs.length} 个标签页</p>
                      </div>
                    </button>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setRenameTarget(group)}
                        disabled={busy}
                        className="rounded-md border border-gray-200 px-2.5 py-1 text-xs text-gray-600 transition hover:bg-gray-100 disabled:opacity-50"
                      >
                        重命名
                      </button>
                      <button
                        onClick={() => setDeleteGroupTarget(group)}
                        disabled={busy}
                        className="rounded-md border border-rose-200 px-2.5 py-1 text-xs text-rose-600 transition hover:bg-rose-50 disabled:opacity-50"
                      >
                        删除
                      </button>
                      <button
                        onClick={() => toggleGroup(group.id)}
                        className="text-gray-400"
                        aria-label={isOpen ? '折叠' : '展开'}
                      >
                        {isOpen ? '−' : '+'}
                      </button>
                    </div>
                  </div>

                  {isOpen && (
                    <ul className="divide-y divide-gray-100 border-t border-gray-100">
                      {tabs.map((tab) => (
                        <li key={tab.id}>
                          <div className="flex items-center gap-2 px-5 py-3 transition hover:bg-gray-50">
                            <a
                              href={tab.url}
                              target="_blank"
                              rel="noreferrer"
                              className="flex min-w-0 flex-1 items-center gap-3"
                            >
                              {tab.favicon && isSafeFavicon(tab.favicon) && (
                                <img
                                  src={tab.favicon}
                                  alt=""
                                  className="h-4 w-4 shrink-0"
                                  onError={(e) => {
                                    (e.currentTarget as HTMLImageElement).style.display = 'none';
                                  }}
                                />
                              )}
                              <span className="min-w-0 flex-1 truncate text-sm text-gray-700">
                                {tab.title || tab.url}
                              </span>
                              <span className="hidden truncate text-xs text-gray-400 sm:block">
                                {tab.url}
                              </span>
                            </a>
                            <button
                              onClick={() => setDeleteTabTarget({ groupId: group.id, tabId: tab.id })}
                              disabled={busy}
                              className="shrink-0 rounded-md border border-rose-200 px-2 py-1 text-xs text-rose-600 transition hover:bg-rose-50 disabled:opacity-50"
                              aria-label={`删除标签 ${tab.title || tab.url}`}
                            >
                              删除
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {!loading && deletedGroups.length > 0 && (
          <div className="mt-8">
            <button
              onClick={() => setTrashOpen((v) => !v)}
              className="flex w-full items-center justify-between rounded-xl border border-dashed border-gray-300 bg-white/60 px-4 py-3 text-sm text-gray-500 transition hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-900/40"
            >
              <span>已删除（{deletedGroups.length}）——可恢复</span>
              <span>{trashOpen ? '−' : '+'}</span>
            </button>

            {trashOpen && (
              <div className="mt-3 space-y-3">
                {deletedGroups.map((group) => (
                  <div
                    key={group.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-gray-200 bg-white px-5 py-3 opacity-75 shadow-sm"
                  >
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-medium text-gray-600">{group.name}</h3>
                      <p className="text-xs text-gray-400">{group.tabs.length} 个标签页</p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button
                        onClick={() => handleRestoreDeleted(group)}
                        disabled={busy}
                        className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-700 transition hover:bg-gray-100 disabled:opacity-50"
                      >
                        恢复
                      </button>
                      <button
                        onClick={() => setPurgeTarget(group)}
                        disabled={busy}
                        className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs text-rose-600 transition hover:bg-rose-50 disabled:opacity-50"
                      >
                        彻底删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      <ConfirmModal
        open={Boolean(purgeTarget)}
        title="彻底删除会话"
        message={`确定彻底删除「${purgeTarget?.name ?? ''}」吗？删除后数据将从云端移除，无法恢复。`}
        confirmLabel="彻底删除"
        danger
        busy={busy}
        onCancel={() => setPurgeTarget(null)}
        onConfirm={handlePurgeConfirmed}
      />

      <ConfirmModal
        open={Boolean(deleteTabTarget)}
        title="删除标签"
        message="确定删除该标签吗？此操作会同步更新云端数据。"
        confirmLabel="删除"
        danger
        busy={busy}
        onCancel={() => setDeleteTabTarget(null)}
        onConfirm={handleDeleteTabConfirmed}
      />

      <ConfirmModal
        open={Boolean(deleteGroupTarget)}
        title="删除标签组"
        message={`确定删除会话「${deleteGroupTarget?.name ?? ''}」吗？删除后会移入「已删除」，可随时恢复。`}
        confirmLabel="删除"
        danger
        busy={busy}
        onCancel={() => setDeleteGroupTarget(null)}
        onConfirm={handleDeleteGroupConfirmed}
      />

      <PromptModal
        open={Boolean(renameTarget)}
        title="重命名标签组"
        initialValue={renameTarget?.name ?? ''}
        busy={busy}
        onSubmit={handleRenameConfirmed}
        onCancel={() => setRenameTarget(null)}
      />
    </div>
  );
};