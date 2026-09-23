import { TabGroup, Tab, UserSettings } from '@/types/tab';

/**
 * S1 重构：纯决策函数（decideDownloadPrecheck / decideCloudTombstoneWrite /
 * hasRemoteChanges / getGroupsToSync / validateMergeResult）已搬迁至
 * @/core/syncDecision，此处 re-export 转发（行为零变化）。
 * 已废弃的 version+时间戳 LWW 合并（mergeTabGroups/mergeGroup/mergeTabs）保留在原地，
 * 仅供参考/回滚对比与既有单测，不再接回生产路径。
 */
export * from '@/core/syncDecision';

/**
 * 智能合并本地和云端标签组（version + 时间戳 LWW）
 *
 * @deprecated 生产同步已全部切到 OpStamp 全序决胜（`@/utils/opStampMerge` 的 mergeOpStamped，
 * 入口 syncEngine.downloadAndMerge 与 syncPreview）。本函数已无生产调用点，仅作参考/回滚对比。
 * ⚠️ 其语义（低 version 直接丢弃、墓碑靠 version 翻牌）与新机制不同，不要再接回生产路径；
 * 针对它的单测**不代表**当前同步语义的保障（真正钉死见 tests/opStampMerge.test.ts 与
 * tests/opStampGuard.pg.test.ts）。
 */
export const mergeTabGroups = (
  localGroups: TabGroup[],
  cloudGroups: TabGroup[],
  syncStrategy: UserSettings['syncStrategy'] = 'newest'
): TabGroup[] => {
  console.log('[SyncUtils] 开始合并标签组');
  console.log(`[SyncUtils] 本地: ${localGroups.length} 个, 云端: ${cloudGroups.length} 个`);
  console.log(`[SyncUtils] 策略: ${syncStrategy}`);

  // 创建一个映射，以标签组ID为键
  const mergedGroupsMap = new Map<string, TabGroup>();
  const currentTime = new Date().toISOString();

  // 第一步：处理本地标签组
  localGroups.forEach(localGroup => {
    // 过滤掉本地已删除的标签组（不参与同步）
    if (localGroup.isDeleted) {
      console.log(`[SyncUtils] 跳过本地已删除的标签组: ${localGroup.name} (ID: ${localGroup.id})`);
      return;
    }

    // 标记为本地独有
    const group: TabGroup = {
      ...localGroup,
      syncStatus: 'local-only' as const,
      lastSyncedAt: localGroup.lastSyncedAt || null,
      version: localGroup.version || 1,
      displayOrder: localGroup.displayOrder ?? getDefaultDisplayOrder(localGroup, localGroups)
    };
    mergedGroupsMap.set(localGroup.id, group);
  });

  // 第二步：处理云端标签组
  cloudGroups.forEach(cloudGroup => {
    // 检查云端标签组是否被删除
    if (cloudGroup.isDeleted) {
      const localGroup = mergedGroupsMap.get(cloudGroup.id);

      if (localGroup) {
        // 本地有，云端标记删除 → 检查版本决定是否删除
        if (shouldApplyCloudDeletion(localGroup, cloudGroup, syncStrategy)) {
          console.log(`[SyncUtils] 应用云端删除: ${localGroup.name} (ID: ${localGroup.id})`);
          mergedGroupsMap.delete(cloudGroup.id);
        } else {
          console.log(`[SyncUtils] 保留本地版本，忽略云端删除: ${localGroup.name}`);
        }
      }
      // 本地没有，云端删除 → 不需要处理
      return;
    }

    const localGroup = mergedGroupsMap.get(cloudGroup.id);

    if (!localGroup) {
      // 云端独有的标签组 → 直接添加
      console.log(`[SyncUtils] 添加云端独有标签组: ${cloudGroup.name} (ID: ${cloudGroup.id})`);
      const group: TabGroup = {
        ...cloudGroup,
        syncStatus: 'remote-only' as const,
        lastSyncedAt: currentTime,
        version: cloudGroup.version || 1,
        displayOrder: cloudGroup.displayOrder ?? getDefaultDisplayOrder(cloudGroup, cloudGroups)
      };
      mergedGroupsMap.set(cloudGroup.id, group);
    } else {
      // 本地和云端都有 → 需要智能合并
      console.log(`[SyncUtils] 合并标签组: ${localGroup.name} (ID: ${localGroup.id})`);
      const mergedGroup = mergeGroup(localGroup, cloudGroup, syncStrategy, currentTime);
      mergedGroupsMap.set(cloudGroup.id, mergedGroup);
    }
  });

  // 第三步：将映射转换回数组并排序
  const mergedArray = Array.from(mergedGroupsMap.values());

  // 使用智能排序：优先 displayOrder，回退到 createdAt
  const sortedGroups = sortGroups(mergedArray);

  console.log(`[SyncUtils] 合并完成，最终: ${sortedGroups.length} 个标签组`);

  return sortedGroups;
};

