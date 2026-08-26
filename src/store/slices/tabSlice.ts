import { createSlice, createAsyncThunk, createSelector } from '@reduxjs/toolkit';
import { TabState, TabGroup, Tab } from '@/types/tab';
import { storage } from '@/utils/storage';
import { nanoid } from '@reduxjs/toolkit';
import { shouldAutoDeleteAfterTabRemoval } from '@/utils/tabGroupUtils';
import { sanitizeTabUrl } from '@/utils/inputValidation';
import { updateGroupWithVersion, updateDisplayOrder } from '@/utils/versionHelper';
import { trackProductEvent } from '@/utils/productEvents';

// 为了解决"参数隐式具有"any"类型"的问题，添加明确的类型定义
// 注意：这些接口暂时保留，可能在未来的功能中使用

// 解决"速记属性...的范围内不存在任何值"的问题，显式声明actions


export const initialTabState: TabState = {
  groups: [],
  deletedGroups: [],
  activeGroupId: null,
  isLoading: false,
  error: null,
  searchQuery: '',
  syncStatus: 'idle',
  lastSyncTime: null,
  lastLoadedAt: null,
  lastSyncStatus: null,
  compressionStats: null,
  backgroundSync: false,
  syncProgress: 0,
  syncOperation: 'none',
};

/** 过滤组内标签级墓碑（storage 保留墓碑用于同步删除意图，Redux/UI 不感知） */
const stripTombstonedTabs = (group: TabGroup): TabGroup =>
  group.tabs.some(t => t.isDeleted) ? { ...group, tabs: group.tabs.filter(t => !t.isDeleted) } : group;

export const loadGroups = createAsyncThunk('tabs/loadGroups', async () => {
  const groups = await storage.getGroups();

  // 过滤掉已软删除的标签组，避免UI显示
  const activeGroups = groups.filter(g => !g.isDeleted);

  // 标签级墓碑只存在于 storage 用于跨设备传播删除意图，不进入 UI
  const groupsWithoutTombstonedTabs = activeGroups.map(stripTombstonedTabs);

  // 确保标签组始终按创建时间倒序排列（最新创建的在前面）
  const sortedGroups = groupsWithoutTombstonedTabs.sort((a, b) => {
    const dateA = new Date(a.createdAt);
    const dateB = new Date(b.createdAt);
    return dateB.getTime() - dateA.getTime();
  });

  console.log(`[LoadGroups] 加载 ${sortedGroups.length} 个活跃标签组（已过滤 ${groups.length - activeGroups.length} 个已删除）`);

  return sortedGroups;
});

export const saveGroup = createAsyncThunk(
  'tabs/saveGroup',
  async (group: TabGroup) => {
    // 保存到本地
    const groups = await storage.getGroups();
    const updatedGroups = [group, ...groups];
    // 确保按创建时间倒序排列（最新创建的在前面）
    const sortedGroups = updatedGroups.sort((a, b) => {
      const dateA = new Date(a.createdAt);
      const dateB = new Date(b.createdAt);
      return dateB.getTime() - dateA.getTime();
    });
    await storage.setGroups(sortedGroups);

    return group;
  }
);

export const updateGroup = createAsyncThunk(
  'tabs/updateGroup',
  async (group: TabGroup) => {
    const groups = await storage.getGroups();
    const now = new Date().toISOString();

    const updatedGroups = groups.map(g => {
      if (g.id !== group.id) return g;

      // tab 级墓碑保护：UI 各路径（TabGroup、SearchResultList、ReorderView 等）
      // 通过传入「过滤后的 tabs」来表达删除标签。diff 出 storage 有而传入没有的
      // tab，标记为墓碑追加回去——删除意图随下次上传传播到云端与其他设备。
      // 否则其他设备的后台轮询会把该标签当作 remote/local-only 合并回来（复活）。
      // 已是墓碑的原样保留（幂等，防止重复 version 膨胀）。
      const incomingIds = new Set(group.tabs.map(t => t.id));
      const tombstones = g.tabs
        .filter(prev => !incomingIds.has(prev.id))
        .map(prev =>
          prev.isDeleted ? prev : { ...prev, isDeleted: true, lastAccessed: now }
        );

      // 使用辅助函数增加版本号
      return updateGroupWithVersion(g, {
        ...group,
        tabs: [...group.tabs, ...tombstones],
      });
    });

    await storage.setGroups(updatedGroups);

    const updated = updatedGroups.find(g => g.id === group.id)!;
    // 出口过滤：墓碑不进 Redux（与 loadGroups 口径一致），UI 永远看不到墓碑
    return stripTombstonedTabs(updated);
  }
);

export const deleteGroup = createAsyncThunk(
  'tabs/deleteGroup',
  async (groupId: string) => {
    const groups = await storage.getGroups();

    // 使用软删除：标记为已删除而非直接移除
    // 这样可以在同步时正确处理删除操作
    const updatedGroups = groups.map(g => {
      if (g.id === groupId) {
        const currentVersion = g.version || 1;
        return {
          ...g,
          isDeleted: true,
          version: currentVersion + 1, // 增加版本号
          updatedAt: new Date().toISOString()
        };
      }
      return g;
    });

    await storage.setGroups(updatedGroups);

    console.log(`[DeleteGroup] 软删除标签组: ${groupId}, 新版本: ${(groups.find(g => g.id === groupId)?.version || 1) + 1}`);

    return groupId;
  }
);

