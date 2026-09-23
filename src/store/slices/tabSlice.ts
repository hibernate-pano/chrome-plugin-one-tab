/**
 * S4 单写者收口：本文件不直接写 storage/supabase。所有写语义均为 sendMutation
 * 薄代理（语义与 @/core/mutationOps 对齐），唯一写者是 SW 侧 mutationHandlers
 *（journal→stamp→apply→setGroups→scheduleUpload），唯一同步入口是 syncEngine。
 * UI 侧乐观更新 / rejected 回滚保留；读路径（loadGroups/loadDeletedGroups 经
 * storage.getGroups 读真值）不在写收口范围内。
 *
 * 旧路径 → mutation op 代理清单：
 * saveGroup→saveGroup / deleteGroup→deleteGroup / deleteAllGroups→deleteAllGroups /
 * restoreGroup→restoreGroup / purgeGroup→purgeGroup / importGroups→importGroups /
 * updateGroupNameAndSync→renameGroup / toggleGroupLockAndSync→toggleGroupLock /
 * moveGroupAndSync→moveGroup / moveTabAndSync→moveTab / cleanDuplicateTabs→cleanDuplicates /
 * deleteTabAndSync→removeTab / persistGroupFields→updateGroupFields
 */
import { createSlice, createAsyncThunk, createSelector } from '@reduxjs/toolkit';
import { TabState, TabGroup } from '@/types/tab';
import { storage, invalidateGroupsCache } from '@/utils/storage';
import { shouldAutoDeleteAfterTabRemoval } from '@/utils/tabGroupUtils';
import { sendMutation } from '@/shared/mutationProtocol';
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

/**
 * 本地 UI 偏好持久化（isFavorite/notes）：走 updateGroupFields 语义命令，
 * 经 mutationQueue 串行由 SW 单写者执行，符合阶段一单写者不变量。
 * 不 bump version/updatedAt——这些字段不在云端 sync 范围内。
 * Redux 端由 updateGroupFields 同步 reducer 立即乐观更新，存储端由此 thunk
 * 经 MUTATE 消息交 SW 落盘，避免 popup/SW 并发直写 storage 的 R1 race。
 */
export const persistGroupFields = createAsyncThunk<
  { groupId: string; fields: { isFavorite?: boolean; notes?: string } },
  { groupId: string; fields: { isFavorite?: boolean; notes?: string } }
>('tabs/persistGroupFields', async ({ groupId, fields }) => {
  const res = await sendMutation<{ groupId: string; updated: TabGroup | null; fields: { isFavorite?: boolean; notes?: string } }>({
    op: 'updateGroupFields',
    groupId,
    fields,
  });
  if (!res.ok) throw new Error(res.error ?? '本地偏好保存失败');
  return { groupId, fields };
});

export const loadGroups = createAsyncThunk('tabs/loadGroups', async () => {
  // 显式加载必须读存储真值：SW 侧同步合并只写 IndexedDB，不会触发
  // chrome.storage.onChanged 来失效本进程 30s 缓存，否则同步后列表读不到新会话。
  invalidateGroupsCache();
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
    const res = await sendMutation<TabGroup>({ op: 'saveGroup', group });
    if (!res.ok) throw new Error(res.error ?? '保存失败');
    return res.payload!;
  }
);

export const deleteGroup = createAsyncThunk(
  'tabs/deleteGroup',
  async (groupId: string) => {
    const res = await sendMutation<string>({ op: 'deleteGroup', groupId });
    if (!res.ok) throw new Error(res.error ?? '删除失败');
    return res.payload!;
  }
);

export const deleteAllGroups = createAsyncThunk(
  'tabs/deleteAllGroups',
  async () => {
    const res = await sendMutation<{ count: number }>({ op: 'deleteAllGroups' });
    if (!res.ok) throw new Error(res.error ?? '删除失败');
    return res.payload!;
  }
);

/**
 * 恢复已软删的标签组（误删保护核心）：
 * 置回活跃 → 版本 +1 → 下次同步时以 is_deleted:false 覆写云端墓碑，跨端恢复。
 */
export const restoreGroup = createAsyncThunk(
  'tabs/restoreGroup',
  async (groupId: string) => {
    const res = await sendMutation<{ groupId: string; restoredGroup: TabGroup }>({
      op: 'restoreGroup',
      groupId,
    });
    if (!res.ok) throw new Error(res.error ?? '恢复失败');
    return res.payload!;
  }
);

/**
 * 彻底删除已软删的标签组（仅移除本地墓碑；云端仍由软删路径保留墓碑，
 * 若需同步清除请后续在 Web 端执行彻底删除）。
 */
export const purgeGroup = createAsyncThunk(
  'tabs/purgeGroup',
  async (groupId: string) => {
    const res = await sendMutation<string>({ op: 'purgeGroup', groupId });
    if (!res.ok) throw new Error(res.error ?? '清除失败');
    return res.payload!;
  }
);

