/**
 * 标签组状态管理
 * 处理标签组的创建、删除、重命名等操作
 */
import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { storage } from '@/shared/utils/storage';
import { logger } from '@/shared/utils/logger';
import { TabGroup } from '@/shared/types/tab';
import { nanoid } from '@reduxjs/toolkit';
// 导入拖拽操作，用于监听拖拽完成事件
import { moveTab } from './dragOperationsSlice';

interface TabGroupsState {
  groups: TabGroup[];
  activeGroupId: string | null;
  isLoading: boolean;
  error: string | null;
  searchQuery: string;
}

const initialState: TabGroupsState = {
  groups: [],
  activeGroupId: null,
  isLoading: false,
  error: null,
  searchQuery: '',
};

// 异步操作
export const loadGroups = createAsyncThunk('tabGroups/loadGroups', async () => {
  logger.debug('加载标签组');
  const groups = await storage.getGroups();

  // 确保标签组按时间倒序排列（最新的在前面）
  const sortedGroups = groups.sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  return sortedGroups;
});

export const saveGroup = createAsyncThunk(
  'tabGroups/saveGroup',
  async (group: Omit<TabGroup, 'id' | 'createdAt' | 'updatedAt' | 'version'>) => {
    logger.debug('开始原子保存新标签组', { name: group.name, tabCount: group.tabs.length });

    try {
      // 使用同步协调器执行原子创建操作
      const { syncCoordinator } = await import('@/services/syncCoordinator');

      const result = await syncCoordinator.executeAtomicOperation<TabGroup>(
        'create',
        async (groups: TabGroup[]) => {
          const newGroup: TabGroup = {
            ...group,
            id: nanoid(),
            version: 1, // 新标签组版本号从1开始
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };

          const updatedGroups = [newGroup, ...groups];

          return {
            success: true,
            updatedGroups,
            result: newGroup
          };
        },
        '创建标签组'
      );

      if (!result.success) {
        throw new Error('创建标签组失败');
      }

      logger.debug('原子保存标签组完成', {
        id: result.result.id,
        operationId: result.operationId
      });

      return result.result;

    } catch (error) {
      logger.error('保存标签组失败', error);
      throw error;
    }
  }
);

export const updateGroup = createAsyncThunk(
  'tabGroups/updateGroup',
  async (group: TabGroup) => {
    logger.debug('开始原子更新标签组', { id: group.id, name: group.name });

    try {
      // 使用同步协调器执行原子更新操作
      const { syncCoordinator } = await import('@/services/syncCoordinator');

      const result = await syncCoordinator.executeProtectedUpdate(
        group.id,
        (existingGroup) => ({
          ...existingGroup,
          ...group,
          // 保持原有的创建时间和ID
          id: existingGroup.id,
          createdAt: existingGroup.createdAt
        }),
        '更新标签组'
      );

      if (!result.success || !result.updatedGroup) {
        throw new Error(`更新标签组失败: ${group.id}`);
      }

      logger.debug('原子更新标签组完成', {
        id: result.updatedGroup.id,
        operationId: result.operationId
      });

      return result.updatedGroup;

    } catch (error) {
      logger.error('更新标签组失败', error);
      throw error;
    }
  }
);

export const deleteGroup = createAsyncThunk(
  'tabGroups/deleteGroup',
  async (groupId: string) => {
    logger.debug('开始原子删除操作', { groupId });

    try {
      // 使用同步协调器执行原子删除操作
      const { syncCoordinator } = await import('@/services/syncCoordinator');
      const result = await syncCoordinator.executeProtectedDeletion(groupId);

      if (!result.success) {
        throw new Error(`删除标签组失败: ${groupId}`);
      }

      logger.debug('原子删除操作完成', {
        deletedGroupId: result.deletedGroupId,
        operationId: result.operationId
      });

      return result.deletedGroupId;

    } catch (error) {
      logger.error('删除标签组失败', error);
      throw error;
    }
  }
);

// 清理重复标签功能 - 使用原子操作框架确保数据一致性
export const cleanDuplicateTabs = createAsyncThunk<
  { removedCount: number; updatedGroups: TabGroup[]; syncSuccess: boolean },
  void