export const deleteAllGroups = createAsyncThunk(
  'tabs/deleteAllGroups',
  async () => {
    const groups = await storage.getGroups();

    if (groups.length === 0) {
      return { count: 0 }; // 没有标签组可删除
    }

    // ponytail: 改为软删墓碑，与 deleteGroup 同语义——否则本地硬清空后
    // 上传路径 deletedIds 为空、云端行残留，下次下载合并以 remote-only 复活。
    // 仅对活跃组加墓碑；已软删的版本号不动（幂等）。
    const now = new Date().toISOString();
    const updatedGroups = groups.map(g => {
      if (g.isDeleted) return g;
      return {
        ...g,
        isDeleted: true,
        version: (g.version || 1) + 1,
        updatedAt: now,
      };
    });
    await storage.setGroups(updatedGroups);

    return { count: groups.length };
  }
);

/**
 * 恢复已软删的标签组（误删保护核心）：
 * 置回活跃 → 版本 +1 → 下次同步时以 is_deleted:false 覆写云端墓碑，跨端恢复。
 */
export const restoreGroup = createAsyncThunk(
  'tabs/restoreGroup',
  async (groupId: string) => {
    const groups = await storage.getGroups();
    const target = groups.find(g => g.id === groupId);
    if (!target) {
      throw new Error('未找到该标签组');
    }

    const restored = groups.map(g => {
      if (g.id === groupId) {
        const currentVersion = g.version || 1;
        return {
          ...g,
          isDeleted: false,
          version: currentVersion + 1, // 版本递增，同步时云端墓碑被复位
          updatedAt: new Date().toISOString()
        };
      }
      return g;
    });

    await storage.setGroups(restored);
    return { groupId, restoredGroup: restored.find(g => g.id === groupId)! };
  }
);

/**
 * 彻底删除已软删的标签组（仅移除本地墓碑；云端仍由软删路径保留墓碑，
 * 若需同步清除请后续在 Web 端执行彻底删除）。
 */
export const purgeGroup = createAsyncThunk(
  'tabs/purgeGroup',
  async (groupId: string) => {
    const groups = await storage.getGroups();
    const remaining = groups.filter(g => g.id !== groupId);
    await storage.setGroups(remaining);
    return groupId;
  }
);

/** 加载已软删的标签组（误删保护恢复视图的数据源） */
export const loadDeletedGroups = createAsyncThunk('tabs/loadDeletedGroups', async () => {
  const groups = await storage.getGroups();
  return groups.filter(g => g.isDeleted);
});

export const importGroups = createAsyncThunk(
  'tabs/importGroups',
  async (groups: TabGroup[]) => {
    // 为导入的标签组和标签页生成新的ID
    // 顺手 sanitize URL：拒绝危险协议（javascript:/data:/file:），整 tab 丢弃而非污染 storage
    const processedGroups = groups.map(group => ({
      ...group,
      id: nanoid(),
      tabs: group.tabs.reduce<Tab[]>((acc, tab) => {
        const url = sanitizeTabUrl(tab.url);
        if (!url) return acc;
        acc.push({ ...tab, url, id: nanoid() });
        return acc;
      }, []),
    }));

    // 合并现有标签组和导入的标签组，并按创建时间倒序排列
    const existingGroups = await storage.getGroups();
    const updatedGroups = [...processedGroups, ...existingGroups];
    // 按创建时间倒序排列，确保最新创建的标签组在前面
    const sortedGroups = updatedGroups.sort((a, b) => {
      const dateA = new Date(a.createdAt);
      const dateB = new Date(b.createdAt);
      return dateB.getTime() - dateA.getTime();
    });
    await storage.setGroups(sortedGroups);

    return processedGroups;
  }
);

// 更新标签组名称并同步到云端
export const updateGroupNameAndSync = createAsyncThunk(
  'tabs/updateGroupNameAndSync',
  async ({ groupId, name }: { groupId: string; name: string }, { dispatch }) => {
    // 在 Redux 中更新标签组名称
    dispatch(updateGroupName({ groupId, name }));

    // 在本地存储中更新标签组
    const groups = await storage.getGroups();
    const updatedGroups = groups.map(g => {
      if (g.id === groupId) {
        return updateGroupWithVersion(g, { name });
      }
      return g;
    });
    await storage.setGroups(updatedGroups);

    const renamedGroup = updatedGroups.find(group => group.id === groupId);
    if (renamedGroup) {
      await trackProductEvent('session_renamed', {
        sessionId: renamedGroup.id,
        sessionName: renamedGroup.name,
      });
    }

    console.log(`[UpdateGroupName] 更新标签组 ${groupId}, 新版本: ${(groups.find(g => g.id === groupId)?.version || 1) + 1}`);

    return { groupId, name };
  }
);

