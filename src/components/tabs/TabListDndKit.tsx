import React, { useEffect, useState, useRef } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { loadGroups, moveTabAndSync } from '@/store/slices/tabSlice';
import { SearchResultList } from '@/components/search/SearchResultList';
// No need to import TabGroup type as we're not using it directly
import { SortableTabGroup } from '@/components/dnd/SortableTabGroup';
import { DndKitProvider } from '@/components/dnd/DndKitProvider';
import '@/styles/drag-drop.css';
import {
  DragOverlay,
  pointerWithin,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragStartEvent,
  DragEndEvent,
  DragOverEvent,
  MeasuringStrategy,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy, // 使用矩形排序策略，更适合复杂布局
} from '@dnd-kit/sortable';

interface TabListProps {
  searchQuery: string;
}

export const TabListDndKit: React.FC<TabListProps> = ({ searchQuery }) => {
  const dispatch = useAppDispatch();
  const groups = useAppSelector(state => state.tabs.groups);
  const layoutMode = useAppSelector(state => state.settings.layoutMode);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeData, setActiveData] = useState<any | null>(null);

  // 保存拖拽初始状态的引用
  const initialDragState = useRef<{
    sourceGroupId: string | null;
    sourceIndex: number | null;
  }>({ sourceGroupId: null, sourceIndex: null });

  // 使用ref跟踪组件是否已卸载，防止在卸载后更新状态
  const isMounted = useRef(true);

  useEffect(() => {
    // 组件挂载时设置为true
    isMounted.current = true;

    // 组件卸载时设置为false
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    dispatch(loadGroups());
  }, [dispatch]);

  // Filter groups based on search query
  const filteredGroups = searchQuery ? [] : groups;

  // Create a list of sortable group IDs
  const groupIds = filteredGroups.map(group => `group-${group.id}`);

  // 配置拖拽传感器
  const sensors = useSensors(
    useSensor(PointerSensor, {
      // 只需要很小的移动距离就可以触发拖拽，提高灵敏度
      activationConstraint: {
        distance: 3,
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    const activeData = active.data.current;

    // 记录初始拖拽状态
    if (activeData?.type === 'tab') {
      initialDragState.current = {
        sourceGroupId: activeData.groupId,
        sourceIndex: activeData.index,
      };
    }

    // 记录开始拖拽的元素信息
    console.log('[DEBUG] Drag Start:', {
      id: active.id,
      type: activeData?.type,
      groupId: activeData?.groupId,
      index: activeData?.index,
    });

    if (isMounted.current) {
      setActiveId(active.id as string);
      setActiveData(activeData);
    }
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over, delta } = event;

    if (!over || !isMounted.current) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    if (activeId === overId) return;

    const activeData = active.data.current;
    const overData = over.data.current;

    // 如果没有数据，直接返回
    if (!activeData || !overData) return;

    // 处理标签拖拽
    if (activeData.type === 'tab' && overData.type === 'tab') {
      // 始终使用初始拖拽状态，而不是当前可能已经改变的activeData
      const sourceGroupId = initialDragState.current.sourceGroupId || activeData.groupId;
      const sourceIndex =
        initialDragState.current.sourceIndex !== null
          ? initialDragState.current.sourceIndex
          : activeData.index;

      const targetGroupId = overData.groupId;
      const targetIndex = overData.index;

      // 判断是否是同一标签组内的移动
      const isSameGroup = sourceGroupId === targetGroupId;

      // 不重复处理拖拽到自己的情况
      if (isSameGroup && sourceIndex === targetIndex) {
        return;
      }

      // 计算拖动方向
      const direction = delta.y > 0 ? 'down' : delta.y < 0 ? 'up' : 'none';

      console.log('[DEBUG] Drag Over:', {
        sourceGroupId,
        sourceIndex,
        targetGroupId,
        targetIndex,
        isSameGroup,
        direction,
        delta,
      });

      try {
        // 修复：移除拖拽过程中的实时更新，避免状态不一致导致的位置计算错误
        // 同组内移动和跨组移动都只在拖拽结束时进行最终更新
        // 这样可以确保：
        // 1. 拖拽过程中标签页位置保持稳定
        // 2. 避免频繁的状态更新和重渲染
        // 3. 防止中间状态导致的索引计算错误

        // 保留视觉反馈：更新activeData以提供拖拽反馈
        // 不直接修改activeData对象，而是使用setActiveData更新状态
        // 创建新的对象而不是直接修改原对象
        if (isMounted.current) {
          setActiveData({
            ...activeData,
            groupId: targetGroupId,
          });
        }
      } catch (error) {
        console.error('拖拽过程中更新视觉反馈失败:', error);
      }
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over, delta } = event;

    if (!over || !isMounted.current) {
      if (isMounted.current) {
        setActiveId(null);
        setActiveData(null);
      }
      initialDragState.current = { sourceGroupId: null, sourceIndex: null };
      return;
    }

    const activeId = active.id as string;
    const overId = over.id as string;

    if (activeId === overId) {
      if (isMounted.current) {
        setActiveId(null);
        setActiveData(null);
      }
      initialDragState.current = { sourceGroupId: null, sourceIndex: null };
      return;
    }

    const activeData = active.data.current;
    const overData = over.data.current;

    // 如果没有数据，直接返回
    if (!activeData || !overData) {
      if (isMounted.current) {
        setActiveId(null);
        setActiveData(null);
      }
      initialDragState.current = { sourceGroupId: null, sourceIndex: null };
      return;
    }

    // 处理标签拖拽
    if (activeData.type === 'tab' && overData.type === 'tab') {
      // 使用初始拖拽状态，而不是当前可能已经改变的activeData
      const sourceGroupId = initialDragState.current.sourceGroupId || activeData.groupId;
      const sourceIndex =
        initialDragState.current.sourceIndex !== null
          ? initialDragState.current.sourceIndex
          : activeData.index;

      const targetGroupId = overData.groupId;
      const targetIndex = overData.index;

      // 计算拖动方向
      const direction = delta?.y > 0 ? 'down' : delta?.y < 0 ? 'up' : 'none';

      console.log('[DEBUG] Drag End:', {
        sourceGroupId,
        sourceIndex,
        targetGroupId,
        targetIndex,
        direction,
        delta,
      });

      try {
        // 在拖动结束时执行最终更新
        dispatch(
          moveTabAndSync({
            sourceGroupId,
            sourceIndex,
            targetGroupId,
            targetIndex,
            updateSourceInDrag: true,
          })
        );
      } catch (error) {
        console.error('拖拽结束时更新标签位置失败:', error);
      }
    }
    // 标签组拖拽已被禁用，不再处理组拖拽逻辑

    // 清理所有状态
    if (isMounted.current) {
      setActiveId(null);
      setActiveData(null);
    }
    initialDragState.current = { sourceGroupId: null, sourceIndex: null };
  };

  // 渲染拖拽覆盖层
  const renderDragOverlay = () => {
    if (!activeId || !activeData) return null;

    if (activeData.type === 'tab') {
      const { tab } = activeData;
      return (
        <div className="drag-overlay tab-overlay">
          <div className="flex items-center space-x-2 flex-1 min-w-0">
            {tab.favicon ? (
              <img src={tab.favicon} alt="" className="w-4 h-4 flex-shrink-0" />
            ) : (
              <div className="w-4 h-4 bg-gray-200 flex-shrink-0"></div>
            )}
            <div className="truncate text-blue-600 text-sm">{tab.title}</div>
          </div>
        </div>
      );
    }

    // 标签组拖拽已被禁用，不再显示标签组拖拽覆盖层

    return null;
  };

  return (
    <div className="space-y-2">
      {/* 搜索结果或标签组列表 */}
      {searchQuery ? (
        <SearchResultList searchQuery={searchQuery} />
      ) : (
        <DndKitProvider
          sensors={sensors}
          collisionDetection={pointerWithin}
          measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          {layoutMode === 'triple' ? (
            // 三栏布局
            <SortableContext items={groupIds} strategy={rectSortingStrategy}>
              <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 md:gap-5 lg:gap-6">
                {/* 第一栏 - 索引 % 3 === 0 的标签组 */}
                <div className="space-y-2">
                  {filteredGroups
                    .filter((_, index) => index % 3 === 0)
                    .map(group => (
                      <SortableTabGroup
                        key={group.id}
                        group={group}
                        index={filteredGroups.findIndex(g => g.id === group.id)}
                      />
                    ))}
                </div>

                {/* 第二栏 - 索引 % 3 === 1 的标签组 */}
                <div className="space-y-2">
                  {filteredGroups
                    .filter((_, index) => index % 3 === 1)
                    .map(group => (
                      <SortableTabGroup
                        key={group.id}
                        group={group}
                        index={filteredGroups.findIndex(g => g.id === group.id)}
                      />
                    ))}
                </div>

                {/* 第三栏 - 索引 % 3 === 2 的标签组 */}
                <div className="space-y-2">
                  {filteredGroups
                    .filter((_, index) => index % 3 === 2)
                    .map(group => (
                      <SortableTabGroup
                        key={group.id}
                        group={group}
                        index={filteredGroups.findIndex(g => g.id === group.id)}
                      />
                    ))}
                </div>
              </div>
            </SortableContext>
          ) : layoutMode === 'double' ? (
            // 双栏布局
            <SortableContext items={groupIds} strategy={rectSortingStrategy}>
              <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4 md:gap-5">
                {/* 左栏 - 偶数索引的标签组 */}
                <div className="space-y-2">
                  {filteredGroups
                    .filter((_, index) => index % 2 === 0)
                    .map(group => (
                      <SortableTabGroup
                        key={group.id}
                        group={group}
                        index={filteredGroups.findIndex(g => g.id === group.id)}
                      />
                    ))}
                </div>

                {/* 右栏 - 奇数索引的标签组 */}
                <div className="space-y-2">
                  {filteredGroups
                    .filter((_, index) => index % 2 === 1)
                    .map(group => (
                      <SortableTabGroup
                        key={group.id}
                        group={group}
                        index={filteredGroups.findIndex(g => g.id === group.id)}
                      />
                    ))}
                </div>
              </div>
            </SortableContext>
          ) : (
            // 单栏布局
            <SortableContext items={groupIds} strategy={rectSortingStrategy}>
              <div className="space-y-2">
                {filteredGroups.map((group, index) => (
                  <SortableTabGroup key={group.id} group={group} index={index} />
                ))}
              </div>
            </SortableContext>
          )}

          {/* Drag Overlay - 添加平滑动画 */}
          <DragOverlay
            dropAnimation={{
              duration: 150,
              easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)',
            }}
          >
            {renderDragOverlay()}
          </DragOverlay>
        </DndKitProvider>
      )}
    </div>
  );
};