>(
  'tabGroups/cleanDuplicateTabs',
  async () => {
    logger.debug('开始清理重复标签 - 使用原子操作框架');

    try {
      // 使用与删除功能相同的原子操作框架
      const { syncCoordinator } = await import('@/services/syncCoordinator');

      const result = await syncCoordinator.executeProtectedDeduplication();

      if (!result.success) {
        throw new Error('去重操作失败');
      }

      logger.debug('原子去重操作完成', {
        removedCount: result.removedCount,
        operationId: result.operationId
      });

      // 获取最新的数据状态
      const updatedGroups = await storage.getGroups();

      return {
        removedCount: result.removedCount,
        updatedGroups,
        syncSuccess: true
      };

    } catch (error) {
      logger.error('清理重复标签失败', error);
      throw error;
    }
  }
);

// simulateDeduplication 函数已移除，因为去重功能已禁用

export const updateGroupName = createAsyncThunk(
  'tabGroups/updateGroupName',
  async ({ groupId, name }: { groupId: string; name: string }) => {
    logger.debug('更新标签组名称', { groupId, name });

    const groups = await storage.getGroups();
    const group = groups.find(g => g.id === groupId);

    if (!group) {
      throw new Error(`标签组 ${groupId} 未找到`);
    }

    const updatedGroup = {
      ...group,
      name,
      updatedAt: new Date().toISOString(),
    };

    const updatedGroups = groups.map(g => g.id === groupId ? updatedGroup : g);
    await storage.setGroups(updatedGroups);

    // 触发用户删除操作后的push-only同步
    try {
      const { optimisticSyncService } = await import('@/services/optimisticSyncService');
      optimisticSyncService.schedulePushOnly();
      console.log('✅ 删除后同步服务启动成功');
    } catch (error) {
      console.error('❌ 删除后同步服务启动失败:', error);
      // 不再降级，记录错误
      console.error('同步服务不可用，请检查网络连接');
    }

    return { groupId, name };
  }
);

export const toggleGroupLock = createAsyncThunk(
  'tabGroups/toggleGroupLock',
  async (groupId: string) => {
    logger.debug('切换标签组锁定状态', { groupId });

    const groups = await storage.getGroups();
    const group = groups.find(g => g.id === groupId);

    if (!group) {
      throw new Error(`标签组 ${groupId} 未找到`);
    }

    const updatedGroup = {
      ...group,
      isLocked: !group.isLocked,
      updatedAt: new Date().toISOString(),
    };

    const updatedGroups = groups.map(g => g.id === groupId ? updatedGroup : g);
    await storage.setGroups(updatedGroups);

    return { groupId, isLocked: updatedGroup.isLocked };
  }
);

export const deleteAllGroups = createAsyncThunk(
  'tabGroups/deleteAllGroups',
  async () => {
    logger.debug('删除所有标签组');

    const groups = await storage.getGroups();
    const count = groups.length;

    await storage.setGroups([]);

    return { count };
  }
);