// 切换标签组锁定状态并同步到云端
export const toggleGroupLockAndSync = createAsyncThunk(
  'tabs/toggleGroupLockAndSync',
  async (groupId: string, { dispatch }) => {
    // 在 Redux 中切换标签组锁定状态
    dispatch(toggleGroupLock(groupId));

    // 在本地存储中更新标签组
    const groups = await storage.getGroups();
    const group = groups.find(g => g.id === groupId);

    if (group) {
      const updatedGroup = updateGroupWithVersion(group, {
        isLocked: !group.isLocked
      });

      const updatedGroups = groups.map(g => (g.id === groupId ? updatedGroup : g));
      await storage.setGroups(updatedGroups);

      console.log(`[ToggleLock] 切换锁定状态 ${groupId}, 新版本: ${updatedGroup.version}`);

      return { groupId, isLocked: updatedGroup.isLocked };
    }

    return { groupId, isLocked: false };
  }
);

/**
 * 移动标签组并同步到云端
 * 优化性能：
 * 1. 使用requestAnimationFrame延迟存储操作
 * 2. 使用节流函数减少云端同步频率
 * 3. 批量处理本地存储操作
 */
export const moveGroupAndSync = createAsyncThunk(
  'tabs/moveGroupAndSync',
  async (
    { dragIndex, hoverIndex }: { dragIndex: number; hoverIndex: number },
    { dispatch }
  ) => {
    try {
      // 在 Redux 中移动标签组 - 立即更新UI
      dispatch(moveGroup({ dragIndex, hoverIndex }));

      // 使用 requestAnimationFrame 在下一帧执行存储操作，优化性能
      // 这样可以确保UI更新优先，存储操作不会阻塞渲染
      requestAnimationFrame(async () => {
        try {
          // 在本地存储中更新标签组顺序
          const groups = await storage.getGroups();

          // 检查索引是否有效
          if (
            dragIndex < 0 ||
            dragIndex >= groups.length ||
            hoverIndex < 0 ||
            hoverIndex >= groups.length
          ) {
            console.error('无效的标签组索引:', {
              dragIndex,
              hoverIndex,
              groupsLength: groups.length,
            });
            return;
          }

          const dragGroup = groups[dragIndex];

          // 创建新的数组以避免直接修改原数组
          const newGroups = [...groups];
          // 删除拖拽的标签组
          newGroups.splice(dragIndex, 1);
          // 在新位置插入标签组
          newGroups.splice(hoverIndex, 0, dragGroup);

          // ⭐ 关键：更新所有标签组的 displayOrder 和 version
          const updatedGroups = updateDisplayOrder(newGroups);

          // 更新本地存储 - 批量操作
          await storage.setGroups(updatedGroups);

          console.log(`[MoveGroup] 已更新所有标签组的 displayOrder`);

        } catch (error) {
          console.error('存储标签组移动操作失败:', error);
        }
      });

      return { dragIndex, hoverIndex };
    } catch (error) {
      console.error('移动标签组操作失败:', error);
      throw error;
    }
  }
);

