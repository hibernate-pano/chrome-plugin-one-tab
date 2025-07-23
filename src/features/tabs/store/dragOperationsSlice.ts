/**
 * 拖拽操作状态管理
 * 处理标签页和标签组的拖拽、排序操作
 */
import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { storage } from '@/shared/utils/storage';
import { logger } from '@/shared/utils/logger';

interface DragOperationsState {
  isDragging: boolean;
  dragType: 'tab' | 'group' | null;
  dragItemId: string | null;
  dropTargetId: string | null;
  isProcessing: boolean;
  error: string | null;
}

const initialState: DragOperationsState = {
  isDragging: false,
  dragType: null,
  dragItemId: null,
  dropTargetId: null,
  isProcessing: false,
  error: null,
};

// 异步操作
export const moveTab = createAsyncThunk(
  'dragOps/moveTab',
  async ({
    sourceGroupId,
    sourceIndex,
    targetGroupId,
    targetIndex,
  }: {
    sourceGroupId: string;
    sourceIndex: number;
    targetGroupId: string;
    targetIndex: number;
  }) => {
    logger.dnd('移动标签页', { sourceGroupId, sourceIndex, targetGroupId, targetIndex });

    const groups = await storage.getGroups();
    const sourceGroup = groups.find(g => g.id === sourceGroupId);
    const targetGroup = groups.find(g => g.id === targetGroupId);

    if (!sourceGroup || !targetGroup) {
      throw new Error('标签组未找到');
    }

    // 获取要移动的标签页
    const tab = sourceGroup.tabs[sourceIndex];
    if (!tab) {
      throw new Error('标签页未找到');
    }

    // 创建新的标签数组 - 修复跨组拖拽逻辑
    const isInterGroupDrag = sourceGroupId !== targetGroupId;
    const newSourceTabs = [...sourceGroup.tabs];
    const newTargetTabs = isInterGroupDrag ? [...targetGroup.tabs] : newSourceTabs;

    // 从源位置移除标签
    const movedTab = newSourceTabs.splice(sourceIndex, 1)[0];

    if (!movedTab) {
      throw new Error(`标签页在索引 ${sourceIndex} 处未找到`);
    }

    // 计算调整后的目标索引
    let adjustedIndex = targetIndex;
    if (!isInterGroupDrag && sourceIndex < targetIndex) {
      // 同组内向后移动时，需要调整索引
      adjustedIndex = targetIndex - 1;
    }

    // 确保索引在有效范围内
    adjustedIndex = Math.max(0, Math.min(adjustedIndex, newTargetTabs.length));

    // 插入到目标位置
    newTargetTabs.splice(adjustedIndex, 0, movedTab);

    // 添加调试日志
    logger.dnd('标签移动详情', {
      isInterGroupDrag,
      sourceGroupId,
      targetGroupId,
      originalSourceIndex: sourceIndex,
      originalTargetIndex: targetIndex,
      adjustedTargetIndex: adjustedIndex,
      movedTabTitle: movedTab.title,
      sourceTabsAfter: newSourceTabs.length,
      targetTabsAfter: newTargetTabs.length
    });

    // 更新标签组 - 修复跨组拖拽的状态更新
    const currentTime = new Date().toISOString();
    const updatedSourceGroup = {
      ...sourceGroup,
      tabs: isInterGroupDrag ? newSourceTabs : newTargetTabs, // 同组内拖拽时使用更新后的标签数组
      updatedAt: currentTime,
    };

    const updatedTargetGroup = isInterGroupDrag ? {
      ...targetGroup,
      tabs: newTargetTabs,
      updatedAt: currentTime,
    } : updatedSourceGroup;

    // 更新存储
    const updatedGroups = groups.map(g => {
      if (g.id === sourceGroupId) return updatedSourceGroup;
      if (g.id === targetGroupId) return updatedTargetGroup;
      return g;
    });

    await storage.setGroups(updatedGroups);

    return {
      sourceGroupId,
      sourceIndex,
      targetGroupId,
      targetIndex: adjustedIndex, // 返回调整后的目标索引
      shouldDeleteSourceGroup: newSourceTabs.length === 0 && !sourceGroup.isLocked,
      updatedGroups, // 添加完整的更新后标签组数据用于UI立即更新
      movedTab, // 使用正确的变量名
      isInterGroupDrag, // 添加跨组拖拽标识
    };
  }
);

// moveGroup 功能已移除 - 不再支持标签组拖拽

// 使用节流的批量操作（暂时未使用，保留供将来使用）
// const _throttledBatchOperation = throttle(async (operations: Array<() => Promise<void>>) => {
//   logger.dnd('执行批量拖拽操作', { count: operations.length });
//   
//   for (const operation of operations) {
//     try {
//       await operation();
//     } catch (error) {
//       logger.error('批量操作中的单个操作失败', error);
//     }
//   }
// }, 500);

// Slice定义
const dragOperationsSlice = createSlice({
  name: 'dragOps',
  initialState,
  reducers: {
    startDrag: (state, action: PayloadAction<{ type: 'tab' | 'group'; itemId: string }>) => {
      const { type, itemId } = action.payload;
      state.isDragging = true;
      state.dragType = type;
      state.dragItemId = itemId;
      logger.dnd('开始拖拽', { type, itemId });
    },

    updateDropTarget: (state, action: PayloadAction<string | null>) => {
      state.dropTargetId = action.payload;
    },

    endDrag: (state) => {
      logger.dnd('结束拖拽', {
        type: state.dragType,
        itemId: state.dragItemId,
        targetId: state.dropTargetId
      });

      state.isDragging = false;
      state.dragType = null;
      state.dragItemId = null;
      state.dropTargetId = null;
    },

    setProcessing: (state, action: PayloadAction<boolean>) => {
      state.isProcessing = action.payload;
    },

    setError: (state, action: PayloadAction<string | null>) => {
      state.error = action.payload;
    },

    // 临时更新拖拽位置（用于视觉反馈）
    updateDragPreview: (_state, action: PayloadAction<{ sourceIndex: number; targetIndex: number }>) => {
      // 这里可以添加拖拽预览的状态更新逻辑
      logger.dnd('更新拖拽预览', action.payload);
    },
  },
  extraReducers: (builder) => {
    builder
      // moveTab
      .addCase(moveTab.pending, (state) => {
        state.isProcessing = true;
        state.error = null;
      })
      .addCase(moveTab.fulfilled, (state, action) => {
        state.isProcessing = false;
        logger.success('标签页移动完成', action.payload);
      })
      .addCase(moveTab.rejected, (state, action) => {
        state.isProcessing = false;
        state.error = action.error.message || '移动标签页失败';
        logger.error('移动标签页失败', action.error);
      })

    // moveGroup 功能已移除
  },
});

export const {
  startDrag,
  updateDropTarget,
  endDrag,
  setProcessing,
  setError,
  updateDragPreview,
} = dragOperationsSlice.actions;

export default dragOperationsSlice.reducer;