// Slice定义
const tabGroupsSlice = createSlice({
  name: 'tabGroups',
  initialState,
  reducers: {
    setActiveGroup: (state, action: PayloadAction<string | null>) => {
      state.activeGroupId = action.payload;
    },

    setSearchQuery: (state, action: PayloadAction<string>) => {
      state.searchQuery = action.payload;
    },

    setError: (state, action: PayloadAction<string | null>) => {
      state.error = action.payload;
    },

    // 临时更新组名（用于编辑时的即时反馈）
    updateGroupNameLocal: (state, action: PayloadAction<{ groupId: string; name: string }>) => {
      const { groupId, name } = action.payload;
      const group = state.groups.find(g => g.id === groupId);
      if (group) {
        group.name = name;
      }
    },

    // 临时切换锁定状态（用于切换时的即时反馈）
    toggleGroupLockLocal: (state, action: PayloadAction<string>) => {
      const groupId = action.payload;
      const group = state.groups.find(g => g.id === groupId);
      if (group) {
        group.isLocked = !group.isLocked;
      }
    },

    // 设置标签组列表（用于测试和批量操作）
    setGroups: (state, action: PayloadAction<TabGroup[]>) => {
      // 确保标签组按时间倒序排列（最新的在前面）
      const sortedGroups = action.payload.sort((a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      state.groups = sortedGroups;
    },
  },
  extraReducers: (builder) => {
    builder
      // loadGroups
      .addCase(loadGroups.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(loadGroups.fulfilled, (state, action) => {
        state.isLoading = false;
        state.groups = action.payload;
      })
      .addCase(loadGroups.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || '加载标签组失败';
      })

      // saveGroup
      .addCase(saveGroup.fulfilled, (state, action) => {
        state.groups.unshift(action.payload);
      })

      // updateGroup
      .addCase(updateGroup.fulfilled, (state, action) => {
        const index = state.groups.findIndex(g => g.id === action.payload.id);
        if (index !== -1) {
          state.groups[index] = action.payload;
        }
      })

      // deleteGroup
      .addCase(deleteGroup.fulfilled, (state, action) => {
        state.groups = state.groups.filter(g => g.id !== action.payload);
        if (state.activeGroupId === action.payload) {
          state.activeGroupId = null;
        }
      })

      // updateGroupName
      .addCase(updateGroupName.fulfilled, (state, action) => {
        const { groupId, name } = action.payload;
        const group = state.groups.find(g => g.id === groupId);
        if (group) {
          group.name = name;
          group.updatedAt = new Date().toISOString();
        }
      })

      // toggleGroupLock
      .addCase(toggleGroupLock.fulfilled, (state, action) => {
        const { groupId, isLocked } = action.payload;
        const group = state.groups.find(g => g.id === groupId);
        if (group) {
          group.isLocked = isLocked;
          group.updatedAt = new Date().toISOString();
        }
      })

      // deleteAllGroups
      .addCase(deleteAllGroups.pending, (state) => {
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

      // cleanDuplicateTabs
      .addCase(cleanDuplicateTabs.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(cleanDuplicateTabs.fulfilled, (state, action) => {
        state.isLoading = false;

        // 使用原子操作框架的结果更新状态
        state.groups = action.payload.updatedGroups;

        // 清除之前的错误信息
        state.error = null;

        // 如果同步失败，设置警告信息
        if (!action.payload.syncSuccess) {
          state.error = '去重完成，但同步失败。请手动点击同步按钮确保数据一致性。';
        }

        logger.debug('原子去重操作完成，Redux状态已更新', {
          removedCount: action.payload.removedCount,
          remainingGroups: action.payload.updatedGroups.length,
          syncSuccess: action.payload.syncSuccess
        });
      })
      .addCase(cleanDuplicateTabs.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || '清理重复标签失败';
      })

      // 监听拖拽操作 - 确保异步操作结果的权威性
      .addCase(moveTab.fulfilled, (state, action) => {
        // 使用异步操作的结果作为最终状态，确保数据一致性
        if (action.payload.updatedGroups) {
          state.groups = action.payload.updatedGroups;
          logger.debug('标签拖拽异步操作完成，状态已同步', {
            sourceGroupId: action.payload.sourceGroupId,
            targetGroupId: action.payload.targetGroupId,
            targetIndex: action.payload.targetIndex,
            isInterGroupDrag: action.payload.isInterGroupDrag,
            movedTabTitle: action.payload.movedTab?.title
          });
        }
      })
      .addCase(moveTab.rejected, (state, action) => {
        // 拖拽失败时的错误处理
        state.error = action.error.message || '移动标签失败';
        logger.error('标签拖拽失败', action.error);

        // 如果异步操作失败，重新加载数据以确保状态一致性
        // 这里可以添加更精确的回滚逻辑
        logger.warn('拖拽操作失败，建议重新加载数据以确保状态一致性');
      })

    // moveGroup 功能已移除
  },
});

export const {
  setActiveGroup,
  setSearchQuery,
  setError,
  updateGroupNameLocal,
  toggleGroupLockLocal,
  setGroups,
} = tabGroupsSlice.actions;

export default tabGroupsSlice.reducer;