// 移动标签页并同步到云端
// 清理重复标签功能
export const cleanDuplicateTabs = createAsyncThunk(
  'tabs/cleanDuplicateTabs',
  async () => {
    // 保存原始数据，用于错误回滚
    let originalGroups: TabGroup[] = [];

    try {
      // 获取所有标签组并保存原始状态
      originalGroups = await storage.getGroups();
      const groups = [...originalGroups]; // 创建副本进行操作

      // 创建URL映射，记录每个URL对应的标签页
      const urlMap = new Map<string, { tab: any; groupId: string }[]>();

      // 扫描所有标签页，按URL分组
      groups.forEach(group => {
        group.tabs.forEach(tab => {
          // 跳过墓碑：墓碑代表已删除意图，不应再被当作重复候选
          if (tab.isDeleted) return;
          if (tab.url) {
            // 对于loading://开头的URL，需要特殊处理
            const urlKey = tab.url.startsWith('loading://') ? `${tab.url}|${tab.title}` : tab.url;

            if (!urlMap.has(urlKey)) {
              urlMap.set(urlKey, []);
            }
            urlMap.get(urlKey)?.push({ tab, groupId: group.id });
          }
        });
      });

      // 处理重复标签页
      let removedTabsCount = 0;
      const updatedGroups = groups.map(group => ({
        ...group,
        tabs: [...group.tabs] // 深拷贝 tabs 数组
      }));

      urlMap.forEach(tabsWithSameUrl => {
        if (tabsWithSameUrl.length > 1) {
          // 按lastAccessed时间排序，保留最新的标签页
          tabsWithSameUrl.sort(
            (a, b) =>
              new Date(b.tab.lastAccessed).getTime() - new Date(a.tab.lastAccessed).getTime()
          );

          // 保留第一个（最新的），其余标记墓碑而非物理删除——
          // 删除意图需随下次上传传播到云端与其他设备，否则会被复活。
          for (let i = 1; i < tabsWithSameUrl.length; i++) {
            const { groupId, tab } = tabsWithSameUrl[i];
            const groupIndex = updatedGroups.findIndex(g => g.id === groupId);

            if (groupIndex !== -1) {
              const stampNow = new Date().toISOString();
              updatedGroups[groupIndex].tabs = updatedGroups[groupIndex].tabs.map(t =>
                t.id === tab.id && !t.isDeleted
                  ? { ...t, isDeleted: true, lastAccessed: stampNow }
                  : t
              );
              removedTabsCount++;

              // 更新标签组的updatedAt时间和版本号
              const currentVersion = updatedGroups[groupIndex].version || 1;
              updatedGroups[groupIndex].updatedAt = stampNow;
              updatedGroups[groupIndex].version = currentVersion + 1;
            }
          }
        }
      });

      // 清理空标签组（在重复标签清理后进行）
      // ponytail: 墓碑化（与 deleteGroup 同语义）而非物理移除——
      // 否则 markCloudGroupsAsDeleted 拿不到 ID、云端行残留 → 下次下载复活成僵尸空组。
      // 只看活跃 tab 数（墓碑不算），与 shouldAutoDeleteAfterTabRemoval 口径一致。
      let removedGroupsCount = 0;
      const stampNow2 = new Date().toISOString();
      const finalGroups = updatedGroups.map(group => {
        const activeTabs = group.tabs.filter(t => !t.isDeleted);
        if (activeTabs.length === 0 && !group.isLocked) {
          removedGroupsCount++;
          return {
            ...group,
            isDeleted: true,
            version: (group.version || 1) + 1,
            updatedAt: stampNow2,
          };
        }
        return group;
      });

      // 原子性操作：先保存到本地存储
      try {
        await storage.setGroups(finalGroups);
      } catch (storageError) {
        console.error('保存到本地存储失败，操作回滚:', storageError);
        // 如果保存失败，不进行任何更改
        throw new Error('保存失败，操作已取消');
      }

      return {
        removedTabsCount,
        removedGroupsCount,
        updatedGroups: finalGroups
      };
    } catch (error) {
      console.error('清理重复标签和空标签组失败:', error);

      // 如果操作过程中出现错误，尝试恢复原始状态
      try {
        if (originalGroups.length > 0) {
          await storage.setGroups(originalGroups);
          console.log('已回滚到原始状态');
        }
      } catch (rollbackError) {
        console.error('回滚失败:', rollbackError);
      }

      throw error;
    }
  }
);

/**
 * 移动标签页并同步到云端
 * 优化性能：
 * 1. 使用requestAnimationFrame延迟存储操作
 * 2. 使用节流函数减少云端同步频率
 * 3. 批量处理本地存储操作
 * 4. 优化拖拽过程中的状态更新
 * 5. 自动清理拖拽后的空标签组
 */
