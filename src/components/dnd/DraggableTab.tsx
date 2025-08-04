import React, { useRef, useCallback, useMemo } from 'react'; // Removed useState
import { useDrag, useDrop } from 'react-dnd';
import { Tab } from '@/types/tab';
import { ItemTypes, TabDragItem } from './DndTypes';
import { throttle } from 'lodash';
import { SafeFavicon } from '@/components/common/SafeFavicon';
// Removed TabPreview import
// import TabPreview from '@/components/tabs/TabPreview';

interface DraggableTabProps {
  tab: Tab;
  groupId: string;
  index: number;
  moveTab: (sourceGroupId: string, sourceIndex: number, targetGroupId: string, targetIndex: number) => void;
  handleOpenTab: (tab: Tab) => void;
  handleDeleteTab: (tabId: string) => void;
}

/**
 * 可拖拽的标签页组件
 * 使用React.memo优化渲染性能，只有在必要时才重新渲染
 * 实现了拖拽功能，可以在标签组内或跨标签组移动标签页
 */
export const DraggableTab: React.FC<DraggableTabProps> = React.memo(({
  tab,
  groupId,
  index,
  moveTab,
  handleOpenTab,
  handleDeleteTab
}) => {
  const ref = useRef<HTMLDivElement>(null);

  // Removed TabPreview state
  // const [showPreview, setShowPreview] = useState(false);
  // const [previewPosition, setPreviewPosition] = useState({ x: 0, y: 0 });

  // 使用throttle包装moveTab函数，减少拖拽过程中的频繁更新
  // 增加节流时间到100ms，进一步减少更新频率
  const throttledMoveTab = useMemo(
    () => throttle((sourceGroupId, sourceIndex, targetGroupId, targetIndex) => {
      moveTab(sourceGroupId, sourceIndex, targetGroupId, targetIndex);
    }, 100), // 100ms的节流时间，减少状态更新频率
    [moveTab]
  );

  // 拖拽源配置
  const [{ isDragging }, drag] = useDrag({
    type: ItemTypes.TAB,
    item: { type: ItemTypes.TAB, id: tab.id, groupId, index } as TabDragItem,
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
    // 添加拖拽开始和结束的回调函数，可以用于添加额外的视觉效果
    end: (_, monitor) => {
      // 拖拽结束时，如果没有放置到有效目标，可以添加动画效果
      if (!monitor.didDrop()) {
        // 这里可以添加"弹回"动画效果的逻辑
        const element = ref.current;
        if (element) {
          // 添加一个临时的过渡效果类
          element.classList.add('tab-drag-return');
          // 一段时间后移除该类
          setTimeout(() => {
            element.classList.remove('tab-drag-return');
          }, 300);
        }
      }
    }
  });

  // 放置目标配置
  const [{ isOver, canDrop }, drop] = useDrop({
    accept: ItemTypes.TAB,
    hover: (item: TabDragItem, monitor) => {
      if (!ref.current) {
        return;
      }

      const sourceGroupId = item.groupId;
      const sourceIndex = item.index;
      const targetGroupId = groupId;
      const targetIndex = index;

      // 如果拖拽的是自己，不做任何操作
      if (sourceGroupId === targetGroupId && sourceIndex === targetIndex) {
        return;
      }

      // 确定鼠标位置
      const hoverBoundingRect = ref.current.getBoundingClientRect();
      const hoverMiddleY = (hoverBoundingRect.bottom - hoverBoundingRect.top) / 2;
      const clientOffset = monitor.getClientOffset();
      const hoverClientY = clientOffset!.y - hoverBoundingRect.top;

      // 计算鼠标位置相对于目标中心的百分比，用于更平滑的拖拽体验
      const hoverPercentage = (hoverClientY - hoverMiddleY) / hoverMiddleY;

      // 使用百分比阈值，而不是简单的中点判断，提供更自然的拖拽体验
      // 只有当鼠标超过目标中心一定比例时才移动
      const threshold = 0.2; // 20%的阈值

      // 向上拖动时，只有当鼠标超过目标中心向上threshold比例时才移动
      if (sourceGroupId === targetGroupId && sourceIndex < targetIndex && hoverPercentage < -threshold) {
        return;
      }

      // 向下拖动时，只有当鼠标超过目标中心向下threshold比例时才移动
      if (sourceGroupId === targetGroupId && sourceIndex > targetIndex && hoverPercentage > threshold) {
        return;
      }

      // 使用节流版本的移动函数，减少频繁更新
      throttledMoveTab(sourceGroupId, sourceIndex, targetGroupId, targetIndex);

      // 更新拖拽项的索引和组ID
      item.index = targetIndex;
      item.groupId = targetGroupId;
    },
    collect: (monitor) => ({
      isOver: monitor.isOver(),
      canDrop: monitor.canDrop(),
    }),
  });

  // 将拖拽源和放置目标应用到同一个元素
  drag(drop(ref));

  // 使用useMemo记忆化标签页标题，避免不必要的重新渲染
  const tabTitle = useMemo(() => tab.title, [tab.title]);

  // 使用useCallback记忆化点击处理函数
  const handleTabClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    handleOpenTab(tab);
  }, [handleOpenTab, tab]);

  const handleDelete = useCallback(() => {
    handleDeleteTab(tab.id);
  }, [handleDeleteTab, tab.id]);

  // 使用useMemo记忆化样式类，避免不必要的字符串拼接操作
  const tabClasses = useMemo(() => {
    // 基础样式类
    const baseClasses = 'flex items-center py-1 px-2 bg-white dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 rounded';

    // 过渡效果，增强动画流畅度
    const transitionClasses = 'transition-all duration-200 ease-in-out';

    // 拖拽状态样式类
    const dragClasses = isDragging
      ? 'opacity-50 scale-105 border-dashed border border-primary-400 shadow-md z-10'
      : '';

    // 放置目标样式类，增强视觉反馈
    const dropClasses = isOver && canDrop
      ? 'bg-primary-50 dark:bg-primary-900/20 border border-primary-300 dark:border-primary-700'
      : '';

    return `${baseClasses} ${transitionClasses} ${dragClasses} ${dropClasses}`;
  }, [isDragging, isOver, canDrop]);

  // Removed mouse event handlers for preview
  // const handleMouseEnter = useCallback(() => {
  //   if (isDragging) return; // 拖拽过程中不显示预览
  //   setShowPreview(true);
  // }, [isDragging]);

  // const handleMouseMove = useCallback((e: React.MouseEvent) => {
  //   if (isDragging) return; // 拖拽过程中不更新预览位置
  //   setPreviewPosition({ x: e.clientX, y: e.clientY });
  // }, [isDragging]);

  // const handleMouseLeave = useCallback(() => {
  //   setShowPreview(false);
  // }, []);

  return (
    <>
      <div
        ref={ref}
        className={`${tabClasses} tab-drag-animation ${isDragging ? 'dragging' : ''} ${isOver && canDrop ? 'drop-target-animation active' : ''}`}
        style={{
          cursor: 'move'
        }}
      // Removed mouse event handlers for preview
      // onMouseEnter={handleMouseEnter}
      // onMouseMove={handleMouseMove}
      // onMouseLeave={handleMouseLeave}
      >
        <div className="flex items-center space-x-2 flex-1 min-w-0">
          <SafeFavicon src={tab.favicon} alt="" />
          <a
            href="#"
            className="truncate text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 hover:underline text-sm"
            onClick={handleTabClick}
            title={tabTitle}
          >
            {tabTitle}
          </a>
        </div>
        <button
          onClick={handleDelete}
          className="ml-2 p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-500 dark:text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors duration-150 flex-shrink-0"
          title="删除标签页"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      {/* Removed TabPreview component */}
      {/* {showPreview && (
        <TabPreview 
          tab={tab} 
          visible={showPreview} 
          position={previewPosition} 
        />
      )} */}
    </>
  );
}, (prevProps, nextProps) => {
  // 优化重渲染逻辑，只有在以下情况下才重新渲染：
  // 1. 标签ID变化
  // 2. 标签标题变化
  // 3. 标签URL变化
  // 4. 标签图标变化
  // 5. 标签组ID变化
  // 6. 标签索引变化
  // 7. 标签更新时间变化

  // 首先比较基本属性
  const basicPropsEqual =
    prevProps.tab.id === nextProps.tab.id &&
    prevProps.groupId === nextProps.groupId &&
    prevProps.index === nextProps.index;

  // 如果基本属性不相等，则需要重新渲染
  if (!basicPropsEqual) return false;

  // 然后比较标签内容属性
  const tabContentEqual =
    prevProps.tab.title === nextProps.tab.title &&
    prevProps.tab.url === nextProps.tab.url &&
    prevProps.tab.favicon === nextProps.tab.favicon &&
    prevProps.tab.lastAccessed === nextProps.tab.lastAccessed;

  // 如果标签内容不相等，则需要重新渲染
  if (!tabContentEqual) return false;

  // 最后比较回调函数引用
  // 注意：这里我们假设回调函数是稳定的（通过父组件的useCallback记忆化）
  // 如果回调函数引用频繁变化，可能需要移除这部分比较
  const callbacksEqual =
    prevProps.moveTab === nextProps.moveTab &&
    prevProps.handleOpenTab === nextProps.handleOpenTab &&
    prevProps.handleDeleteTab === nextProps.handleDeleteTab;

  return callbacksEqual;
});
