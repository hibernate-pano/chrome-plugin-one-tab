/**
 * S4 单写者收口：本文件不直接写 storage/supabase。所有写语义均为 sendMutation
 * 薄代理（语义与 @/core/mutationOps 对齐），唯一写者是 SW 侧 mutationHandlers
 *（journal→stamp→apply→setGroups→scheduleUpload），唯一同步入口是 syncEngine。
 * UI 侧乐观更新 / rejected 回滚保留；读路径（loadGroups 经
 * storage.getGroups 读真值）不在写收口范围内。
 *
 * 旧路径 → mutation op 代理清单：
 * saveGroup→saveGroup / deleteGroup→deleteGroup / deleteAllGroups→deleteAllGroups /
 * importGroups→importGroups / updateGroupNameAndSync→renameGroup /
 * toggleGroupLockAndSync→toggleGroupLock / moveGroupAndSync→moveGroup /
 * moveTabAndSync→moveTab / cleanDuplicateTabs→cleanDuplicates /
 * deleteTabAndSync→removeTab / persistGroupFields→updateGroupFields
 *
 * ── 2026-09-29 无墓碑重写 ──
 * 删除一律物理移除（删除前由 UI 确认）；跨设备广播由云端 is_deleted 行承担。
 * 回收站/恢复/彻底删除（restoreGroup/purgeGroup/loadDeletedGroups）随墓碑一并移除，
 * TabState.deletedGroups 字段废除。toActiveGroupsView 保留为读路径防御层：
 * 老版本设备（商店 1.21.4）仍会写入墓碑形状数据，剥掉后不进主状态。
 */
import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { TabState, TabGroup, OptimisticTabBackup } from '@/types/tab';
import { storage, invalidateGroupsCache } from '@/utils/storage';
import { sendMutation } from '@/shared/mutationProtocol';
import { backupKeyOf, dropLoadGuard, isStaleLoad, stripInFlightTabs, stripTombstonedTabs, toActiveGroupsView, takeLoadGuard } from './tabSliceHelpers';
import { trackProductEvent } from '@/utils/productEvents';
import { logError, logInfo } from '../../utils/log';


