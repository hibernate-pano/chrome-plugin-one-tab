import type { TabGroup } from '@/types/tab';
import { mergeOpStamped } from '@/core/opStampMerge';

export interface SyncPreviewSummary {
  additions: number;
  updates: number;
  deletions: number;
  unchanged: number;
  beforeCount: number;
  afterCount: number;
  addedNames: string[];
  updatedNames: string[];
  deletedNames: string[];
}

type SyncPreviewMode = 'overwrite' | 'merge';

const MAX_NAME_PREVIEW = 3;

const toActiveGroups = (groups: TabGroup[]) => groups.filter(group => !group.isDeleted);

const getComparableFingerprint = (group: TabGroup) =>
  JSON.stringify({
    name: group.name,
    notes: group.notes || '',
    isFavorite: !!group.isFavorite,
    isLocked: !!group.isLocked,
    updatedAt: group.updatedAt,
    version: group.version || 0,
    displayOrder: group.displayOrder ?? null,
    tabs: group.tabs.map(tab => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      pinned: !!tab.pinned,
      lastAccessed: tab.lastAccessed,
      createdAt: tab.createdAt,
    })),
  });

const applySourceUpsertToTarget = (targetGroups: TabGroup[], sourceGroups: TabGroup[]) => {
  const nextGroups = new Map(targetGroups.map(group => [group.id, group]));

  sourceGroups.forEach(group => {
    nextGroups.set(group.id, group);
  });

  return Array.from(nextGroups.values());
};

const buildPreviewFromBeforeAndAfter = (
  beforeGroups: TabGroup[],
  afterGroups: TabGroup[]
): SyncPreviewSummary => {
  const beforeMap = new Map(beforeGroups.map(group => [group.id, group]));
  const afterMap = new Map(afterGroups.map(group => [group.id, group]));

  let additions = 0;
  let updates = 0;
  let deletions = 0;
  let unchanged = 0;
  const addedNames: string[] = [];
  const updatedNames: string[] = [];
  const deletedNames: string[] = [];

  afterGroups.forEach(group => {
    const previousGroup = beforeMap.get(group.id);

    if (!previousGroup) {
      additions += 1;
      if (addedNames.length < MAX_NAME_PREVIEW) {
        addedNames.push(group.name);
      }
      return;
    }

    if (getComparableFingerprint(previousGroup) !== getComparableFingerprint(group)) {
      updates += 1;
      if (updatedNames.length < MAX_NAME_PREVIEW) {
        updatedNames.push(group.name);
      }
      return;
    }

    unchanged += 1;
  });

  beforeGroups.forEach(group => {
    if (!afterMap.has(group.id)) {
      deletions += 1;
      if (deletedNames.length < MAX_NAME_PREVIEW) {
        deletedNames.push(group.name);
      }
    }
  });

  return {
    additions,
    updates,
    deletions,
    unchanged,
    beforeCount: beforeGroups.length,
    afterCount: afterGroups.length,
    addedNames,
    updatedNames,
    deletedNames,
  };
};

export const buildUploadPreviewSummary = (
  localGroups: TabGroup[],
  remoteGroups: TabGroup[],
  mode: SyncPreviewMode
) => {
  const activeLocalGroups = toActiveGroups(localGroups);
  const activeRemoteGroups = toActiveGroups(remoteGroups);
  const afterGroups =
    mode === 'overwrite'
      ? activeLocalGroups
      : applySourceUpsertToTarget(activeRemoteGroups, activeLocalGroups);

  return buildPreviewFromBeforeAndAfter(activeRemoteGroups, afterGroups);
};

export const buildDownloadPreviewSummary = (
  localGroups: TabGroup[],
  remoteGroups: TabGroup[],
  mode: SyncPreviewMode
) => {
  const activeLocalGroups = toActiveGroups(localGroups);
  const activeRemoteGroups = toActiveGroups(remoteGroups);
  // 必须用与实际下载相同的合并函数与相同入参（含墓碑行/墓碑组的完整列表），
  // 否则预览会预告一个与实际结果相反的胜负：预先 toActiveGroups 过滤会把云端
  // 墓碑行滤掉 → 预览说「组还在」，实际删除广播却把它删了。合并结果再按活跃态展示。
  const afterGroups =
    mode === 'overwrite'
      ? activeRemoteGroups
      : toActiveGroups(mergeOpStamped(localGroups, remoteGroups));

  return buildPreviewFromBeforeAndAfter(activeLocalGroups, afterGroups);
};
