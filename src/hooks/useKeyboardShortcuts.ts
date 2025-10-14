import { useEffect, useCallback } from 'react';

interface KeyboardShortcut {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  action: () => void;
  description: string;
}

/**
 * 键盘快捷键Hook
 * 提供全局键盘快捷键支持
 */
export const useKeyboardShortcuts = (shortcuts: KeyboardShortcut[]) => {
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    // 忽略在输入框中的快捷键
    const target = event.target as HTMLElement;
    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.contentEditable === 'true'
    ) {
      return;
    }

    // 检查每个快捷键
    for (const shortcut of shortcuts) {
      const {
        key,
        ctrlKey = false,
        altKey = false,
        shiftKey = false,
        metaKey = false,
        action
      } = shortcut;

      // 检查按键组合是否匹配
      if (
        event.key.toLowerCase() === key.toLowerCase() &&
        event.ctrlKey === ctrlKey &&
        event.altKey === altKey &&
        event.shiftKey === shiftKey &&
        event.metaKey === metaKey
      ) {
        event.preventDefault();
        action();
        break;
      }
    }
  }, [shortcuts]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);

  return shortcuts.map(s => ({
    key: s.key,
    modifiers: {
      ctrl: s.ctrlKey,
      alt: s.altKey,
      shift: s.shiftKey,
      meta: s.metaKey
    },
    description: s.description
  }));
};

/**
 * 常用的键盘快捷键组合
 */
export const COMMON_SHORTCUTS = {
  SAVE_TABS: {
    key: 's',
    ctrlKey: true,
    description: '保存所有标签页'
  },
  SEARCH: {
    key: 'f',
    ctrlKey: true,
    description: '聚焦搜索框'
  },
  CLEAR_SEARCH: {
    key: 'Escape',
    description: '清空搜索'
  },
  TOGGLE_LAYOUT: {
    key: 'l',
    ctrlKey: true,
    description: '切换布局模式'
  },
  CLEAN_DUPLICATES: {
    key: 'd',
    ctrlKey: true,
    description: '清理重复标签'
  }
} as const;
