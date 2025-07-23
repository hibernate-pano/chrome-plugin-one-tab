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

// 清理重复标签功能 - 简化版实现，确保云端同步
export const cleanDuplicateTabs = createAsyncThunk<
  { removedCount: number; updatedGroups: TabGroup[]; syncSuccess: boolean },
  void
>(
  'tabGroups/cleanDuplicateTabs',
  async (_, { dispatch }) => {
    logger.debug('开始清理重复标签 - 使用简化版去重逻辑');

    try {
      const groups = await storage.getGroups();
      const urlMap = new Map<string, { groupId: string; tabIndex: number }>();
      let removedCount = 0;

      // 创建深拷贝避免修改原数据
      const updatedGroups = groups.map(group => ({
        ...group,
        tabs: [...group.tabs]
      }));

      // 执行去重逻辑
      updatedGroups.forEach((group) => {
        const originalTabCount = group.tabs.length;

        group.tabs = group.tabs.filter((tab) => {
          if (!tab.url) return true; // 保留没有URL的标签

          const key = tab.url;
          if (urlMap.has(key)) {
            removedCount++;
            return false; // 重复，过滤掉
          }

          urlMap.set(key, { groupId: group.id, tabIndex: 0 });
          return true;
        });

        // 如果标签数量发生变化，更新时间戳
        if (group.tabs.length !== originalTabCount) {
          group.updatedAt = new Date().toISOString();
        }
      });

      // 过滤空的标签组
      const finalGroups = updatedGroups.filter(group => group.tabs.length > 0);

      // 保存到存储
      await storage.setGroups(finalGroups);

      // 强制同步到云端 - 确保去重结果不被覆盖
      try {
        const { pullFirstSyncService } = await import('@/services/PullFirstSyncService');

        // 使用强制推送模式，确保去重结果同步到云端
        const syncResult = await pullFirstSyncService.syncUserOperation({
          type: 'update',
          description: `清理重复标签 (移除了 ${removedCount} 个重复标签)`
        });

        if (!syncResult.success) {
          logger.error('去重操作后同步失败，尝试直接上传:', syncResult.error);

          // 如果 pull-first 同步失败，直接上传到云端
          const supabaseModule = await import('@/shared/utils/supabase');
          await supabaseModule.sync.uploadTabGroups(finalGroups, true); // 使用覆盖模式

          logger.debug('去重结果已强制上传到云端');
        } else {
          logger.debug('去重操作后同步成功');
        }
      } catch (error) {
        logger.error('去重操作后同步完全失败:', error);

        // 同步失败时，仍然返回去重结果，但标记同步失败
        logger.warn('去重操作完成，但同步到云端失败，请手动同步确保数据一致性');

        // 即使同步失败，也要强制重新加载数据以确保UI一致性
        setTimeout(() => {
          dispatch(loadGroups());
          logger.debug('去重后（同步失败）强制重新加载数据');
        }, 100);

        return {
          removedCount,
          updatedGroups: finalGroups,
          syncSuccess: false
        };
      }

      // 强制清理所有可能的缓存
      try {
        const { cacheManager } = await import('@/shared/utils/cacheManager');
        await cacheManager.clearAll();
        logger.debug('缓存清理完成');
      } catch (error) {
        logger.warn('清理缓存时出现警告', error instanceof Error ? error : new Error(String(error)));
      }

      logger.debug('清理重复标签完成', {
        removedCount,
        remainingGroups: finalGroups.length,
        originalGroups: groups.length,
        finalGroupsIds: finalGroups.map(g => g.id)
      });

      // 强制重新加载数据以确保状态一致性
      setTimeout(() => {
        dispatch(loadGroups());
        logger.debug('去重后强制重新加载数据');
      }, 100);

      return {
        removedCount,
        updatedGroups: finalGroups,
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

        // 强制更新 Redux 状态，确保组件重新渲染
        state.groups = [...action.payload.updatedGroups];

        // 清除之前的错误信息
        state.error = null;

        // 如果同步失败，设置警告信息
        if (!action.payload.syncSuccess) {
          state.error = '去重完成，但同步失败。请手动点击同步按钮确保数据一致性。';
        }

        logger.debug('去重操作完成，Redux状态已更新', {
          removedCount: action.payload.removedCount,
          remainingGroups: action.payload.updatedGroups.length,
          syncSuccess: action.payload.syncSuccess,
          newStateLength: state.groups.length
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