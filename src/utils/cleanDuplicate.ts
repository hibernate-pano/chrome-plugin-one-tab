import type { TabGroup } from '@/types/tab';

/** 单条被合并掉的 tab 的预览样本（用于"清理重复"弹窗展示） */
export interface CleanDuplicateSample {
  title: string;
  url: string;
  fromGroupName: string;
  lastAccessed: string;
}

/** 清理重复 + 空组的扫描结果。thunk 写入存储 + ExportImportMenu 预览弹窗共用同一份逻辑。 */
export interface CleanDuplicateResult {
  /** 清理后的组列表 —— 锁定组保留、空组移除、重复 tab 按 lastAccessed 取最新 */
  finalGroups: TabGroup[];
  /** 被合并掉的重复 tab 数量 */
  removedTabsCount: number;
  /** 因变成空组而被删除的组数量（仅未锁定组） */
  removedGroupsCount: number;
  /** 最多 8 条被合并掉的 tab 样本（按 lastAccessed 倒序）—— 弹窗预览用 */
  removedTabSamples: CleanDuplicateSample[];
}

/**
 * 纯函数：扫描 + 计算"清理重复"的最终状态，不写存储。
 * 与 cleanDuplicateTabs thunk 共用算法，保证预览和实际执行完全一致。
 */
export function previewCleanDuplicateTabs(groups: TabGroup[]): CleanDuplicateResult {
  // 1. 按 URL（或 loading://URL+title）分组
  const urlMap = new Map<string, { tab: { id: string; title: string; url: string; lastAccessed: string }; groupId: string; groupName: string }[]>();

  for (const group of groups) {
    for (const tab of group.tabs) {
      if (!tab.url) continue;
      const urlKey = tab.url.startsWith('loading://') ? `${tab.url}|${tab.title}` : tab.url;
      const arr = urlMap.get(urlKey);
      if (arr) {
        arr.push({ tab, groupId: group.id, groupName: group.name });
      } else {
        urlMap.set(urlKey, [{ tab, groupId: group.id, groupName: group.name }]);
      }
    }
  }

  // 2. 深拷贝 group，避免 mutate 入参
  const updatedGroups = groups.map(group => ({
    ...group,
    tabs: [...group.tabs],
  }));

  const removedSamples: CleanDuplicateSample[] = [];

  // 3. 同 URL 多 tab：保留 lastAccessed 最新的，其余标记为删除
  for (const arr of urlMap.values()) {
    if (arr.length <= 1) continue;
    arr.sort((a, b) => new Date(b.tab.lastAccessed).getTime() - new Date(a.tab.lastAccessed).getTime());
    for (let i = 1; i < arr.length; i++) {
      const { tab, groupId } = arr[i];
      const g = updatedGroups.find(x => x.id === groupId);
      if (!g) continue;
      g.tabs = g.tabs.filter(t => t.id !== tab.id);
      removedSamples.push({ title: tab.title || tab.url, url: tab.url, fromGroupName: arr[0].groupName, lastAccessed: tab.lastAccessed });
    }
  }

  // 4. 空组清理：未锁定且 tab 数为 0 的组移除
  let removedGroupsCount = 0;
  const finalGroups = updatedGroups.filter(g => {
    if (g.tabs.length === 0 && !g.isLocked) {
      removedGroupsCount++;
      return false;
    }
    return true;
  });

  // 5. 样本按 lastAccessed 倒序，取前 8
  removedSamples.sort((a, b) => new Date(b.lastAccessed).getTime() - new Date(a.lastAccessed).getTime());

  return {
    finalGroups,
    removedTabsCount: removedSamples.length,
    removedGroupsCount,
    removedTabSamples: removedSamples.slice(0, 8),
  };
}