import { TabGroup } from '@/types/tab';

export const getSessionResultSummary = (group: Pick<TabGroup, 'tabs' | 'createdAt'>, matchedCount: number) => {
  const savedAt = new Date(group.createdAt);
  const savedTime = Number.isNaN(savedAt.getTime()) ? '' : savedAt.toLocaleString('zh-CN');

  if (!savedTime) {
    return `匹配 ${matchedCount}/${group.tabs.length} 个标签`;
  }

  return `匹配 ${matchedCount}/${group.tabs.length} 个标签 · 保存于 ${savedTime}`;
};