/** 加载已软删的标签组（误删保护恢复视图的数据源） */
export const loadDeletedGroups = createAsyncThunk('tabs/loadDeletedGroups', async () => {
  invalidateGroupsCache(); // 与 loadGroups 同源同缓存，同样要求读存储真值
  const groups = await storage.getGroups();
  return groups.filter(g => g.isDeleted);
});

export const importGroups = createAsyncThunk(
  'tabs/importGroups',
  async (groups: TabGroup[]) => {
    const res = await sendMutation<TabGroup[]>({ op: 'importGroups', groups });
    if (!res.ok) throw new Error(res.error ?? '导入失败');
    return res.payload!;
  }
);

// 更新标签组名称并同步到云端
export const updateGroupNameAndSync = createAsyncThunk(
  'tabs/updateGroupNameAndSync',
  async ({ groupId, name }: { groupId: string; name: string }, { dispatch, getState }) => {
    // 在 Redux 中更新标签组名称（乐观更新）
    dispatch(updateGroupName({ groupId, name }));

    const res = await sendMutation<{ groupId: string; name: string }>({
      op: 'renameGroup',
      groupId,
      name,
    });
    if (!res.ok) throw new Error(res.error ?? '重命名失败');

    const state = getState() as { tabs: TabState };
    const renamedGroup = state.tabs.groups.find(group => group.id === groupId);
    if (renamedGroup) {
      void trackProductEvent('session_renamed', {
        sessionId: renamedGroup.id,
        sessionName: renamedGroup.name,
      });
    }

    return res.payload!;
  }
);

// 切换标签组锁定状态并同步到云端
export const toggleGroupLockAndSync = createAsyncThunk(
  'tabs/toggleGroupLockAndSync',
  async (groupId: string, { dispatch }) => {
    // 在 Redux 中切换标签组锁定状态（乐观更新）
    dispatch(toggleGroupLock(groupId));

    const res = await sendMutation<{ groupId: string; isLocked: boolean }>({
      op: 'toggleGroupLock',
      groupId,
    });
    if (!res.ok) throw new Error(res.error ?? '切换锁定失败');

    return res.payload!;
  }
);

/**
 * 移动标签组并同步到云端
 * Redux 乐观更新由 moveGroup 同步 reducer 承担；存储写由 mutationQueue 异步完成。
 */
export const moveGroupAndSync = createAsyncThunk(
  'tabs/moveGroupAndSync',
  async (
    { dragIndex, hoverIndex }: { dragIndex: number; hoverIndex: number },
    { dispatch }
  ) => {
    // 在 Redux 中移动标签组 - 立即更新UI
    dispatch(moveGroup({ dragIndex, hoverIndex }));

    const res = await sendMutation<{ dragIndex: number; hoverIndex: number }>({
      op: 'moveGroup',
      dragIndex,
      hoverIndex,
    });
    if (!res.ok) throw new Error(res.error ?? '移动失败');

    return res.payload!;
  }
);

// 移动标签页并同步到云端
// 清理重复标签功能
export const cleanDuplicateTabs = createAsyncThunk(
  'tabs/cleanDuplicateTabs',
  async () => {
    const res = await sendMutation<{
      removedTabsCount: number;
      removedGroupsCount: number;
      updatedGroups: TabGroup[];
    }>({ op: 'cleanDuplicates' });
    if (!res.ok) throw new Error(res.error ?? '清理失败');
    return res.payload!;
  }
);