export const moveTabAndSync = createAsyncThunk(
  'tabs/moveTabAndSync',
  async (
    {
      sourceGroupId,
      sourceIndex,
      targetGroupId,
      targetIndex,
      updateSourceInDrag = true,
    }: {
      sourceGroupId: string;
      sourceIndex: number;
      targetGroupId: string;
      targetIndex: number;
      updateSourceInDrag?: boolean;
    },
    { dispatch }
  ) => {
    try {
      // 在 Redux 中移动标签页 - 立即更新UI
      dispatch(moveTab({ sourceGroupId, sourceIndex, targetGroupId, targetIndex }));

      // 如果是在拖动过程中且不需要更新源，跳过存储操作
      // 这是一个优化，避免在拖拽过程中频繁更新存储
      if (!updateSourceInDrag) {
        return { sourceGroupId, sourceIndex, targetGroupId, targetIndex };
      }

      // 使用 requestAnimationFrame 在下一帧执行存储操作，优化性能
      // 这样可以确保UI更新优先，存储操作不会阻塞渲染
      requestAnimationFrame(async () => {
        try {
          // 在本地存储中更新标签页位置
          const groups = await storage.getGroups();
          const sourceGroup = groups.find(g => g.id === sourceGroupId);
          const targetGroup = groups.find(g => g.id === targetGroupId);

          if (sourceGroup && targetGroup) {
            // 获取要移动的标签页
            const tab = sourceGroup.tabs[sourceIndex];

            if (!tab) {
              console.error('找不到要移动的标签页:', { sourceGroupId, sourceIndex });
              return;
            }

            // 创建新的标签页数组以避免直接修改原数组
            const newSourceTabs = [...sourceGroup.tabs];
            const newTargetTabs =
              sourceGroupId === targetGroupId ? newSourceTabs : [...targetGroup.tabs];

            // 从源标签组中删除标签页
            newSourceTabs.splice(sourceIndex, 1);

            // 修复：计算调整后的目标索引
            // 对于同组内移动，无论拖动方向如何，都直接使用 targetIndex
            // 这与 Redux reducer 中的逻辑保持一致
            let adjustedIndex = targetIndex;

            // 确保索引在有效范围内
            adjustedIndex = Math.max(0, Math.min(adjustedIndex, newTargetTabs.length));

            // 插入标签到目标位置
            newTargetTabs.splice(adjustedIndex, 0, tab);

            // 更新源标签组和目标标签组 - 使用不可变更新
            const sourceVersion = sourceGroup.version || 1;
            const updatedSourceGroup = {
              ...sourceGroup,
              tabs: newSourceTabs,
              updatedAt: new Date().toISOString(),
              version: sourceVersion + 1,
            };

            let updatedTargetGroup = targetGroup;
            if (sourceGroupId !== targetGroupId) {
              const targetVersion = targetGroup.version || 1;
              updatedTargetGroup = {
                ...targetGroup,
                tabs: newTargetTabs,
                updatedAt: new Date().toISOString(),
                version: targetVersion + 1,
              };
            }

            // 批量更新本地存储 - 一次性更新所有变更
            let updatedGroups = groups
              .map(g => {
                if (g.id === sourceGroupId) return updatedSourceGroup;
                if (g.id === targetGroupId) return updatedTargetGroup;
                return g;
              });

            // 自动清理空标签组（仅在跨组移动时检查源标签组）
            if (sourceGroupId !== targetGroupId && updatedSourceGroup && updatedSourceGroup.tabs.length === 0) {
              try {
                // 使用工具函数检查是否应该被自动删除（考虑锁定状态等）
                if (shouldAutoDeleteAfterTabRemoval(updatedSourceGroup, '')) {
                  console.log(`[拖拽自动清理] 检测到空标签组: ${updatedSourceGroup.name} (ID: ${sourceGroupId})`);

                  // ponytail: 用软删墓碑（isDeleted:true）而非从存储中物理移除。
                  // 物理移除会让 upload() 的 deletedIds 不包含本组、云端行
                  // is_deleted=false 残留，下载合并时以 remote-only 把最后一枚
                  // tab 复活回原组（“最后一个标签删不掉，刷新就回来”）。
                  // 墓碑保证远端 markCloudGroupsAsDeleted(deletedIds) 播到云端，
                  // 下次合并按 shouldApplyCloudDeletion 应用删除，不再复活。
                  const nowDeletedAt = new Date().toISOString();
                  updatedGroups = updatedGroups.map(g => {
                    if (g.id !== sourceGroupId) return g;
                    // 已墓碑过则不动（幂等），否则标记删除
                    if (g.isDeleted) return g;
                    return {
                      ...g,
                      isDeleted: true,
                      version: (g.version || 1) + 1,
                      updatedAt: nowDeletedAt,
                    };
                  });

                  // 延迟删除Redux状态中的标签组（收益：进误删保护恢复视图），
                  // 避免与UI组件的删除逻辑冲突
                  setTimeout(() => {
                    try {
                      dispatch(deleteGroup(sourceGroupId));
                    } catch (deleteError) {
                      console.error(`[拖拽自动清理] 删除Redux状态失败:`, deleteError);
                    }
                  }, 100);

                  console.log(`[拖拽自动清理] 已墓碑化空标签组: ${updatedSourceGroup.name} (ID: ${sourceGroupId})`);
                } else {
                  console.log(`[拖拽自动清理] 跳过不符合删除条件的空标签组: ${updatedSourceGroup.name} (ID: ${sourceGroupId})`);
                }
              } catch (cleanupError) {
                console.error(`[拖拽自动清理] 清理空标签组时发生错误:`, cleanupError);
                // 清理失败时不影响主要的存储操作
              }
            }

            await storage.setGroups(updatedGroups);

          }
        } catch (error) {
          console.error('存储标签页移动操作失败:', error);
        }
      });

      return { sourceGroupId, sourceIndex, targetGroupId, targetIndex };
    } catch (error) {
      console.error('移动标签页操作失败:', error);
      throw error;
    }
  }
);

