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
 * toggleGroupLockAndSync→toggleGroupLock / moveTabAndSync→moveTab / cleanDuplicateTabs→cleanDuplicates /
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
import { applyCleanPlanToActiveView, backupKeyOf, dropLoadGuard, GroupLocalFields, GroupMetaSnapshot, isStaleLoad, planOptimisticClean, restoreGroupLocalFields, restoreGroupLock, restoreGroupName, snapshotGroupLocalFields, snapshotGroupMeta, stripInFlightDeletions, stripTombstonedTabs, toActiveGroupsView, takeLoadGuard } from './tabSliceHelpers';
import type { CleanDuplicatesPlan } from '@/core/mutationOps';
import type { OpStamp } from '@/core/opStamp';
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
  cleanDuplicatesSnapshot: null,
  deletedGroupBackups: {},
};

/** 当前在途（已乐观移除、尚未落定）的组级删除 id。见 stripInFlightDeletions 的说明。 */
const inFlightDeletedGroupIds = (state: TabState): string[] =>
  Object.keys(state.deletedGroupBackups ?? {});


/**
 * 本地 UI 偏好持久化（isFavorite/notes）：走 updateGroupFields 语义命令，
 * 经 mutationQueue 串行由 SW 单写者执行，符合阶段一单写者不变量。
 * 不 bump version/updatedAt——这些字段不在云端 sync 范围内。
 * Redux 端由 updateGroupFields 同步 reducer 立即乐观更新，存储端由此 thunk
 * 经 MUTATE 消息交 SW 落盘，避免 popup/SW 并发直写 storage 的 R1 race。
 */
/**
 * P1-5：失败必须把乐观值收回去。快照在乐观更新之前抓，失败时随 rejectValue 带回来，
 * rejected reducer 还原（见 tabSliceHelpers 的回滚说明）。
 * 组件侧靠匹配 thunk 的 rejected action 弹错误 toast，不再静默。
 */
export const persistGroupFields = createAsyncThunk<
  { groupId: string; fields: GroupLocalFields },
  { groupId: string; fields: GroupLocalFields },
  { state: { tabs: TabState }; rejectValue: { groupId: string; snapshot: GroupLocalFields | null } }