/**
 * 移动标签页并同步到云端
 * Redux 乐观更新由 moveTab 同步 reducer 承担；存储写由 mutationQueue 异步完成。
 * handler 返回 autoDeletedGroupId 时（跨组移空源组），立即 dispatch(deleteGroup)
 * 让误删保护恢复视图能查到该组（deleteGroup 也走语义命令，幂等）。
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
    // 在 Redux 中移动标签页 - 立即更新UI（同步 reducer，已含空源组自动墓碑）
    dispatch(moveTab({ sourceGroupId, sourceIndex, targetGroupId, targetIndex }));

    // 如果是在拖动过程中且不需要更新源，跳过存储操作
    if (!updateSourceInDrag) {
      return {
        sourceGroupId,
        sourceIndex,
        targetGroupId,
        targetIndex,
        autoDeletedGroupId: null,
      };
    }

    const res = await sendMutation<{
      sourceGroupId: string;
      sourceIndex: number;
      targetGroupId: string;
      targetIndex: number;
      autoDeletedGroupId: string | null;
    }>({
      op: 'moveTab',
      sourceGroupId,
      sourceIndex,
      targetGroupId,
      targetIndex,
    });
    if (!res.ok) throw new Error(res.error ?? '移动失败');

    if (res.payload!.autoDeletedGroupId) {
      // 让误删保护恢复视图拿到该组；deleteGroup 自身走 removeTab 语义，幂等
      dispatch(deleteGroup(res.payload!.autoDeletedGroupId));
    }

    return res.payload!;
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
    /**
     * 本地字段更新（isFavorite/notes 等不在云端同步范围内的字段）：
     * 仅乐观更新 Redux 状态；持久化由 persistGroupFields thunk 走 updateGroupFields
     * 语义命令完成（统一单写者管线）。【不】bump version/updatedAt——这些字段
     * 不进入云端 sync 载荷，bump 会污染远端版本号与合并决策。
     */
    updateGroupFields: (state, action) => {
      const { groupId, fields } = action.payload as {
        groupId: string;
        fields: { isFavorite?: boolean; notes?: string };
      };
      const group = state.groups.find(g => g.id === groupId);
      if (group) {
        Object.assign(group, fields);
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
      .addCase(deleteTabAndSync.pending, (state, action) => {
        // 乐观更新：点击即从列表消失，不等 SW mutation + 云端回环（此前只在
        // fulfilled 更新，SW 冷启动时延迟可达数百毫秒，体感就是"点了没反应"）。
        // 服务端真值以 fulfilled 回填为准；失败走 rejected 回滚。
        const { groupId, tabId } = action.meta.arg;
        const idx = state.groups.findIndex(g => g.id === groupId);
        if (idx === -1) return;
        state.optimisticBackup = { groupId, group: state.groups[idx] };
        const tabs = state.groups[idx].tabs.filter(t => t.id !== tabId);
        if (tabs.length === 0) {
          // 与 fulfilled(group===null) 同语义：拿掉最后一个活跃 tab 后整组进误删保护视图
          const [removed] = state.groups.splice(idx, 1);
          state.deletedGroups = state.deletedGroups.filter(g => g.id !== groupId);
          state.deletedGroups.push({
            ...removed,
            tabs,
            isDeleted: true,
            version: (removed.version || 1) + 1,
            updatedAt: new Date().toISOString(),
          });
          if (state.activeGroupId === groupId) state.activeGroupId = null;
        } else {
          state.groups[idx] = { ...state.groups[idx], tabs };
        }
      })
      .addCase(deleteTabAndSync.rejected, (state, action) => {
        // 回滚乐观更新；下次 loadGroups 再与真值对齐
        const backup = state.optimisticBackup;
        if (backup) {
          state.deletedGroups = state.deletedGroups.filter(g => g.id !== backup.groupId);
          const idx = state.groups.findIndex(g => g.id === backup.groupId);
          if (idx !== -1) state.groups[idx] = backup.group;
          else state.groups.unshift(backup.group);
          state.optimisticBackup = null;
        }
        state.error = action.error.message || '更新会话失败';
      })
      .addCase(deleteTabAndSync.fulfilled, (state, action) => {
        // 即时 UI 反馈（旧行为：updateGroup.fulfilled 即时替换组）。没有这个 case，
        // UI 只能等 onChanged→loadGroups 的回环（约 0.7s~数秒），表现为"点击后标签不消失"。
        const groupId = action.meta.arg.groupId;
        const { group } = action.payload;
        state.optimisticBackup = null;
        if (group === null) {
          // 组内最后一个活跃 tab 被移除 → 整组软删：镜像 deleteGroup.fulfilled（误删保护视图同语义）
          const removed = state.groups.find(g => g.id === groupId);
          state.groups = state.groups.filter(g => g.id !== groupId);
          if (removed) {
            state.deletedGroups = state.deletedGroups.filter(g => g.id !== groupId);
            state.deletedGroups.push({
              ...removed,
              isDeleted: true,
              version: (removed.version || 1) + 1,
              updatedAt: new Date().toISOString(),
            });
          }
          if (state.activeGroupId === groupId) {
            state.activeGroupId = null;
          }
        } else {
          const idx = state.groups.findIndex(g => g.id === groupId);
          if (idx !== -1) state.groups[idx] = group;
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
  updateGroupFields,
  setSearchQuery,
  moveGroup,
  moveTab,
  setGroups,
} = tabSlice.actions;

// 删除单个标签页（墓碑化）：标记 isDeleted 而非物理移除，
// 删除意图随上传传播到云端与其他设备；墓碑由各出口过滤不出现在 UI。
// 该 thunk 现在走 removeTab 语义命令，替代旧的 updateGroup(filter) diff 通道（根因 R3）。
export const deleteTabAndSync = createAsyncThunk<
  { group: TabGroup | null },
  { groupId: string; tabId: string },
  { state: any }
>('tabs/deleteTabAndSync', async ({ groupId, tabId }: { groupId: string; tabId: string }) => {
  const res = await sendMutation<{ group: TabGroup | null }>({
    op: 'removeTab',
    groupId,
    tabId,
  });
  if (!res.ok) throw new Error(res.error ?? '删除失败');
  const { group } = res.payload!;
  // 出口过滤：handler 返回的是 storage 原始组（含墓碑），墓碑不进 Redux（与 loadGroups 口径一致）
  return { group: group ? stripTombstonedTabs(group) : null };
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
