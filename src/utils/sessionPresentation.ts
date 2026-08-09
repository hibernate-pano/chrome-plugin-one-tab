import { TabGroup } from '@/types/tab';

export const getPinnedTabCount = (group: Pick<TabGroup, 'tabs'>) => {
  return group.tabs.filter(tab => tab.pinned).length;
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

export const getSessionResultSummary = (group: Pick<TabGroup, 'tabs' | 'createdAt'>, matchedCount: number) => {
  const savedAt = new Date(group.createdAt);
  const savedTime = Number.isNaN(savedAt.getTime()) ? '' : savedAt.toLocaleString('zh-CN');

  if (!savedTime) {
    return `匹配 ${matchedCount}/${group.tabs.length} 个标签`;
  }

  return `匹配 ${matchedCount}/${group.tabs.length} 个标签 · 保存于 ${savedTime}`;
};

/**
 * 把 `lastSyncTime` 格式化为人类可读的相对时间（纯函数）。
 * 调用方负责拼接语义前缀（如 footer 的「已同步 · 」、SyncTab 的状态行）。
 * - 无时间 / 非法时间 → '尚未同步'
 * - <1 分钟 → '刚刚'；<1 小时 → 'N分钟前'；<24 小时 → 'N小时前'；否则 → 'N天前'
 */
export const formatLastSync = (timestamp: string | null): string => {
  if (!timestamp) return '尚未同步';
  const ts = new Date(timestamp).getTime();
  if (Number.isNaN(ts)) return '尚未同步';
  const now = new Date();
  const diffMs = now.getTime() - ts;
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return '刚刚';
  if (diffMins < 60) return `${diffMins}分钟前`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}小时前`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}天前`;
};
