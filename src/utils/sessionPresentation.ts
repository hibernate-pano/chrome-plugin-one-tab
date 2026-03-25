import { RecentRestoreEntry, SessionRestoreSource, TabGroup } from '@/types/tab';

export const getPinnedTabCount = (group: Pick<TabGroup, 'tabs'>) => {
  return group.tabs.filter(tab => tab.pinned).length;
};

export const RESTORE_SOURCE_LABELS: Record<SessionRestoreSource, string> = {
  list: '会话列表',
  search: '搜索结果',
  'recent-save': '最近保存',
  'recent-restore': '最近恢复',
};

export const buildSessionRestoreMessage = (group: Pick<TabGroup, 'name' | 'tabs' | 'isLocked'>) => {
  const parts = [`已在新窗口恢复会话“${group.name}”`, `${group.tabs.length} 个标签页`];
  const pinnedCount = getPinnedTabCount(group);

  if (pinnedCount > 0) {
    parts.push(`保留 ${pinnedCount} 个固定标签页`);
  }

  parts.push(group.isLocked ? '原会话已保留' : '原会话已从列表移除');

  return parts.join('，');
};

export const buildRecentRestoreEntry = (
  group: Pick<TabGroup, 'id' | 'name' | 'notes' | 'tabs' | 'isLocked'>,
  source: SessionRestoreSource
): RecentRestoreEntry => {
  return {
    sessionId: group.id,
    name: group.name,
    notes: group.notes,
    tabCount: group.tabs.length,
    pinnedCount: getPinnedTabCount(group),
    isLocked: group.isLocked,
    restoredAt: new Date().toISOString(),
    source,
    tabs: group.tabs.map(tab => ({
      url: tab.url,
      pinned: !!tab.pinned,
    })),
  };
};

export const getRestoreSourceLabel = (source: SessionRestoreSource) => {
  return RESTORE_SOURCE_LABELS[source];
};

export const getSessionResultSummary = (group: Pick<TabGroup, 'tabs' | 'createdAt'>, matchedCount: number) => {
  const savedAt = new Date(group.createdAt);
  const savedTime = Number.isNaN(savedAt.getTime()) ? '' : savedAt.toLocaleString('zh-CN');

  if (!savedTime) {
    return `匹配 ${matchedCount}/${group.tabs.length} 个标签`;
  }

  return `匹配 ${matchedCount}/${group.tabs.length} 个标签 · 保存于 ${savedTime}`;
};
