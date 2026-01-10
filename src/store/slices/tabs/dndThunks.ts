/**
 * 拖拽操作的 Async Thunks
 * 处理标签页和标签组的拖拽移动操作
 */

import { createAsyncThunk, ThunkDispatch, UnknownAction } from '@reduxjs/toolkit';
import { TabGroup } from '@/types/tab';
import { storage } from '@/utils/storage';
import { shouldAutoDeleteAfterTabRemoval } from '@/utils/tabGroupUtils';
import { updateDisplayOrder } from '@/utils/versionHelper';
import type { MoveGroupParams, MoveTabParams } from './types';
import { moveGroup, moveTab } from './reducers';
import { deleteGroup } from './crudThunks';

type AppDispatch = ThunkDispatch<unknown, unknown, UnknownAction>;

/**
 * 移动标签组并同步到云端
 */
export const moveGroupAndSync = createAsyncThunk<
  MoveGroupParams,
  MoveGroupParams
>('tabs/moveGroupAndSync', async ({ dragIndex, hoverIndex }, { dispatch }) => {
  const typedDispatch = dispatch as AppDispatch;
  try {
    // 在 Redux 中移动标签组 - 立即更新UI
    typedDispatch(moveGroup({ dragIndex, hoverIndex }));

    // 使用 requestAnimationFrame 在下一帧执行存储操作，优化性能
    requestAnimationFrame(async () => {
      try {
        const groups = await storage.getGroups();

        if (
          dragIndex < 0 ||
          dragIndex >= groups.length ||
          hoverIndex < 0 ||
          hoverIndex >= groups.length
        ) {
          console.error('无效的标签组索引:', {
            dragIndex,
            hoverIndex,
            groupsLength: groups.length,
          });
          return;
        }

        const dragGroup = groups[dragIndex];
        const newGroups = [...groups];
        newGroups.splice(dragIndex, 1);
        newGroups.splice(hoverIndex, 0, dragGroup);

        const updatedGroups = updateDisplayOrder(newGroups);
        await storage.setGroups(updatedGroups);

        console.log(`[MoveGroup] 已更新所有标签组的 displayOrder`);
      } catch (error) {
        console.error('存储标签组移动操作失败:', error);
      }
    });

    return { dragIndex, hoverIndex };
  } catch (error) {
    console.error('移动标签组操作失败:', error);
    throw error;
  }
});

/**
 * 移动标签页并同步到云端
 */
export const moveTabAndSync = createAsyncThunk<MoveTabParams, MoveTabParams>(
  'tabs/moveTabAndSync',
  async (
    { sourceGroupId, sourceIndex, targetGroupId, targetIndex, updateSourceInDrag = true },
    { dispatch }
  ) => {
    const typedDispatch = dispatch as AppDispatch;
    try {
      // 在 Redux 中移动标签页 - 立即更新UI
      typedDispatch(
        moveTab({ sourceGroupId, sourceIndex, targetGroupId, targetIndex })
      );

      // 如果是在拖动过程中且不需要更新源，跳过存储操作
      if (!updateSourceInDrag) {
        return { sourceGroupId, sourceIndex, targetGroupId, targetIndex };
      }

      // 使用 requestAnimationFrame 在下一帧执行存储操作，优化性能
      requestAnimationFrame(async () => {
        try {
          const groups = await storage.getGroups();
          const sourceGroup = groups.find(g => g.id === sourceGroupId);
          const targetGroup = groups.find(g => g.id === targetGroupId);

          if (sourceGroup && targetGroup) {
            const tab = sourceGroup.tabs[sourceIndex];

            if (!tab) {
              console.error('找不到要移动的标签页:', { sourceGroupId, sourceIndex });
              return;
            }

            const newSourceTabs = [...sourceGroup.tabs];
            const newTargetTabs =
              sourceGroupId === targetGroupId ? newSourceTabs : [...targetGroup.tabs];

            newSourceTabs.splice(sourceIndex, 1);

            let adjustedIndex = targetIndex;
            adjustedIndex = Math.max(0, Math.min(adjustedIndex, newTargetTabs.length));
            newTargetTabs.splice(adjustedIndex, 0, tab);

            const sourceVersion = sourceGroup.version || 1;
            const updatedSourceGroup: TabGroup = {
              ...sourceGroup,
              tabs: newSourceTabs,
              updatedAt: new Date().toISOString(),
              version: sourceVersion + 1,
            };

            let updatedTargetGroup = targetGroup;
            if (sourceGroupId !== targetGroupId) {
              const targetVersion = targetGroup.version || 1;
              updatedTargetGroup = {
                ...targetGroup,
                tabs: newTargetTabs,
                updatedAt: new Date().toISOString(),
                version: targetVersion + 1,
              };
            }

            let updatedGroups = groups.map(g => {
              if (g.id === sourceGroupId) return updatedSourceGroup;
              if (g.id === targetGroupId) return updatedTargetGroup;
              return g;
            });

            // 自动清理空标签组
            if (
              sourceGroupId !== targetGroupId &&
              updatedSourceGroup &&
              updatedSourceGroup.tabs.length === 0
            ) {
              try {
                if (shouldAutoDeleteAfterTabRemoval(updatedSourceGroup, '')) {
                  console.log(
                    `[拖拽自动清理] 检测到空标签组: ${updatedSourceGroup.name} (ID: ${sourceGroupId})`
                  );

                  updatedGroups = updatedGroups.filter(g => g.id !== sourceGroupId);

                  setTimeout(() => {
                    try {
                      typedDispatch(deleteGroup(sourceGroupId));
                    } catch (deleteError) {
                      console.error(`[拖拽自动清理] 删除Redux状态失败:`, deleteError);
                    }
                  }, 100);

                  console.log(
                    `[拖拽自动清理] 已从存储中移除空标签组: ${updatedSourceGroup.name} (ID: ${sourceGroupId})`
                  );
                }
              } catch (cleanupError) {
                console.error(`[拖拽自动清理] 清理空标签组时发生错误:`, cleanupError);
              }
            }

            await storage.setGroups(updatedGroups);
          }
        } catch (error) {
          console.error('存储标签页移动操作失败:', error);
        }
      });

      return { sourceGroupId, sourceIndex, targetGroupId, targetIndex };
    } catch (error) {
      console.error('移动标签页操作失败:', error);
      throw error;
    }
  }
);
