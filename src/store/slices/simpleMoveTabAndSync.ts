import { createAsyncThunk } from '@reduxjs/toolkit';
import { moveTab } from './tabSlice';
import { storage } from '@/utils/storage';

// 简化版的移动标签页并同步到云端函数
export const simpleMoveTabAndSync = createAsyncThunk(
  'tabs/simpleMoveTabAndSync',
  async ({
    sourceGroupId,
    sourceIndex,
    targetGroupId,
    targetIndex
  }: {
    sourceGroupId: string,
    sourceIndex: number,
    targetGroupId: string,
    targetIndex: number
  }, { dispatch }) => {
    try {
      // 在 Redux 中移动标签页
      dispatch(moveTab({ sourceGroupId, sourceIndex, targetGroupId, targetIndex }));

      // 使用 setTimeout 延迟执行存储操作，避免阻塞 UI
      setTimeout(async () => {
        try {
          // 在本地存储中更新标签页位置
          const groups = await storage.getGroups();
          const sourceGroup = groups.find(g => g.id === sourceGroupId);
          const targetGroup = groups.find(g => g.id === targetGroupId);

          if (sourceGroup && targetGroup) {
            // 获取要移动的标签页
            const tab = sourceGroup.tabs[sourceIndex];

            // 创建新的标签页数组以避免直接修改原数组
            const newSourceTabs = [...sourceGroup.tabs];
            const newTargetTabs = sourceGroupId === targetGroupId ? newSourceTabs : [...targetGroup.tabs];

            // 从源标签组中删除标签页
            newSourceTabs.splice(sourceIndex, 1);

            // 修复：计算调整后的目标索引
            // 对于同组内移动，无论拖动方向如何，都直接使用 targetIndex
            // 这与主要的 Redux reducer 逻辑保持一致
            let adjustedIndex = targetIndex;

            // 确保索引在有效范围内
            adjustedIndex = Math.max(0, Math.min(adjustedIndex, newTargetTabs.length));

            // 插入标签到目标位置
            newTargetTabs.splice(adjustedIndex, 0, tab);

            // 创建更新后的标签组对象，避免直接修改原对象
            const updatedSourceGroup = {
              ...sourceGroup,
              tabs: newSourceTabs,
              updatedAt: new Date().toISOString()
            };

            let updatedTargetGroup = targetGroup;
            if (sourceGroupId !== targetGroupId) {
              updatedTargetGroup = {
                ...targetGroup,
                tabs: newTargetTabs,
                updatedAt: new Date().toISOString()
              };
            }

            // 更新本地存储
            const updatedGroups = groups.map(g => {
              if (g.id === sourceGroupId) return updatedSourceGroup;
              if (g.id === targetGroupId) return updatedTargetGroup;
              return g;
            }).filter(g => g.tabs.length > 0); // 移除空标签组

            await storage.setGroups(updatedGroups);

          }
        } catch (error) {
          console.error('存储标签页移动操作失败:', error);
        }
      }, 100); // 延迟100ms执行存储操作

      return { sourceGroupId, sourceIndex, targetGroupId, targetIndex };
    } catch (error) {
      console.error('移动标签页操作失败:', error);
      throw error;
    }
  }
);
