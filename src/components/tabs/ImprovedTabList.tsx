import React, { useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { loadGroups, moveGroupAndSync, moveTabAndSync, testAction } from '@/store/slices/tabSlice';
import { SearchResultList } from '@/components/search/SearchResultList';
import { SimpleDraggableTabGroup } from '@/components/dnd/SimpleDraggableTabGroup';
import '@/styles/drag-drop.css';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragStartEvent,
  DragEndEvent,
  DragOverEvent,
  UniqueIdentifier,
  pointerWithin
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy
} from '@dnd-kit/sortable';

interface ImprovedTabListProps {
  searchQuery: string;
}

export const ImprovedTabList: React.FC<ImprovedTabListProps> = ({ searchQuery }) => {
  const dispatch = useAppDispatch();
  const groups = useAppSelector((state) => state.tabs.groups) || [];
  const useDoubleColumnLayout = useAppSelector((state) => state.settings.useDoubleColumnLayout);
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [activeData, setActiveData] = useState<any | null>(null);

  useEffect(() => {
    console.log('🔍 ImprovedTabList useEffect - 准备dispatch loadGroups');
    
    // 先测试一个简单的Redux action
    console.log('🔍 测试Redux - 准备dispatch testAction');
    dispatch(testAction());
    
    const result = dispatch(loadGroups());
    console.log('🔍 dispatch返回的Promise:', result);
    
    // 添加Promise状态跟踪
    result
      .then((actionResult) => {
        console.log('🔍 loadGroups Promise resolved:', actionResult);
      })
      .catch((error) => {
        console.error('🔍 loadGroups Promise rejected:', error);
      });
    
    // 直接测试Chrome存储
    chrome.storage.local.get('tab_groups').then(result => {
      console.log('🔍 直接查询Chrome存储结果:', JSON.stringify(result, null, 2));
    });
    
    // 添加调试日志
    console.log('ImprovedTabList 挂载，开始加载标签组数据');
    
    // 监听来自 background 的刷新消息
    const handleMessage = (message: any) => {
      if (message.type === 'REFRESH_TAB_LIST') {
        console.log('收到刷新标签列表的消息，重新加载数据');
        console.log('🔍 收到刷新消息 - 准备dispatch loadGroups');
        dispatch(loadGroups());
      }
    };

    chrome.runtime.onMessage.addListener(handleMessage);
    
    // 添加页面可见性变化监听，当页面重新变为可见时刷新数据
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        console.log('页面变为可见，重新加载标签组数据');
        console.log('🔍 页面可见性变化 - 准备dispatch loadGroups');
        dispatch(loadGroups());
      }
    };
    
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    // 添加定期刷新机制，每10秒检查一次数据更新
    const refreshInterval = setInterval(() => {
      console.log('🔍 定期刷新 - 准备dispatch loadGroups');
      dispatch(loadGroups());
    }, 10000);
    
    return () => {
      chrome.runtime.onMessage.removeListener(handleMessage);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearInterval(refreshInterval);
    };
  }, [dispatch]);

  // 过滤标签组
  const filteredGroups = searchQuery ? [] : (groups || []);

  // 添加调试日志
  useEffect(() => {
    console.log('=== ImprovedTabList 状态更新 ===');
    console.log('Redux groups状态:', {
      groupsIsArray: Array.isArray(groups),
      groupsLength: groups?.length || 0,
      groups: groups,
      filteredGroupsLength: filteredGroups.length,
      searchQuery: searchQuery
    });
    console.log('========================');
  }, [groups, filteredGroups, searchQuery]);

  // 创建标签组ID列表
  const groupIds = filteredGroups.map(group => `group-${group.id}`);

  // 配置拖拽传感器 - 优化灵敏度
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5, // 稍微增加一点距离避免意外拖拽
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // 处理拖拽开始
  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    setActiveId(active.id);
    setActiveData(active.data.current);
  };

  // 处理拖拽悬停 - 简化逻辑，只处理跨组拖拽
  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    
    if (!over) return;
    
    const activeData = active.data.current;
    const overData = over.data.current;
    
    // 只处理标签页拖拽到不同组的情况
    if (activeData?.type === 'tab' && overData?.type === 'tab') {
      const sourceGroupId = activeData.groupId;
      const targetGroupId = overData.groupId;
      
      // 如果是跨组拖拽，才进行预处理
      if (sourceGroupId !== targetGroupId) {
        const sourceIndex = activeData.index;
        const targetIndex = overData.index;
        
        dispatch(moveTabAndSync({
          sourceGroupId,
          sourceIndex,
          targetGroupId,
          targetIndex,
          updateSourceInDrag: false // 不更新源数据，避免状态混乱
        }));
      }
    }
  };

  // 处理拖拽结束
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const activeData = active.data.current;
      const overData = over.data.current;

      // 处理标签页拖拽
      if (activeData?.type === 'tab' && overData?.type === 'tab') {
        const sourceGroupId = activeData.groupId;
        const sourceIndex = activeData.index;
        const targetGroupId = overData.groupId;
        const targetIndex = overData.index;

        // 执行最终的标签页移动
        dispatch(moveTabAndSync({
          sourceGroupId,
          sourceIndex,
          targetGroupId,
          targetIndex,
          updateSourceInDrag: true
        }));
      }
      // 处理标签组拖拽
      else if (activeData?.type === 'group' && overData?.type === 'group') {
        const activeIndex = filteredGroups.findIndex(g => `group-${g.id}` === active.id);
        const overIndex = filteredGroups.findIndex(g => `group-${g.id}` === over.id);

        if (activeIndex !== -1 && overIndex !== -1) {
          // 执行标签组移动
          dispatch(moveGroupAndSync({ dragIndex: activeIndex, hoverIndex: overIndex }));
        }
      }
    }

    // 清理状态
    setActiveId(null);
    setActiveData(null);
  };

  // 渲染拖拽覆盖层
  const renderDragOverlay = () => {
    if (!activeId || !activeData) return null;

    // 渲染标签页覆盖层
    if (activeData.type === 'tab') {
      const tab = activeData.tab;
      return (
        <div className="flex items-center py-2 px-3 bg-white dark:bg-gray-800 border border-blue-400 rounded-lg shadow-lg opacity-90">
          {tab.favicon ? (
            <img src={tab.favicon} alt="" className="w-4 h-4 mr-2 flex-shrink-0" />
          ) : (
            <div className="w-4 h-4 bg-gray-200 dark:bg-gray-600 mr-2 flex-shrink-0 rounded" />
          )}
          <span className="truncate text-sm font-medium">{tab.title}</span>
        </div>
      );
    }
    // 渲染标签组覆盖层
    else if (activeData.type === 'group') {
      const group = activeData.group;
      return (
        <div className="bg-white dark:bg-gray-800 border border-blue-400 rounded-lg shadow-lg p-3 opacity-90">
          <div className="font-medium text-sm">{group.name}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{group.tabs.length} 个标签页</div>
        </div>
      );
    }

    return null;
  };

  return (
    <div className="space-y-2">
      {/* 搜索结果或标签组列表 */}
      {searchQuery ? (
        <SearchResultList searchQuery={searchQuery} />
      ) : filteredGroups.length === 0 ? (
        /* 空状态显示 */
        <div className="flex flex-col items-center justify-center py-12 space-y-4 text-gray-500 dark:text-gray-400">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-16 w-16"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1}
              d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"
            />
          </svg>
          <div className="text-center">
            <h3 className="text-lg font-medium mb-2">还没有保存的标签页</h3>
            <p className="text-sm mb-4">
              点击右上角的"保存所有标签"按钮开始使用，或者使用快捷键：
            </p>
            <div className="space-y-1 text-xs bg-gray-100 dark:bg-gray-800 rounded-lg p-3">
              <div><kbd className="px-2 py-1 bg-gray-200 dark:bg-gray-700 rounded">Alt+Shift+S</kbd> 保存所有标签页</div>
              <div><kbd className="px-2 py-1 bg-gray-200 dark:bg-gray-700 rounded">Alt+S</kbd> 保存当前标签页</div>
              <div><kbd className="px-2 py-1 bg-gray-200 dark:bg-gray-700 rounded">Ctrl+Shift+S</kbd> 打开标签管理器</div>
            </div>
          </div>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          {useDoubleColumnLayout ? (
            // 双栏布局
            <SortableContext items={groupIds} strategy={verticalListSortingStrategy}>
              <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 gap-3">
                {/* 左栏 - 偶数索引的标签组 */}
                <div className="space-y-2">
                  {filteredGroups
                    .filter((_, index) => index % 2 === 0)
                    .map((group) => (
                      <SimpleDraggableTabGroup
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
                    .map((group) => (
                      <SimpleDraggableTabGroup
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
            <SortableContext items={groupIds} strategy={verticalListSortingStrategy}>
              <div className="space-y-2">
                {filteredGroups.map((group, index) => (
                  <SimpleDraggableTabGroup
                    key={group.id}
                    group={group}
                    index={index}
                  />
                ))}
              </div>
            </SortableContext>
          )}

          {/* 拖拽覆盖层 */}
          <DragOverlay
            dropAnimation={{
              duration: 250,
              easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)',
            }}
          >
            {renderDragOverlay()}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
};