/**
 * 判断是否应用云端的删除操作
 */
function shouldApplyCloudDeletion(
  localGroup: TabGroup,
  cloudGroup: TabGroup,
  syncStrategy: UserSettings['syncStrategy']
): boolean {
  const localVersion = localGroup.version || 1;
  const cloudVersion = cloudGroup.version || 1;

  // 策略1: 如果云端版本更新，应用删除
  if (cloudVersion > localVersion) {
    return true;
  }

  // 策略2: 如果版本相同，比较更新时间
  if (cloudVersion === localVersion) {
    const localTime = new Date(localGroup.updatedAt).getTime();
    const cloudTime = new Date(cloudGroup.updatedAt).getTime();

    if (syncStrategy === 'remote') {
      return true; // 远程优先
    } else if (syncStrategy === 'local') {
      return false; // 本地优先
    } else {
      return cloudTime > localTime; // 最新优先
    }
  }

  // 默认：本地版本更新，不删除
  return false;
}

/**
 * 合并两个标签组（字段级合并）
 */
const mergeGroup = (
  localGroup: TabGroup,
  cloudGroup: TabGroup,
  syncStrategy: UserSettings['syncStrategy'],
  currentTime: string
): TabGroup => {
  const localVersion = localGroup.version || 1;
  const cloudVersion = cloudGroup.version || 1;

  console.log(`[SyncUtils] 版本对比 - 本地: v${localVersion}, 云端: v${cloudVersion}`);

  // 检测冲突：版本号不连续
  const hasVersionConflict = Math.abs(localVersion - cloudVersion) > 1;

  if (hasVersionConflict) {
    console.warn(`[SyncUtils] 检测到版本冲突！本地: v${localVersion}, 云端: v${cloudVersion}`);
  }

  // 根据策略选择基础版本
  let baseGroup: TabGroup;

  switch (syncStrategy) {
    case 'remote':
      baseGroup = cloudGroup;
      console.log('[SyncUtils] 使用远程优先策略');
      break;
    case 'local':
      baseGroup = localGroup;
      console.log('[SyncUtils] 使用本地优先策略');
      break;
    case 'newest':
    default: {
      // 比较更新时间
      const localTime = new Date(localGroup.updatedAt).getTime();
      const cloudTime = new Date(cloudGroup.updatedAt).getTime();

      if (cloudTime > localTime) {
        baseGroup = cloudGroup;
        console.log('[SyncUtils] 云端更新，使用云端版本');
      } else {
        baseGroup = localGroup;
        console.log('[SyncUtils] 本地更新，使用本地版本');
      }
      break;
    }
  }

  // 字段级合并
  const mergedGroup: TabGroup = {
    id: baseGroup.id,

    // 名称：使用较新的
    name: selectNewerField(
      localGroup.name,
      cloudGroup.name,
      localGroup.updatedAt,
      cloudGroup.updatedAt,
      syncStrategy === 'local' ? 'local' : syncStrategy === 'remote' ? 'remote' : 'newest'
    ),

    // 本地会话元数据默认保留在本地
    notes: localGroup.notes ?? cloudGroup.notes,
    isFavorite: localGroup.isFavorite ?? cloudGroup.isFavorite,

    // 锁定状态：逻辑 OR（任一锁定即锁定）
    isLocked: localGroup.isLocked || cloudGroup.isLocked,

    // 标签：智能合并
    tabs: mergeTabs(localGroup, cloudGroup),

    // 时间戳
    createdAt: baseGroup.createdAt,
    updatedAt: currentTime,

    // 版本号：取最大值 + 1
    version: Math.max(localVersion, cloudVersion) + 1,

    // 显示顺序：优先使用有值的
    displayOrder: localGroup.displayOrder ?? cloudGroup.displayOrder,

    // 同步状态
    syncStatus: hasVersionConflict ? 'conflict' : 'synced',
    lastSyncedAt: currentTime,

    // 其他字段
    user_id: baseGroup.user_id,
    device_id: baseGroup.device_id,
    isDeleted: false
  };

  return mergedGroup;
};