>('tabs/persistGroupFields', async ({ groupId, fields }, { getState, rejectWithValue }) => {
  const snapshot = snapshotGroupLocalFields(
    (getState() as { tabs: TabState }).tabs.groups,
    groupId,
    fields
  );
  const res = await sendMutation<{ groupId: string; updated: TabGroup | null; fields: GroupLocalFields }>({
    op: 'updateGroupFields',
    groupId,
    fields,
  });
  if (!res.ok) {
    logError('[persistGroupFields] 本地偏好保存失败:', { groupId, fields, error: res.error });
    return rejectWithValue({ groupId, snapshot });
  }
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
export const updateGroupNameAndSync = createAsyncThunk<
  { groupId: string; name: string },
  { groupId: string; name: string },
  { state: { tabs: TabState }; rejectValue: { groupId: string; snapshot: GroupMetaSnapshot | null } }
>(
  'tabs/updateGroupNameAndSync',
  async ({ groupId, name }, { dispatch, getState, rejectWithValue }) => {
    // 写入前抓快照（必须在乐观 dispatch 之前，否则抓到的是新名字）
    const snapshot = snapshotGroupMeta((getState() as { tabs: TabState }).tabs.groups, groupId);

    // 在 Redux 中更新标签组名称（乐观更新）
    dispatch(updateGroupName({ groupId, name }));

    const res = await sendMutation<{ groupId: string; name: string }>({
      op: 'renameGroup',
      groupId,
      name,
    });
    if (!res.ok) {
      // 不 throw：抛错会丢掉快照，rejected reducer 拿不到还原所需的数据
      logError('[updateGroupNameAndSync] 重命名失败:', { groupId, name, error: res.error });
      return rejectWithValue({ groupId, snapshot });
    }

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
export const toggleGroupLockAndSync = createAsyncThunk<
  { groupId: string; isLocked: boolean },
  string,
  { state: { tabs: TabState }; rejectValue: { groupId: string; snapshot: GroupMetaSnapshot | null } }
>(
  'tabs/toggleGroupLockAndSync',
  async (groupId, { dispatch, getState, rejectWithValue }) => {
    const snapshot = snapshotGroupMeta((getState() as { tabs: TabState }).tabs.groups, groupId);

    // 在 Redux 中切换标签组锁定状态（乐观更新）
    dispatch(toggleGroupLock(groupId));

    const res = await sendMutation<{ groupId: string; isLocked: boolean }>({
      op: 'toggleGroupLock',
      groupId,
    });
    if (!res.ok) {
      logError('[toggleGroupLockAndSync] 切换锁定失败:', { groupId, error: res.error });
      return rejectWithValue({ groupId, snapshot });
    }

    return res.payload!;
  }
);

/** SW 回传的清理结果：只有计划与落盘用的 now/stamp，没有 groups 全量（见 CleanDuplicatesPlan）。 */
export interface CleanDuplicatesResult {
  plan: CleanDuplicatesPlan;
  now: string;
  stamp: OpStamp;
}

/**
 * 清理重复标签。
 *
 * UI 反馈不再等 SW 回传 groups 全量：pending 阶段用同一个纯函数在本地算计划并
 * 立即应用（乐观更新），fulfilled 用 SW 的权威计划从快照重推收敛到磁盘真值。
 * 计数取自计划，因此 toast 文案在 fulfilled 才确定（pending 的本地计数可能因
 * popup 状态陈旧而与 SW 不同，不能拿来当结论）。
 */
export const cleanDuplicateTabs = createAsyncThunk(
  'tabs/cleanDuplicateTabs',
  async (): Promise<CleanDuplicatesResult> => {
    const res = await sendMutation<CleanDuplicatesResult>({ op: 'cleanDuplicates' });
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
        state.groups = stripInFlightDeletions(
          action.payload,
          Object.values(state.optimisticBackups ?? {}),
          inFlightDeletedGroupIds(state)
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
      // 删除整个会话：乐观移除 + 失败还原。
      //
      // 【为什么需要乐观】原先只有 fulfilled case：用户点删除后，UI 要等
      // 「排队 → 读全量 → 写全量 → 登记删除队列 → 置位上传 → 跨进程回包」整条链
      // 跑完才动。SW 冷启动或队列里排着后台同步时，这个等待是秒级的，
      // 体感就是「点了删除没反应」——与清理重复标签是同一个病根。
      .addCase(deleteGroup.pending, (state, action) => {
        const groupId = action.meta.arg;
        const index = state.groups.findIndex(g => g.id === groupId);
        // 组不在列表里：无可删，也不建备份（避免 fulfilled/rejected 处理幽灵槽位）
        if (index === -1) return;
        if (!state.deletedGroupBackups) state.deletedGroupBackups = {};
        // 备份整组 + 位置：rejected 时按原下标插回，避免还原后顺序跳变
        state.deletedGroupBackups[groupId] = {
          group: state.groups[index],
          index,
        };
        state.groups.splice(index, 1);
        if (state.activeGroupId === groupId) {
          state.activeGroupId = null;
        }
        // 代际前进：此后到达的旧 loadGroups 回环不得把刚删的组带回来
        //（与 deleteTabAndSync / cleanDuplicateTabs 同一机制）。
        state.mutationEpoch = (state.mutationEpoch ?? 0) + 1;
        // 此刻**不**作废在途的单标签删除备份：pending 只是乐观意图，磁盘还没删。
        // 若这次组删除失败，rejected 会把整组还原，那些备份还要用来把标签插回原位；
        // 作废的时机是 fulfilled（磁盘确认组已不存在），见那里的注释。
        state.error = null;
      })
      .addCase(deleteGroup.fulfilled, (state, action) => {
        const groupId = action.payload;
        // 磁盘已删：清掉回滚基线（乐观结果就是最终结果）。
        // 幂等——pending 时组已移除，这里再 filter 一次可覆盖「pending 未跑」的
        // 直接 dispatch（测试）与并发删除的极端情形。
        if (state.deletedGroupBackups) delete state.deletedGroupBackups[groupId];
        state.groups = state.groups.filter(g => g.id !== groupId);
        if (state.activeGroupId === groupId) {
          state.activeGroupId = null;
        }
        // 作废该组在途的单标签删除备份。
        //
        // 【为什么在 fulfilled 而不是 pending 作废】pending 只是乐观意图，磁盘还没删：
        // 若这次组删除**失败**，deleteGroup.rejected 会把整组还原，此时那些标签备份
        // 仍有意义（标签删除若也失败，要能把它插回原位）。只有 fulfilled 才代表
        // 磁盘上组已确实不存在——那些标签连同组一起没了，备份已无从回滚。
        //
        // 【留着备份的后果】deleteTabAndSync.rejected 在「组不在」时会按它抓的整组
        // 快照 unshift 把组恢复回来。整组被显式删除后，一次失败的标签删除就会
        // **复活用户刚删掉的整个会话**；v1.22.0 起没有回收站，用户看到的是「删了又回来」。
        if (state.optimisticBackups) {
          for (const key of Object.keys(state.optimisticBackups)) {
            if (state.optimisticBackups[key]?.groupId === groupId) {
              delete state.optimisticBackups[key];
            }
          }
        }
      })
      .addCase(deleteGroup.rejected, (state, action) => {
        const groupId = action.meta.arg;
        const backup = state.deletedGroupBackups?.[groupId];
        if (state.deletedGroupBackups) delete state.deletedGroupBackups[groupId];
        if (backup) {
          // 按原下标插回；下标越界（期间列表变短）则追加到末尾
          const at = Math.max(0, Math.min(backup.index, state.groups.length));
          if (!state.groups.some(g => g.id === groupId)) {
            state.groups.splice(at, 0, backup.group);
          }
        }
        state.error = action.error.message || '删除会话失败';
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
          } else if (state.deletedGroupBackups?.[groupId]) {
            // 组不在，且原因是**整组删除正在途**（deleteGroup.pending 已乐观移除，
            // 尚未 fulfilled/rejected）。
            //
            // 此时绝不能走下面的「按快照恢复整组」分支：那会把用户刚删掉的会话
            // 原地复活（v1.22.0 起没有回收站，用户看到的就是「删了又回来」）。
            //
            // 但也不能什么都不做：这次标签删除失败了，磁盘上它还在，而组删除的
            // 备份是在「标签已被乐观移除之后」抓的，里面没有它。若组删除随后也失败，
            // 按那份备份还原就会**永久漏掉这个标签**（UI 少显示、磁盘上还在）。
            //
            // 正解是把标签并回组删除的备份，让两种结局都正确：
            //   组删除成功 → 整组连同它一起消失（磁盘上确实没了）；
            //   组删除失败 → 按合并后的备份还原，标签完整回来。
            const gb = state.deletedGroupBackups[groupId];
            const tabs = [...gb.group.tabs];
            if (!tabs.some(t => t.id === tabId)) {
              tabs.splice(Math.max(0, Math.min(backup.index, tabs.length)), 0, backup.tab);
            }
            gb.group = { ...gb.group, tabs };
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
        // 磁盘上一个组都不剩了 ⇒ **两类**乐观删除备份全部作废。
        //
        // 留着备份的后果不是「多占点内存」，而是复活：
        //  - 组级（deletedGroupBackups）：随后到达的 deleteGroup.rejected 会按备份
        //    把那个组插回列表，而它在磁盘上已经被全删干掉；
        //  - 标签级（optimisticBackups）：随后到达的 deleteTabAndSync.rejected 走
        //    「组不在列表」分支时会按整组快照 unshift，把**整个会话**带回来。
        // 两者都属于「用户删光了，界面上却冒出会话」。
        //
        // 与 deleteGroup.fulfilled 作废标签备份是同一条规则：备份只在「磁盘上还在」
        // 的前提下有意义；全删成功后这个前提对任何组都不成立。
        state.deletedGroupBackups = {};
        state.optimisticBackups = {};
        // 代际前进：全删之后到达的旧 loadGroups 回环不得把整份列表带回来
        state.mutationEpoch = (state.mutationEpoch ?? 0) + 1;
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
      .addCase(updateGroupNameAndSync.rejected, (state, action) => {
        // P1-5：storage 写失败 → 把乐观新名字收回去。
        // 以前这里是空 reducer，UI 永久显示未落盘的名字，storage 永远是旧的。
        const snapshot = action.payload?.snapshot;
        if (snapshot) {
          const group = state.groups.find(g => g.id === action.payload?.groupId);
          if (group) restoreGroupName(group, snapshot);
        }
        state.error = action.error.message || '重命名失败，会话名称已恢复';
      })

      // 切换标签组锁定状态并同步到云端
      .addCase(toggleGroupLockAndSync.pending, () => {
        // 不更新UI状态，因为已经在 reducer 中更新了
      })
      .addCase(toggleGroupLockAndSync.fulfilled, () => {
        // 不更新UI状态，因为已经在 reducer 中更新了
      })
      .addCase(toggleGroupLockAndSync.rejected, (state, action) => {
        // P1-5：这条不还原后果最重——UI 显示“已锁定”而 storage 未锁定，
        // 自动清理/删除保护按 storage 判据执行，用户刚锁的会话会被当普通组清掉。
        const snapshot = action.payload?.snapshot;
        if (snapshot) {
          const group = state.groups.find(g => g.id === action.payload?.groupId);
          if (group) restoreGroupLock(group, snapshot);
        }
        state.error = action.error.message || '切换锁定失败，锁定状态已恢复';
      })

      // 收藏/备注（本地偏好，不进云端）：失败同样回滚，否则 UI 与 storage 永久不一致
      .addCase(persistGroupFields.rejected, (state, action) => {
        const snapshot = action.payload?.snapshot;
        if (snapshot) {
          const group = state.groups.find(g => g.id === action.payload?.groupId);
          if (group) restoreGroupLocalFields(group, snapshot);
        }
        state.error = action.error.message || '保存失败，已恢复原值';
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

      // 清理重复标签和空会话：pending 乐观应用，fulfilled 从快照重推收敛，
      // rejected 整段还原。计划与 SW 共用同一纯函数（见 tabSliceHelpers）。
      .addCase(cleanDuplicateTabs.pending, state => {
        // 抓快照必须在乐观改之前：fulfilled/rejected 都以它为基线。
        state.cleanDuplicatesSnapshot = state.groups;
        const optimistic = planOptimisticClean(state.groups);
        state.groups = optimistic.groups;
        // 代际前进：此后到达的 loadGroups 回环若带的是清理前快照，一律忽略
        //（与 deleteTabAndSync 同一机制）。少了这一步，一次在途回环就会把
        // 刚清掉的重复标签整批复活。
        state.mutationEpoch = (state.mutationEpoch ?? 0) + 1;
        state.error = null;
        // 不再置 isLoading=true：清理已有乐观结果，列表不该整页转圈
        //（TabList 只在 groups 为空时才整页 loading，但置位仍会引发多余重渲染）。
      })
      .addCase(cleanDuplicateTabs.fulfilled, (state, action) => {
        const { plan, now, stamp } = action.payload;
        // 基线 = pending 抓的快照；缺失（如直接 dispatch fulfilled action 的测试、
        // 或 pending reducer 未跑）则退回当前值，保证不崩。
        const base = state.cleanDuplicatesSnapshot ?? state.groups;
        state.cleanDuplicatesSnapshot = null;
        state.isLoading = false;
        // 用 SW 的权威计划从快照重推（理由见 planOptimisticClean 注释）。
        const derived = applyCleanPlanToActiveView(base, plan, now, stamp);
        // 仍要剥掉在途的乐观删除项：清理与单标签删除可能同时在途，
        // 重推出的结果基于快照，会把那次删除的标签又带回来。
        state.groups = stripInFlightDeletions(
          derived,
          Object.values(state.optimisticBackups ?? {}),
          inFlightDeletedGroupIds(state)
        );
      })
      .addCase(cleanDuplicateTabs.rejected, (state, action) => {
        state.isLoading = false;
        // 乐观结果整段还原（清理失败时磁盘没变，UI 不能留着假象）。
        // 同样要在还原后剥掉在途删除项，避免快照复活正在删的标签。
        if (state.cleanDuplicatesSnapshot) {
          state.groups = stripInFlightDeletions(
            state.cleanDuplicatesSnapshot,
            Object.values(state.optimisticBackups ?? {}),
            inFlightDeletedGroupIds(state)
          );
        }
        state.cleanDuplicatesSnapshot = null;
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
