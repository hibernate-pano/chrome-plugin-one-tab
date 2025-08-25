/**
 * 拖拽类型枚举
 */
export enum DragType {
  GROUP = 'group',
  TAB = 'tab',
  MULTIPLE_TABS = 'multiple_tabs',
  EXTERNAL_LINK = 'external_link'
}

/**
 * 拖拽项基础接口
 */
export interface BaseDragData<T = any> {
  type: DragType;
  id: string;
  index: number;
  data: T;
  metadata?: Record<string, any>;
}

/**
 * 标签组拖拽数据
 */
export interface GroupDragData extends BaseDragData {
  type: DragType.GROUP;
  data: {
    id: string;
    name: string;
    tabCount: number;
    isLocked: boolean;
    createdAt: string;
  };
}

/**
 * 标签页拖拽数据
 */
export interface TabDragData extends BaseDragData {
  type: DragType.TAB;
  data: {
    id: string;
    url: string;
    title: string;
    favicon?: string;
    groupId: string;
    createdAt: string;
  };
  groupId: string;
}

/**
 * 多标签拖拽数据
 */
export interface MultipleTabsDragData extends BaseDragData {
  type: DragType.MULTIPLE_TABS;
  data: {
    tabs: Array<{
      id: string;
      url: string;
      title: string;
      favicon?: string;
    }>;
    sourceGroupId: string;
    count: number;
  };
}

/**
 * 外部链接拖拽数据
 */
export interface ExternalLinkDragData extends BaseDragData {
  type: DragType.EXTERNAL_LINK;
  data: {
    url: string;
    title?: string;
    favicon?: string;
  };
}

// 为了兼容旧代码，保留旧的类型定义
export const ItemTypes = {
  TAB_GROUP: 'tabGroup',
  TAB: 'tab'
};

export interface DragItem {
  type: string;
  id: string;
  groupId?: string;
  index: number;
}

export interface TabGroupDragItem extends DragItem {
  type: typeof ItemTypes.TAB_GROUP;
}

export interface TabDragItem extends DragItem {
  type: typeof ItemTypes.TAB;
  groupId: string;
}

/**
 * 新的类型定义
 */

/**
 * 拖拽数据联合类型
 */
export type DragData = GroupDragData | TabDragData | MultipleTabsDragData | ExternalLinkDragData;

/**
 * 拖拽位置信息
 */
export interface DragPosition {
  x: number;
  y: number;
  clientX: number;
  clientY: number;
  pageX: number;
  pageY: number;
}

/**
 * 拖拽区域信息
 */
export interface DropZone {
  id: string;
  type: DragType | DragType[];
  accepts: (dragData: DragData) => boolean;
  bounds: DOMRect;
  isActive: boolean;
  isOver: boolean;
  canDrop: boolean;
}

/**
 * 拖拽结果接口
 */
export interface DragResult<T = any> {
  success: boolean;
  action: 'move' | 'copy' | 'link' | 'none';
  sourceIndex: number;
  targetIndex: number;
  sourceGroupId?: string;
  targetGroupId?: string;
  dragData: DragData;
  dropZone: DropZone;
  metadata?: T;
}

/**
 * 拖拽事件接口
 */
export interface DragEvent<T = DragData> {
  type: 'dragstart' | 'dragend' | 'dragover' | 'drop' | 'dragenter' | 'dragleave';
  dragData: T;
  position: DragPosition;
  target: Element | null;
  preventDefault: () => void;
  stopPropagation: () => void;
}

/**
 * 拖拽配置接口
 */
export interface DragConfig {
  enabled: boolean;
  dragThreshold: number; // 开始拖拽的最小距离
  dragDelay: number; // 开始拖拽的延迟时间
  ghostOpacity: number; // 拖拽时的透明度
  snapToGrid: boolean; // 是否对齐网格
  gridSize: number; // 网格大小
  constrainToParent: boolean; // 是否限制在父元素内
  autoScroll: boolean; // 是否自动滚动
  scrollSpeed: number; // 滚动速度
  scrollSensitivity: number; // 滚动敏感度
}

/**
 * 拖拽状态接口
 */
export interface DragState {
  isDragging: boolean;
  dragData: DragData | null;
  dragPosition: DragPosition | null;
  activeDropZone: DropZone | null;
  canDrop: boolean;
  dragPreview: HTMLElement | null;
}

/**
 * 拖拽处理器接口
 */
export interface DragHandlers {
  onDragStart?: (event: DragEvent) => void | boolean;
  onDragEnd?: (event: DragEvent, result: DragResult) => void;
  onDragOver?: (event: DragEvent) => void;
  onDrop?: (event: DragEvent) => DragResult | Promise<DragResult>;
  onDragEnter?: (event: DragEvent) => void;
  onDragLeave?: (event: DragEvent) => void;
}
