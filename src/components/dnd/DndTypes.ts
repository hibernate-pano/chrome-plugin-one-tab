// 拖拽项数据接口
export interface DragData {
  type: string;
  id: string;
  index: number;
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

export interface TabDragItem extends DragItem {
  type: typeof ItemTypes.TAB;
  groupId: string;
}