export const initialTabState: TabState = {
  groups: [],
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
  optimisticBackups: {},
  mutationEpoch: 0,
  pendingLoadGuards: {},
};


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

  // 防御层：剥掉组级/标签级墓碑与空组（老版本设备写入的残留形状，见文件头）
  const activeGroups = toActiveGroupsView(groups);

  // 确保标签组始终按创建时间倒序排列（最新创建的在前面）
  const sortedGroups = activeGroups.sort((a, b) => {
    const dateA = new Date(a.createdAt);
    const dateB = new Date(b.createdAt);
    return dateB.getTime() - dateA.getTime();
  });

  logInfo(`[LoadGroups] 加载 ${sortedGroups.length} 个活跃标签组（已过滤 ${groups.length - activeGroups.length} 个墓碑/空组）`);

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
 * handler 返回 removedGroupId 时（跨组移空源组被物理移除），dispatch(deleteGroup)
 * 同步语义队列（deleteGroup 幂等，广播队列由 SW 侧登记，这里只为 UI 收口）。
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
    // 在 Redux 中移动标签页 - 立即更新UI（同步 reducer，已含空源组自动移除）
    dispatch(moveTab({ sourceGroupId, sourceIndex, targetGroupId, targetIndex }));

    // 如果是在拖动过程中且不需要更新源，跳过存储操作
    if (!updateSourceInDrag) {
      return {
        sourceGroupId,
        sourceIndex,
        targetGroupId,
        targetIndex,
        removedGroupId: null,
      };
    }

    const res = await sendMutation<{
      sourceGroupId: string;
      sourceIndex: number;
      targetGroupId: string;
      targetIndex: number;
      removedGroupId: string | null;
    }>({
      op: 'moveTab',
      sourceGroupId,
      sourceIndex,
      targetGroupId,
      targetIndex,
    });
    if (!res.ok) throw new Error(res.error ?? '移动失败');

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
     * 移动标签页 - 优化版本（immer 不可变更新）。
     * 跨组移走后源组变空且未锁定 → 立即物理移除（与 SW applyMoveTab 同语义）。
     * 历史回归：空组删除曾移到早已删除的组件里异步做，一旦异步落空空组就
     * 永久卡在 UI——必须在 reducer 里同步熄掉。
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
        logError('无效的标签组数据:', {
          sourceGroup: sourceGroup?.id,
          targetGroup: targetGroup?.id,
          sourceTabsValid: Array.isArray(sourceGroup?.tabs),
          targetTabsValid: Array.isArray(targetGroup?.tabs)
        });
        return;
      }

      // 验证源索引有效
      if (sourceIndex < 0 || sourceIndex >= sourceGroup.tabs.length) {
        logError('无效的源标签索引:', { sourceIndex, tabsLength: sourceGroup.tabs.length });
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

        // 修正后的逻辑：无论方向，都使用 targetIndex（用户期望插入到目标位置）
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

        // 自动清理：跨组移走后源组变空且未锁定 → 立即物理移除（同步、确定）。
        if (newSourceTabs.length === 0 && !sourceGroup.isLocked) {
          state.groups = state.groups.filter(g => g.id !== sourceGroupId);
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
      .addCase(loadGroups.pending, (state, action) => {
        state.isLoading = true;
        state.error = null;
        // 快照发起时代际：mutation 在途期读到的旧快照在 fulfilled 时被忽略
        takeLoadGuard(state, action.meta.requestId);
      })
      .addCase(loadGroups.fulfilled, (state, action) => {
        const stale = isStaleLoad(
          state.pendingLoadGuards,
          action.meta.requestId,
          state.mutationEpoch
        );
        dropLoadGuard(state, action.meta.requestId);
        state.isLoading = false;
        // 在途旧回环（发起早于某次 deleteTab 乐观更新）直接丢弃，保留乐观态；
        // 与当前代际一致的新回环（含外部变更触发的）正常应用，不饿死。
        // 同代际但仍在途的回环（pending 之后、SW 落盘之前发起）：按在途备份过滤，
        // 防止旧 KV payload 复活正被删除的 tab。
        if (stale) return;
        state.groups = stripInFlightTabs(
          action.payload,
          Object.values(state.optimisticBackups ?? {})
        );
        state.lastLoadedAt = new Date().toISOString();
      })
      .addCase(loadGroups.rejected, (state, action) => {
        const stale = isStaleLoad(
          state.pendingLoadGuards,
          action.meta.requestId,
          state.mutationEpoch
        );
        dropLoadGuard(state, action.meta.requestId);
        state.isLoading = false;
        if (stale) return;
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
        state.groups = state.groups.filter(g => g.id !== action.payload);
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
        const current = state.groups[idx];
        const tabIndex = current.tabs.findIndex(t => t.id === tabId);
        // 待删 tab 本不存在：无操作，不建占位、不 bump epoch，避免幽灵备份/代际污染
        if (tabIndex === -1) return;
        // 代际前进一步：此后发起的 load 回环若带着旧代际会被忽略（根除复活闪现）
        state.mutationEpoch = (state.mutationEpoch ?? 0) + 1;
        // key 化备份：连点不同 tab 时各管各的槽位，不再互相覆盖（根除错位回滚）
        if (!state.optimisticBackups) state.optimisticBackups = {};
        const key = backupKeyOf(groupId, tabId);
        const removedTab = { ...current.tabs[tabIndex] };
        state.optimisticBackups[key] = {
          groupId,
          tabId,
          tab: removedTab,
          index: tabIndex,
          snapshot: { ...current, tabs: current.tabs.map(t => ({ ...t })) },
        };
        const tabs = current.tabs.filter(t => t.id !== tabId);
        if (tabs.length === 0) {
          // 与 fulfilled(group===null) 同语义：拿掉最后一个 tab 整组消失（未锁定组）
          if (!current.isLocked) {
            state.groups.splice(idx, 1);
            if (state.activeGroupId === groupId) state.activeGroupId = null;
          } else {
            state.groups[idx] = { ...current, tabs };
          }
        } else {
          state.groups[idx] = { ...current, tabs };
        }
      })
      .addCase(deleteTabAndSync.rejected, (state, action) => {
        // 只回滚对应项：其他在途删除的备份槽位原样保留，互不干扰
        const { groupId, tabId } = action.meta.arg;
        const key = backupKeyOf(groupId, tabId);
        const backup: OptimisticTabBackup | undefined = state.optimisticBackups?.[key];
        if (state.optimisticBackups) delete state.optimisticBackups[key];
        if (backup) {
          const idx = state.groups.findIndex(g => g.id === groupId);
          if (idx !== -1) {
            // 组仍在：仅把本项插回（原位，存在则跳过），其他 tab 原样不动
            const tabs = [...state.groups[idx].tabs];
            if (!tabs.some(t => t.id === tabId)) {
              tabs.splice(Math.max(0, Math.min(backup.index, tabs.length)), 0, backup.tab);
            }
            state.groups[idx] = { ...state.groups[idx], tabs };
          } else {
            // 组已不在（本项拿空了组，或他项 fulfilled 整组移除）：按快照恢复，
            // 但过滤掉已被他项成功删除的 tab（无在途备份且不在任何现态中），避免复活它们。
            const liveTabIds = new Set<string>([tabId]);
            for (const g of state.groups) for (const t of g.tabs) liveTabIds.add(t.id);
            const tabs = backup.snapshot.tabs.filter(
              t => t.id === tabId || liveTabIds.has(t.id)
            );
            // 兜底：tab 必然在恢复结果中（快照里没有它说明 pending 时它已不在）
            const restoredTabs = tabs.some(t => t.id === tabId)
              ? tabs
              : [...tabs.slice(0, Math.max(0, Math.min(backup.index, tabs.length))), backup.tab, ...tabs.slice(Math.max(0, Math.min(backup.index, tabs.length)))];
            state.groups.unshift({ ...backup.snapshot, tabs: restoredTabs });
          }
        }
        state.error = action.error.message || '更新会话失败';
      })
      .addCase(deleteTabAndSync.fulfilled, (state, action) => {
        // 即时 UI 反馈（旧行为：updateGroup.fulfilled 即时替换组）。没有这个 case，
        // UI 只能等 onChanged→loadGroups 的回环（约 0.7s~数秒），表现为"点击后标签不消失"。
        const groupId = action.meta.arg.groupId;
        const tabId = action.meta.arg.tabId;
        const { group } = action.payload;
        // 只清对应项：在途的其他备份继续保留，等待各自的 settled
        if (state.optimisticBackups) delete state.optimisticBackups[backupKeyOf(groupId, tabId)];
        if (group === null) {
          // 组内最后一个 tab 被移除 → 整组物理移除（与 SW applyRemoveTab 语义一致）
          state.groups = state.groups.filter(g => g.id !== groupId);
          if (state.activeGroupId === groupId) {
            state.activeGroupId = null;
          }
        } else {
          const idx = state.groups.findIndex(g => g.id === groupId);
          if (idx !== -1) {
            // 回填服务端真值后，重放同组仍在途的乐观删除：先到的 fulfilled
            // 可能带着后发起删除的 tab，直接覆盖会造成其短暂复活闪现。
            const pendingTabIds = new Set(
              Object.values(state.optimisticBackups ?? {})
                .filter(b => b.groupId === groupId)
                .map(b => b.tabId)
            );
            state.groups[idx] = pendingTabIds.size === 0
              ? group
              : { ...group, tabs: group.tabs.filter(t => !pendingTabIds.has(t.id)) };
          }
        }
      })
      .addCase(deleteAllGroups.pending, state => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(deleteAllGroups.fulfilled, (state) => {
        state.isLoading = false;
        state.groups = [];
        state.activeGroupId = null;
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
        // SW 返回的是 storage 全量。主状态不变量是"只含活跃视图"（loadGroups 同管线）。
        state.groups = toActiveGroupsView(action.payload.updatedGroups);
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

// 删除单个标签页：物理移除，删除意图随整组上传广播到云端与其他设备。
// 该 thunk 走 removeTab 语义命令（点开=移出、显式删除，同语义）。
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
  // 出口防御：handler 返回的是 storage 原始组，老版本残留墓碑不进 Redux（与 loadGroups 口径一致）
  return { group: group ? stripTombstonedTabs(group) : null };
});

export default tabSlice.reducer;
