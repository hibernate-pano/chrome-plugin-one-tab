// 拖拽项类型
export const ItemTypes = {
  TAB_GROUP: 'tabGroup',
  TAB: 'tab'
};

// 拖拽项接口
export interface DragItem {
  type: string;
  id: string;
  groupId?: string;
  index: number;
}

// 标签组拖拽项
export interface TabGroupDragItem extends DragItem {
  type: typeof ItemTypes.TAB_GROUP;
}

// 标签页拖拽项
export interface TabDragItem extends DragItem {
  type: typeof ItemTypes.TAB;
  groupId: string;
}
