import { createAsyncThunk } from '@reduxjs/toolkit';
import { moveTab } from './tabSlice';
import { storage } from '@/utils/storage';
import { syncToCloud } from '@/utils/syncHelpers';

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
  }, { getState, dispatch }) => {
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

            // 计算调整后的目标索引
            let adjustedIndex = targetIndex;
            if (sourceGroupId === targetGroupId && sourceIndex < targetIndex) {
              adjustedIndex = targetIndex - 1;
            }

            // 确保索引在有效范围内
            adjustedIndex = Math.max(0, Math.min(adjustedIndex, newTargetTabs.length));

            // 插入标签到目标位置
            newTargetTabs.splice(adjustedIndex, 0, tab);

            // 更新源标签组和目标标签组
            sourceGroup.tabs = newSourceTabs;
            sourceGroup.updatedAt = new Date().toISOString();

            if (sourceGroupId !== targetGroupId) {
              targetGroup.tabs = newTargetTabs;
              targetGroup.updatedAt = new Date().toISOString();
            }

            // 更新本地存储
            const updatedGroups = groups.map(g => {
              if (g.id === sourceGroupId) return sourceGroup;
              if (g.id === targetGroupId) return targetGroup;
              return g;
            }).filter(g => g.tabs.length > 0); // 移除空标签组

            await storage.setGroups(updatedGroups);

            // 使用通用同步函数同步到云端
            // 不等待同步完成，直接返回结果
            // 使用延迟同步，避免频繁的拖拽操作导致过多的同步请求
            setTimeout(() => {
              syncToCloud(dispatch, getState, '标签页移动')
                .catch(err => {
                  if (process.env.NODE_ENV === 'development') {
                    console.error('同步标签页移动操作失败:', err);
                  }
                });
            }, 1000); // 延迟1秒后同步，避免频繁请求
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
