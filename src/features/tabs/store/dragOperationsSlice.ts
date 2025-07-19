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
    
    // 创建新的标签数组
    const newSourceTabs = [...sourceGroup.tabs];
    const newTargetTabs = sourceGroupId === targetGroupId ? newSourceTabs : [...targetGroup.tabs];
    
    // 从源位置移除
    newSourceTabs.splice(sourceIndex, 1);
    
    // 计算调整后的目标索引
    let adjustedIndex = targetIndex;
    if (sourceGroupId === targetGroupId && sourceIndex < targetIndex) {
      adjustedIndex = targetIndex - 1;
    }
    
    // 确保索引在有效范围内
    adjustedIndex = Math.max(0, Math.min(adjustedIndex, newTargetTabs.length));
    
    // 插入到目标位置
    newTargetTabs.splice(adjustedIndex, 0, tab);
    
    // 更新标签组
    const currentTime = new Date().toISOString();
    const updatedSourceGroup = {
      ...sourceGroup,
      tabs: newSourceTabs,
      updatedAt: currentTime,
    };
    
    const updatedTargetGroup = sourceGroupId === targetGroupId ? updatedSourceGroup : {
      ...targetGroup,
      tabs: newTargetTabs,
      updatedAt: currentTime,
    };
    
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
      targetIndex,
      shouldDeleteSourceGroup: newSourceTabs.length === 0 && !sourceGroup.isLocked,
      updatedGroups, // 添加完整的更新后标签组数据用于UI立即更新
      movedTab: tab, // 添加被移动的标签页信息
    };
  }
);

export const moveGroup = createAsyncThunk(
  'dragOps/moveGroup',
  async ({ dragIndex, hoverIndex }: { dragIndex: number; hoverIndex: number }) => {
    logger.dnd('移动标签组', { dragIndex, hoverIndex });
    
    const groups = await storage.getGroups();
    
    // 验证索引
    if (dragIndex < 0 || dragIndex >= groups.length || hoverIndex < 0 || hoverIndex >= groups.length) {
      throw new Error('无效的标签组索引');
    }
    
    const dragGroup = groups[dragIndex];
    const newGroups = [...groups];
    
    // 删除拖拽的标签组
    newGroups.splice(dragIndex, 1);
    // 在新位置插入标签组
    newGroups.splice(hoverIndex, 0, dragGroup);
    
    await storage.setGroups(newGroups);
    
    return { dragIndex, hoverIndex };
  }
);

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
      
      // moveGroup
      .addCase(moveGroup.pending, (state) => {
        state.isProcessing = true;
        state.error = null;
      })
      .addCase(moveGroup.fulfilled, (state, action) => {
        state.isProcessing = false;
        logger.success('标签组移动完成', action.payload);
      })
      .addCase(moveGroup.rejected, (state, action) => {
        state.isProcessing = false;
        state.error = action.error.message || '移动标签组失败';
        logger.error('移动标签组失败', action.error);
      });
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