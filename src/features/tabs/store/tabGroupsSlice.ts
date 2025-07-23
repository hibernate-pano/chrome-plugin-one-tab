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
import { moveTab, moveGroup } from './dragOperationsSlice';

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
  return groups;
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

// 清理重复标签功能 - 使用统一同步服务（带异常分析）
export const cleanDuplicateTabs = createAsyncThunk(
  'tabGroups/cleanDuplicateTabs',
  async () => {
    logger.debug('开始清理重复标签 - 使用统一同步服务');

    try {
      // 创建初始数据快照
      const { createDataSnapshot } = await import('@/utils/deduplicationAnalyzer');
      const initialGroups = await storage.getGroups();
      createDataSnapshot(initialGroups, '去重前原始数据');

      // 使用统一同步服务执行去重操作
      const { unifiedSyncService } = await import('@/services/UnifiedSyncService');
      const result = await unifiedSyncService.performDeduplication();

      if (!result.success) {
        throw new Error(result.error || '去重操作失败');
      }

      // 创建结果数据快照
      const finalGroups = result.syncedGroups || [];
      createDataSnapshot(finalGroups, '去重后最终数据');

      // 如果结果异常，进行详细分析
      const initialTabCount = initialGroups.reduce((sum, g) => sum + g.tabs.length, 0);
      const finalTabCount = finalGroups.reduce((sum, g) => sum + g.tabs.length, 0);

      // 从结果消息中提取移除数量
      const removedCountMatch = result.message.match(/移除了 (\d+) 个/);
      const removedCount = removedCountMatch ? parseInt(removedCountMatch[1]) : 0;
      const expectedFinalCount = initialTabCount - removedCount;

      // 如果实际结果与期望不符，进行异常分析
      if (finalTabCount !== expectedFinalCount) {
        console.warn('🚨 检测到去重结果异常！');

        // 模拟期望的去重结果用于分析
        const { analyzeDeduplicationAnomaly } = await import('@/utils/deduplicationAnalyzer');

        // 这里我们需要重新计算期望的去重结果
        const expectedGroups = await simulateDeduplication(initialGroups);

        const analysis = analyzeDeduplicationAnomaly(initialGroups, expectedGroups, finalGroups);

        console.error('去重异常分析结果:', analysis);

        // 可以选择是否抛出错误或继续
        logger.warn('去重结果与期望不符', {
          初始标签数: initialTabCount,
          期望最终数: expectedFinalCount,
          实际最终数: finalTabCount,
          差异: finalTabCount - expectedFinalCount
        });
      }

      logger.debug('清理重复标签完成 - 统一同步服务', {
        message: result.message,
        remainingGroups: finalGroups.length,
        initialTabCount,
        finalTabCount,
        removedCount
      });

      return {
        removedCount,
        updatedGroups: finalGroups
      };
    } catch (error) {
      logger.error('清理重复标签失败', error);
      throw error;
    }
  }
);

/**
 * 模拟去重操作，用于分析对比
 */
async function simulateDeduplication(groups: TabGroup[]): Promise<TabGroup[]> {
  const urlMap = new Map<string, { groupId: string; tabIndex: number }>();

  // 创建深拷贝避免修改原数据
  const simulatedGroups = groups.map(group => ({
    ...group,
    tabs: [...group.tabs]
  }));

  // 执行去重逻辑
  simulatedGroups.forEach((group) => {
    group.tabs = group.tabs.filter((tab) => {
      if (!tab.url) return true;

      const key = tab.url;
      if (urlMap.has(key)) {
        return false; // 重复，过滤掉
      }

      urlMap.set(key, { groupId: group.id, tabIndex: 0 });
      return true;
    });

    // 更新时间戳
    if (group.tabs.length !== groups.find(g => g.id === group.id)?.tabs.length) {
      group.updatedAt = new Date().toISOString();
    }
  });

  // 过滤空的标签组
  return simulatedGroups.filter(group => group.tabs.length > 0);
}

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
      state.groups = action.payload;
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
        state.groups = action.payload.updatedGroups;
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

      .addCase(moveGroup.fulfilled, (state, action) => {
        // 标签组拖拽完成后重新加载数据
        // 这里可以添加更精确的状态更新逻辑
        logger.debug('标签组拖拽完成', action.payload);
      })
      .addCase(moveGroup.rejected, (state, action) => {
        // 标签组拖拽失败时的错误处理
        state.error = action.error.message || '移动标签组失败';
        logger.error('标签组拖拽失败', action.error);
      });
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