export const tabSlice = createSlice({
  name: 'tabs',
  initialState: initialTabState,
  reducers: {
    setActiveGroup: (state, action) => {
      state.activeGroupId = action.payload;
    },
    updateGroupName: (state, action) => {
      const { groupId, name } = action.payload;
      const group = state.groups.find(g => g.id === groupId);
      if (group) {
        group.name = name;
        group.version = (group.version || 1) + 1; // 添加版本号
        group.updatedAt = new Date().toISOString();
      }
    },
    toggleGroupLock: (state, action) => {
      const group = state.groups.find(g => g.id === action.payload);
      if (group) {
        group.isLocked = !group.isLocked;
        group.version = (group.version || 1) + 1; // 添加版本号
        group.updatedAt = new Date().toISOString();
      }
    },
    setSearchQuery: (state, action) => {
      state.searchQuery = action.payload;
    },
    // 新增：设置同步状态
    setSyncStatus: (state, action) => {
      state.syncStatus = action.payload;
    },
    moveGroup: (state, action) => {
      const { dragIndex, hoverIndex } = action.payload;
      const dragGroup = state.groups[dragIndex];
      // 创建新的数组以避免直接修改原数组
      const newGroups = [...state.groups];
      // 删除拖拽的标签组
      newGroups.splice(dragIndex, 1);
      // 在新位置插入标签组
      newGroups.splice(hoverIndex, 0, dragGroup);
      // 更新状态
      state.groups = newGroups;
    },
    /**
     * 移动标签页 - 优化版本
     * 性能优化：
     * 1. 减少不必要的数组复制
     * 2. 使用immer的不可变更新模式
     * 3. 优化条件判断逻辑
     */
    moveTab: (state, action) => {
      const { sourceGroupId, sourceIndex, targetGroupId, targetIndex } = action.payload;

      // 找到源标签组和目标标签组
      const sourceGroup = state.groups.find(g => g.id === sourceGroupId);
      const targetGroup = state.groups.find(g => g.id === targetGroupId);

      // 验证源组和目标组存在，以及它们的 tabs 数组
      if (!sourceGroup || !targetGroup ||
        !sourceGroup.tabs || !Array.isArray(sourceGroup.tabs) ||
        !targetGroup.tabs || !Array.isArray(targetGroup.tabs)) {
        console.error('无效的标签组数据:', {
          sourceGroup: sourceGroup?.id,
          targetGroup: targetGroup?.id,
          sourceTabsValid: Array.isArray(sourceGroup?.tabs),
          targetTabsValid: Array.isArray(targetGroup?.tabs)
        });
        return;
      }

      // 验证源索引有效
      if (sourceIndex < 0 || sourceIndex >= sourceGroup.tabs.length) {
        console.error('无效的源标签索引:', { sourceIndex, tabsLength: sourceGroup.tabs.length });
        return;
      }

      // 获取要移动的标签页（创建深拷贝避免引用问题）
      const tab = { ...sourceGroup.tabs[sourceIndex] };

      // 更新时间戳
      const now = new Date().toISOString();

      // 处理同一组内移动
      if (sourceGroupId === targetGroupId) {
        // 创建新的标签数组，避免直接修改原数组
        const newTabs = [...sourceGroup.tabs];

        // 先移除源标签
        newTabs.splice(sourceIndex, 1);

        // 修复：计算调整后的目标索引
        // 无论拖动方向如何，都直接使用 targetIndex 作为插入位置
        // 这样可以确保标签页准确移动到用户指示的目标位置
        //
        // 原来的逻辑问题：
        // - 从上向下拖动时，targetIndex - 1 会导致插入位置偏前一位
        // - 从下向上拖动时，直接使用 targetIndex 是正确的
        //
        // 修正后的逻辑：
        // - 无论方向，都使用 targetIndex，因为用户期望插入到目标位置
        const adjustedIndex = Math.max(0, Math.min(targetIndex, newTabs.length));

        // 插入到目标位置
        newTabs.splice(adjustedIndex, 0, tab);

        // 更新标签组 - 使用不可变更新
        const updatedSourceGroup = {
          ...sourceGroup,
          tabs: newTabs,
          updatedAt: now,
        };

        // 更新state中的标签组
        state.groups = state.groups.map(g => (g.id === sourceGroupId ? updatedSourceGroup : g));
      }
      // 处理跨组移动
      else {
        // 从源组移除标签 - 创建新的标签数组
        const newSourceTabs = sourceGroup.tabs.filter((_, i) => i !== sourceIndex);

        // 更新源标签组 - 使用不可变更新
        const updatedSourceGroup = {
          ...sourceGroup,
          tabs: newSourceTabs,
          updatedAt: now,
        };

        // 准备目标组的新标签数组
        const newTargetTabs = [...targetGroup.tabs];

        // 检查目标组中是否已经有这个标签（避免重复）
        const existingIndex = newTargetTabs.findIndex(t => t.id === tab.id);
        if (existingIndex !== -1) {
          newTargetTabs.splice(existingIndex, 1);
        }

        // 确保目标索引在有效范围内
        const safeTargetIndex = Math.max(0, Math.min(targetIndex, newTargetTabs.length));

        // 插入到目标位置
        newTargetTabs.splice(safeTargetIndex, 0, tab);

        // 更新目标标签组 - 使用不可变更新
        const updatedTargetGroup = {
          ...targetGroup,
          tabs: newTargetTabs,
          updatedAt: now,
        };

        // 更新state中的标签组
        state.groups = state.groups
          .map(g => {
            if (g.id === sourceGroupId) return updatedSourceGroup;
            if (g.id === targetGroupId) return updatedTargetGroup;
            return g;
          });

        // 自动清理：跨组移走后源组变空且未锁定 → 立即墓碑化（同步、确定）。
        // 历史回归：旧改把空组删除逻辑移到 SortableTabGroup/isMarkedForDeletion
        // 组件，但该组件早已移除，只剩 moveTabAndSync 里 100ms 的异步 deleteGroup
        // dispatch——一旦该异步落空（时序/异常），空组就永久卡在 UI。这里在
        // reducer 里同步熄掉，与 deleteGroup 的 Redux 效果一致（撤销区可恢复）。
        if (sourceGroupId !== targetGroupId && shouldAutoDeleteAfterTabRemoval(updatedSourceGroup, '')) {
          state.groups = state.groups.filter(g => g.id !== sourceGroupId);
          state.deletedGroups = state.deletedGroups.filter(g => g.id !== sourceGroupId);
          state.deletedGroups.push({
            ...updatedSourceGroup,
            isDeleted: true,
            version: (updatedSourceGroup.version || 1) + 1,
            updatedAt: now,
          });
          if (state.activeGroupId === sourceGroupId) {
            state.activeGroupId = null;
          }
        }
      }
    },

    // 更新同步进度
    updateSyncProgress: (state, action) => {
      const { progress, operation } = action.payload;
      state.syncProgress = progress;
      state.syncOperation = operation;
    },
    // 设置标签组数据（用于性能测试等场景）
    setGroups: (state, action) => {
      state.groups = action.payload;
    },
  },
  extraReducers: builder => {
    builder
      .addCase(loadGroups.pending, state => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(loadGroups.fulfilled, (state, action) => {
        state.isLoading = false;
        state.groups = action.payload;
        state.lastLoadedAt = new Date().toISOString();
      })
      .addCase(loadGroups.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || '加载标签组失败';
      })
      .addCase(saveGroup.fulfilled, (state, action) => {
        // 添加新标签组并按创建时间倒序排列
        state.groups.unshift(action.payload);
        state.groups.sort((a, b) => {
          const dateA = new Date(a.createdAt);
          const dateB = new Date(b.createdAt);
          return dateB.getTime() - dateA.getTime();
        });
      })
      .addCase(updateGroup.fulfilled, (state, action) => {
        const index = state.groups.findIndex(g => g.id === action.payload.id);
        if (index !== -1) {
          state.groups[index] = action.payload;
        }
      })
      .addCase(deleteGroup.fulfilled, (state, action) => {
        const removed = state.groups.find(g => g.id === action.payload);
        state.groups = state.groups.filter(g => g.id !== action.payload);
        if (removed) {
          // 误删保护：被删组进入恢复视图（墓碑）
          state.deletedGroups = state.deletedGroups.filter(g => g.id !== action.payload);
          state.deletedGroups.push({
            ...removed,
            isDeleted: true,
            version: (removed.version || 1) + 1,
            updatedAt: new Date().toISOString()
          });
        }
        if (state.activeGroupId === action.payload) {
          state.activeGroupId = null;
        }
      })
      .addCase(loadDeletedGroups.fulfilled, (state, action) => {
        state.deletedGroups = action.payload;
      })
      .addCase(restoreGroup.fulfilled, (state, action) => {
        state.deletedGroups = state.deletedGroups.filter(g => g.id !== action.payload.groupId);
        // 恢复的组立即回到主列表（后续 loadGroups 会做最终排序）
        state.groups = state.groups.filter(g => g.id !== action.payload.groupId);
        state.groups.unshift(action.payload.restoredGroup);
        state.groups.sort((a, b) => {
          const dateA = new Date(a.createdAt);
          const dateB = new Date(b.createdAt);
          return dateB.getTime() - dateA.getTime();
        });
      })
      .addCase(purgeGroup.fulfilled, (state, action) => {
        state.deletedGroups = state.deletedGroups.filter(g => g.id !== action.payload);
      })
      .addCase(deleteAllGroups.pending, state => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(deleteAllGroups.fulfilled, (state) => {
        state.isLoading = false;
        const removed = state.groups;
        state.groups = [];
        state.activeGroupId = null;
        // 把所有刚删的组加入墓碑列表（与 deleteGroup 同语义，误删保护可恢复）
        const now = new Date().toISOString();
        const removedIds = new Set(removed.map(g => g.id));
        state.deletedGroups = [
          ...state.deletedGroups.filter(g => !removedIds.has(g.id)),
          ...removed.map(g => ({
            ...g,
            isDeleted: true,
            version: (g.version || 1) + 1,
            updatedAt: now,
          })),
        ];
      })
      .addCase(deleteAllGroups.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || '删除所有标签组失败';
      })

      // 更新标签组名称并同步到云端
      .addCase(updateGroupNameAndSync.pending, () => {
        // 不更新UI状态，因为已经在 reducer 中更新了
      })
      .addCase(updateGroupNameAndSync.fulfilled, () => {
        // 不更新UI状态，因为已经在 reducer 中更新了
      })
      .addCase(updateGroupNameAndSync.rejected, () => {
        // 不更新UI状态，因为已经在 reducer 中更新了
      })

      // 切换标签组锁定状态并同步到云端
      .addCase(toggleGroupLockAndSync.pending, () => {
        // 不更新UI状态，因为已经在 reducer 中更新了
      })
      .addCase(toggleGroupLockAndSync.fulfilled, () => {
        // 不更新UI状态，因为已经在 reducer 中更新了
      })
      .addCase(toggleGroupLockAndSync.rejected, () => {
        // 不更新UI状态，因为已经在 reducer 中更新了
      })

      // 移动标签组并同步到云端
      .addCase(moveGroupAndSync.pending, () => {
        // 不更新UI状态，因为已经在 reducer 中更新了
      })
      .addCase(moveGroupAndSync.fulfilled, () => {
        // 不更新UI状态，因为已经在 reducer 中更新了
      })
      .addCase(moveGroupAndSync.rejected, () => {
        // 不更新UI状态，因为已经在 reducer 中更新了
      })

      // 移动标签页并同步到云端
      .addCase(moveTabAndSync.pending, () => {
        // 不更新UI状态，因为已经在 reducer 中更新了
      })
      .addCase(moveTabAndSync.fulfilled, () => {
        // 不更新UI状态，因为已经在 reducer 中更新了
      })
      .addCase(moveTabAndSync.rejected, () => {
        // 不更新UI状态，因为已经在 reducer 中更新了
      })

      // 清理重复标签和空标签组
      .addCase(cleanDuplicateTabs.pending, state => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(cleanDuplicateTabs.fulfilled, (state, action) => {
        state.isLoading = false;
        state.groups = action.payload.updatedGroups;
      })
      .addCase(cleanDuplicateTabs.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || '清理重复标签和空标签组失败';
      });
  },
});

