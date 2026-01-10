/**
 * 选择状态上下文
 * 
 * 管理标签页的多选状态，支持：
 * 1. Ctrl/Cmd + 点击：切换单个选择
 * 2. Shift + 点击：范围选择
 * 3. 全选/取消全选
 */

import React, { createContext, useContext, useReducer, useCallback, useMemo } from 'react';

/**
 * 选择状态
 */
interface SelectionState {
  selectedIds: Set<string>;
  lastSelectedId: string | null;
  anchorId: string | null;  // 范围选择的锚点
}

/**
 * 选择操作类型
 */
type SelectionAction =
  | { type: 'TOGGLE_SELECT'; id: string }
  | { type: 'RANGE_SELECT'; id: string; allIds: string[] }
  | { type: 'SELECT_ALL'; ids: string[] }
  | { type: 'CLEAR_SELECTION' }
  | { type: 'SET_SELECTION'; ids: string[] };

/**
 * 选择上下文值
 */
interface SelectionContextValue {
  selectedIds: Set<string>;
  selectedCount: number;
  lastSelectedId: string | null;
  
  // 操作方法
  toggleSelect: (id: string) => void;
  rangeSelect: (id: string, allIds: string[]) => void;
  selectAll: (ids: string[]) => void;
  clearSelection: () => void;
  setSelection: (ids: string[]) => void;
  isSelected: (id: string) => boolean;
  
  // 辅助方法
  handleClick: (id: string, event: React.MouseEvent, allIds: string[]) => void;
}

const initialState: SelectionState = {
  selectedIds: new Set(),
  lastSelectedId: null,
  anchorId: null,
};

/**
 * 选择状态 reducer
 */
function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
  switch (action.type) {
    case 'TOGGLE_SELECT': {
      const newSelected = new Set(state.selectedIds);
      if (newSelected.has(action.id)) {
        newSelected.delete(action.id);
      } else {
        newSelected.add(action.id);
      }
      return {
        selectedIds: newSelected,
        lastSelectedId: action.id,
        anchorId: action.id,
      };
    }

    case 'RANGE_SELECT': {
      const { id, allIds } = action;
      const anchorId = state.anchorId || state.lastSelectedId;
      
      if (!anchorId) {
        // 没有锚点，当作普通选择
        const newSelected = new Set(state.selectedIds);
        newSelected.add(id);
        return {
          selectedIds: newSelected,
          lastSelectedId: id,
          anchorId: id,
        };
      }

      // 找到锚点和目标的索引
      const anchorIndex = allIds.indexOf(anchorId);
      const targetIndex = allIds.indexOf(id);

      if (anchorIndex === -1 || targetIndex === -1) {
        return state;
      }

      // 选择范围内的所有项
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      const rangeIds = allIds.slice(start, end + 1);

      const newSelected = new Set(state.selectedIds);
      rangeIds.forEach(rangeId => newSelected.add(rangeId));

      return {
        selectedIds: newSelected,
        lastSelectedId: id,
        anchorId: state.anchorId, // 保持锚点不变
      };
    }

    case 'SELECT_ALL': {
      return {
        selectedIds: new Set(action.ids),
        lastSelectedId: action.ids[action.ids.length - 1] || null,
        anchorId: action.ids[0] || null,
      };
    }

    case 'CLEAR_SELECTION': {
      return initialState;
    }

    case 'SET_SELECTION': {
      return {
        selectedIds: new Set(action.ids),
        lastSelectedId: action.ids[action.ids.length - 1] || null,
        anchorId: action.ids[0] || null,
      };
    }

    default:
      return state;
  }
}

// 创建上下文
const SelectionContext = createContext<SelectionContextValue | null>(null);

/**
 * 选择状态提供者
 */
export const SelectionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer(selectionReducer, initialState);

  const toggleSelect = useCallback((id: string) => {
    dispatch({ type: 'TOGGLE_SELECT', id });
  }, []);

  const rangeSelect = useCallback((id: string, allIds: string[]) => {
    dispatch({ type: 'RANGE_SELECT', id, allIds });
  }, []);

  const selectAll = useCallback((ids: string[]) => {
    dispatch({ type: 'SELECT_ALL', ids });
  }, []);

  const clearSelection = useCallback(() => {
    dispatch({ type: 'CLEAR_SELECTION' });
  }, []);

  const setSelection = useCallback((ids: string[]) => {
    dispatch({ type: 'SET_SELECTION', ids });
  }, []);

  const isSelected = useCallback((id: string) => {
    return state.selectedIds.has(id);
  }, [state.selectedIds]);

  // 处理点击事件，根据修饰键决定行为
  const handleClick = useCallback((id: string, event: React.MouseEvent, allIds: string[]) => {
    const isCtrlOrCmd = event.ctrlKey || event.metaKey;
    const isShift = event.shiftKey;

    if (isShift) {
      rangeSelect(id, allIds);
    } else if (isCtrlOrCmd) {
      toggleSelect(id);
    } else {
      // 普通点击，清除其他选择，只选中当前项
      setSelection([id]);
    }
  }, [rangeSelect, toggleSelect, setSelection]);

  const value = useMemo<SelectionContextValue>(() => ({
    selectedIds: state.selectedIds,
    selectedCount: state.selectedIds.size,
    lastSelectedId: state.lastSelectedId,
    toggleSelect,
    rangeSelect,
    selectAll,
    clearSelection,
    setSelection,
    isSelected,
    handleClick,
  }), [
    state.selectedIds,
    state.lastSelectedId,
    toggleSelect,
    rangeSelect,
    selectAll,
    clearSelection,
    setSelection,
    isSelected,
    handleClick,
  ]);

  return (
    <SelectionContext.Provider value={value}>
      {children}
    </SelectionContext.Provider>
  );
};

/**
 * 默认的空选择上下文值（用于 Provider 外部的安全降级）
 */
const defaultSelectionValue: SelectionContextValue = {
  selectedIds: new Set(),
  selectedCount: 0,
  lastSelectedId: null,
  toggleSelect: () => {},
  rangeSelect: () => {},
  selectAll: () => {},
  clearSelection: () => {},
  setSelection: () => {},
  isSelected: () => false,
  handleClick: () => {},
};

/**
 * 使用选择状态的 Hook
 * 如果在 SelectionProvider 外部调用，返回默认的空值而不是抛出错误
 */
export function useSelection(): SelectionContextValue {
  const context = useContext(SelectionContext);
  // 安全降级：如果没有 Provider，返回默认值而不是抛出错误
  return context ?? defaultSelectionValue;
}

/**
 * 检查是否有选中项的 Hook
 */
export function useHasSelection(): boolean {
  const { selectedCount } = useSelection();
  return selectedCount > 0;
}

export default SelectionContext;