/**
 * 选择较新的字段值
 */
function selectNewerField<T>(
  localValue: T,
  cloudValue: T,
  localTime: string,
  cloudTime: string,
  strategy: 'local' | 'remote' | 'newest'
): T {
  if (strategy === 'local') return localValue;
  if (strategy === 'remote') return cloudValue;

  const localTimestamp = new Date(localTime).getTime();
  const cloudTimestamp = new Date(cloudTime).getTime();

  return cloudTimestamp > localTimestamp ? cloudValue : localValue;
}

/**
 * 合并两个标签组的标签（智能去重 + 墓碑传播）
 *
 * 删除意图优先于状态并集：任一侧标记 isDeleted 的 tab，在另一侧即使
 * 仍是活跃状态也必须剔除。否则「A 删标签 → 上传 → B 轮询下载合并」会把
 * 活跃副本当作 local-only 并回来，再经 B 上传传回 A（跨设备复活）。
 * 墓碑本体保留在结果中，继续向尚未应用删除的第三方设备传播。
 */
const mergeTabs = (
  localGroup: TabGroup,
  cloudGroup: TabGroup
): Tab[] => {
  const currentTime = new Date().toISOString();

  // 第一步：收集两侧全部墓碑 ID + URL。仅精确 ID 匹配不够——
  // 跨设备同 URL 不同 nanoid 的复活场景需要 URL 维度墓碑匹配兜底。
  // 同侧"墓碑 + 同 URL 活跃重加"会被本地那侧主动放过（下方处理）。
  const tombstonedIds = new Set<string>();
  const tombstonedUrls = new Set<string>();
  for (const t of localGroup.tabs) {
    if (t.isDeleted) {
      tombstonedIds.add(t.id);
      if (t.url) tombstonedUrls.add(t.url);
    }
  }
  for (const t of cloudGroup.tabs) {
    if (t.isDeleted) {
      tombstonedIds.add(t.id);
      if (t.url) tombstonedUrls.add(t.url);
    }
  }

  // 使用 Map 去重：优先使用 ID，其次使用 URL
  const tabsById = new Map<string, Tab>();
  const tabsByUrl = new Map<string, string>(); // URL -> Tab ID 映射
  const tombstonesById = new Map<string, Tab>();

  // 先处理云端标签
  cloudGroup.tabs.forEach(cloudTab => {
    if (cloudTab.isDeleted) {
      // 保留墓碑：传播删除意图给尚未应用的设备
      tombstonesById.set(cloudTab.id, {
        ...cloudTab,
        syncStatus: 'synced',
        lastSyncedAt: currentTime
      });
      return;
    }

    if (tombstonedIds.has(cloudTab.id)) {
      return; // 另一侧已删除，剔除活跃副本
    }

    // ponytail: 跨设备同 URL 不同 ID 复活场景的修复。
    // 仅靠 ID 匹配墓碑，跨设备 nanoid 不同就会让 tombstone 失效——
    // A 设备删除 X (nanoid_A) → 云端墓碑 → B 设备从未收到 X 但有 nanoid_B
    // 同 URL tab → B 设备 ID 不匹配 tombstone → 不会被剔除 → 复活。
    // URL 匹配墓碑表后，对侧活跃副本按 URL 一起清理。
    // 边界场景：用户在 B 设备主动重新添加该 URL → 跨设备 sync 后仍会被墓碑剔除。
    // 权衡：复活（错误保留）vs 误删（重新添加成本低）→ 取后者。
    if (cloudTab.url && tombstonedUrls.has(cloudTab.url)) {
      return; // URL 已被另一侧墓碑，剔除活跃副本
    }

    tabsById.set(cloudTab.id, {
      ...cloudTab,
      syncStatus: 'synced',
      lastSyncedAt: currentTime
    });

    if (cloudTab.url) {
      tabsByUrl.set(cloudTab.url, cloudTab.id);
    }
  });

  // 然后处理本地标签
  localGroup.tabs.forEach(localTab => {
    if (localTab.isDeleted) {
      // 本地墓碑：云端可能还没有（未上传），保留以维持删除意图
      if (!tombstonesById.has(localTab.id)) {
        tombstonesById.set(localTab.id, {
          ...localTab,
          syncStatus: 'synced',
          lastSyncedAt: currentTime
        });
      }
      return;
    }

    if (tombstonedIds.has(localTab.id)) {
      return; // 另一侧已删除，剔除活跃副本
    }

    // URL 传播墓碑（同 cloudTab 处理）
    if (localTab.url && tombstonedUrls.has(localTab.url)) {
      // 同侧同时有墓碑 + 活跃重加：保留活跃，不作为墓碑（误判保护）
      // 场景：本地删了 X → 墓碑 → 本地又手动加了同 URL 新 tab → 该新 tab 不该被自身墓碑干掉
      const hasLocalTombstoneForUrl = localGroup.tabs.some(
        t => t.isDeleted && t.url === localTab.url
      );
      if (!hasLocalTombstoneForUrl) return;
    }

    // 检查是否已存在（按 ID）
    if (tabsById.has(localTab.id)) {
      // 比较更新时间，保留较新的
      const existingTab = tabsById.get(localTab.id)!;
      const localTime = new Date(localTab.lastAccessed).getTime();
      const cloudTime = new Date(existingTab.lastAccessed).getTime();

      if (localTime > cloudTime) {
        tabsById.set(localTab.id, {
          ...localTab,
          syncStatus: 'synced',
          lastSyncedAt: currentTime
        });
      }
      return;
    }

    // 检查 URL 是否重复
    if (localTab.url && tabsByUrl.has(localTab.url)) {
      console.log(`[SyncUtils] 跳过重复URL: ${localTab.url}`);
      return;
    }

    // 添加新标签
    tabsById.set(localTab.id, {
      ...localTab,
      syncStatus: 'synced',
      lastSyncedAt: currentTime
    });

    if (localTab.url) {
      tabsByUrl.set(localTab.url, localTab.id);
    }
  });

  // 活跃标签在前，墓碑追加尾部（渲染层过滤墓碑，顺序不影响显示）
  const mergedTabs = [...Array.from(tabsById.values()), ...Array.from(tombstonesById.values())];
  console.log(`[SyncUtils] 标签合并：本地 ${localGroup.tabs.length}，云端 ${cloudGroup.tabs.length}，合并后 ${mergedTabs.length}（含墓碑 ${tombstonesById.size}）`);

  return mergedTabs;
};

/**
 * 获取默认显示顺序
 */
function getDefaultDisplayOrder(group: TabGroup, allGroups: TabGroup[]): number {
  // 使用创建时间作为默认顺序
  const sortedByTime = [...allGroups].sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  const index = sortedByTime.findIndex(g => g.id === group.id);
  return index >= 0 ? index : allGroups.length;
}

/**
 * 智能排序：优先使用 displayOrder，回退到 createdAt
 */
function sortGroups(groups: TabGroup[]): TabGroup[] {
  return groups.sort((a, b) => {
    // 优先使用 displayOrder
    const orderA = a.displayOrder;
    const orderB = b.displayOrder;

    if (orderA !== undefined && orderB !== undefined) {
      return orderA - orderB;
    }

    // 如果只有一个有 displayOrder，有的排在前面
    if (orderA !== undefined) return -1;
    if (orderB !== undefined) return 1;

    // 都没有 displayOrder，按创建时间倒序
    const dateA = new Date(a.createdAt).getTime();
    const dateB = new Date(b.createdAt).getTime();
    return dateB - dateA;
  });
}
