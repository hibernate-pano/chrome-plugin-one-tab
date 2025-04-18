// 拖拽项类型
export const DragTypes = {
  GROUP: 'group',
  TAB: 'tab'
};

// 拖拽项数据接口
export interface DragData {
  type: string;
  id: string;
  index: number;
}

// 标签组拖拽数据
export interface GroupDragData extends DragData {
  type: 'group';
  group: any; // 标签组数据
}

// 标签页拖拽数据
export interface TabDragData extends DragData {
  type: 'tab';
  tab: any; // 标签页数据
  groupId: string;
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