// 将 actions 单独导出，避免循环依赖
export const {
  setActiveGroup,
  updateGroupName,
  toggleGroupLock,
  setSearchQuery,
  moveGroup,
  moveTab,
  setGroups,
} = tabSlice.actions;

// 删除单个标签页（墓碑化）：标记 isDeleted 而非物理移除，
// 删除意图随上传传播到云端与其他设备；墓碑由各出口过滤不出现在 UI。
// 注意：当前主要删除路径是 UI 组件直接 updateGroup(filter)，
// 由 updateGroup thunk 的 diff 统一墓碑化；本 thunk 保留为显式删除入口。
export const deleteTabAndSync = createAsyncThunk<
  { group: TabGroup | null },
  { groupId: string; tabId: string },
  { state: any }
>('tabs/deleteTabAndSync', async ({ groupId, tabId }: { groupId: string; tabId: string }) => {
  try {
    // 在本地存储中处理标签
    const groups = await storage.getGroups();
    const groupIndex = groups.findIndex(g => g.id === groupId);

    if (groupIndex !== -1) {
      const currentGroup = groups[groupIndex];

      // 使用工具函数检查删除标签页后是否应该自动删除标签组
      if (shouldAutoDeleteAfterTabRemoval(currentGroup, tabId)) {
        // 自动删除空的未锁定标签组：必须与 deleteGroup 相同的软删墓碑形态
        // （isDeleted + version+1），否则上传时 deletedIds 缺失该组、云端行残留，
        // 下次下载合并会以 remote-only 身份整体复活成僵尸空组。
        const now2 = new Date().toISOString();
        const updatedGroups = groups.map(g =>
          g.id === groupId
            ? { ...g, isDeleted: true, version: (g.version || 1) + 1, updatedAt: now2 }
            : g
        );
        await storage.setGroups(updatedGroups);

        console.log(`自动软删除空标签组: ${currentGroup.name} (ID: ${groupId})`);
        return { group: null };
      }

      const now = new Date().toISOString();
      const updatedTabs = currentGroup.tabs.map(tab =>
        tab.id === tabId && !tab.isDeleted
          ? { ...tab, isDeleted: true, lastAccessed: now }
          : tab
      );
      const updatedGroup = {
        ...currentGroup,
        tabs: updatedTabs,
        updatedAt: now,
        version: (currentGroup.version || 1) + 1,
      };

      // 更新本地存储
      const updatedGroups = [...groups];
      updatedGroups[groupIndex] = updatedGroup;
      await storage.setGroups(updatedGroups);

      console.log(`从标签组删除标签页(墓碑): ${currentGroup.name}, 活跃标签页: ${updatedTabs.filter(t => !t.isDeleted).length}`);
      return { group: stripTombstonedTabs(updatedGroup) };
    }

    return { group: null };
  } catch (error) {
    console.error('删除标签页操作失败:', error);
    throw error;
  }
});

// 使用createSelector创建记忆化选择器，避免不必要的重新计算
export const selectFilteredGroups = createSelector(
  [
    (state: { tabs: TabState }) => state.tabs.groups,
    (state: { tabs: TabState }) => state.tabs.searchQuery,
  ],
  (groups, searchQuery) => {
    if (!searchQuery) return groups;

    const query = searchQuery.toLowerCase();
    return groups.filter(group => {
      // 先检查组名，这是一个快速检查
      if (group.name.toLowerCase().includes(query)) return true;
      if (group.notes?.toLowerCase().includes(query)) return true;

      // 然后检查标签，这可能更耗时
      return group.tabs.some(
        tab => tab.title.toLowerCase().includes(query) || tab.url.toLowerCase().includes(query)
      );
    });
  }
);

export default tabSlice.reducer;
