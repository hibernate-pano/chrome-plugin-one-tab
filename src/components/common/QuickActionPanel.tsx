/**
 * 快捷操作面板组件
 * 提供类似VS Code的命令面板功能，支持快捷键操作
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { saveGroup, loadGroups, deleteGroup } from '@/store/slices/tabSlice';
import { TabGroup } from '@/types/tab';

interface QuickAction {
  id: string;
  label: string;
  description?: string;
  icon: string;
  shortcut?: string;
  category: 'tab' | 'group' | 'sync' | 'settings' | 'search';
  action: () => Promise<void> | void;
  enabled?: boolean;
}

interface QuickActionPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export const QuickActionPanel: React.FC<QuickActionPanelProps> = ({ isOpen, onClose }) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  
  const dispatch = useAppDispatch();
  const { groups } = useAppSelector(state => state.tabs);
  const { isAuthenticated } = useAppSelector(state => state.auth);

  // 定义所有可用的快捷操作
  const allActions = useMemo((): QuickAction[] => [
    // 标签页操作
    {
      id: 'save-all-tabs',
      label: '保存所有标签页',
      description: '将当前窗口的所有标签页保存到新分组',
      icon: '💾',
      shortcut: 'Alt+Shift+S',
      category: 'tab',
      action: async () => {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const validTabs = tabs.filter(tab => 
          tab.url && 
          !tab.url.startsWith('chrome://') && 
          !tab.url.startsWith('chrome-extension://')
        );
        
        if (validTabs.length > 0) {
          const groupName = `标签组 ${new Date().toLocaleString()}`;
          const newGroup: TabGroup = {
            id: crypto.randomUUID(),
            name: groupName,
            tabs: validTabs.map(tab => ({
              id: crypto.randomUUID(),
              url: tab.url!,
              title: tab.title || tab.url!,
              favicon: tab.favIconUrl,
              createdAt: new Date().toISOString(),
              lastAccessed: new Date().toISOString()
            })),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            isLocked: false
          };
          
          await dispatch(saveGroup(newGroup));
          
          // 关闭保存的标签页
          const tabIds = validTabs.map(tab => tab.id!).filter(id => id !== undefined);
          if (tabIds.length > 0) {
            await chrome.tabs.remove(tabIds);
          }
        }
      }
    },
    {
      id: 'save-current-tab',
      label: '保存当前标签页',
      description: '将当前活动的标签页保存到新分组',
      icon: '📋',
      shortcut: 'Alt+S',
      category: 'tab',
      action: async () => {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        
        if (activeTab && activeTab.url && 
            !activeTab.url.startsWith('chrome://') && 
            !activeTab.url.startsWith('chrome-extension://')) {
          
          const groupName = `单个标签 ${new Date().toLocaleString()}`;
          const newGroup: TabGroup = {
            id: crypto.randomUUID(),
            name: groupName,
            tabs: [{
              id: crypto.randomUUID(),
              url: activeTab.url,
              title: activeTab.title || activeTab.url,
              favicon: activeTab.favIconUrl,
              createdAt: new Date().toISOString(),
              lastAccessed: new Date().toISOString()
            }],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            isLocked: false
          };
          
          await dispatch(saveGroup(newGroup));
          await chrome.tabs.remove(activeTab.id!);
        }
      }
    },
    // 分组操作
    {
      id: 'create-group',
      label: '创建新分组',
      description: '创建一个空的标签页分组',
      icon: '📁',
      category: 'group',
      action: async () => {
        const groupName = `新分组 ${new Date().toLocaleString()}`;
        const newGroup: TabGroup = {
          id: crypto.randomUUID(),
          name: groupName,
          tabs: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          isLocked: false
        };
        
        await dispatch(saveGroup(newGroup));
      }
    },
    {
      id: 'restore-all-groups',
      label: '恢复所有分组',
      description: '恢复所有标签组中的标签页',
      icon: '🔄',
      category: 'group',
      action: async () => {
        for (const group of groups) {
          if (group.tabs.length > 0) {
            for (const tab of group.tabs) {
              await chrome.tabs.create({ url: tab.url, active: false });
            }
          }
        }
      },
      enabled: groups.length > 0
    },
    {
      id: 'delete-all-groups',
      label: '删除所有分组',
      description: '删除所有标签页分组（不可恢复）',
      icon: '🗑️',
      category: 'group',
      action: async () => {
        if (confirm('确定要删除所有分组吗？此操作不可恢复！')) {
          for (const group of groups) {
            await dispatch(deleteGroup(group.id));
          }
        }
      },
      enabled: groups.length > 0
    },
    // 搜索操作
    {
      id: 'search-tabs',
      label: '搜索标签页',
      description: '在所有保存的标签页中搜索',
      icon: '🔍',
      shortcut: '/',
      category: 'search',
      action: () => {
        // 这里应该打开搜索界面或聚焦到搜索框
        const searchInput = document.querySelector('input[type="search"]') as HTMLInputElement;
        if (searchInput) {
          searchInput.focus();
        }
      }
    },
    {
      id: 'search-by-domain',
      label: '按域名搜索',
      description: '按网站域名搜索标签页',
      icon: '🌐',
      category: 'search',
      action: () => {
        const domain = prompt('请输入域名:');
        if (domain) {
          // 触发域名搜索
          const searchInput = document.querySelector('input[type="search"]') as HTMLInputElement;
          if (searchInput) {
            searchInput.value = `domain:${domain}`;
            searchInput.dispatchEvent(new Event('input', { bubbles: true }));
            searchInput.focus();
          }
        }
      }
    },
    // 同步操作
    {
      id: 'sync-upload',
      label: '上传到云端',
      description: '将本地数据上传到云端',
      icon: '⬆️',
      category: 'sync',
      action: async () => {
        // 这里应该调用同步服务
        console.log('上传到云端');
      },
      enabled: isAuthenticated
    },
    {
      id: 'sync-download',
      label: '从云端下载',
      description: '从云端下载最新数据',
      icon: '⬇️',
      category: 'sync',
      action: async () => {
        // 这里应该调用同步服务
        console.log('从云端下载');
      },
      enabled: isAuthenticated
    },
    // 设置操作
    {
      id: 'toggle-theme',
      label: '切换主题',
      description: '在浅色和深色主题之间切换',
      icon: '🌙',
      category: 'settings',
      action: () => {
        // 这里应该调用主题切换
        document.documentElement.classList.toggle('dark');
      }
    },
    {
      id: 'export-data',
      label: '导出数据',
      description: '将所有数据导出为JSON文件',
      icon: '📤',
      category: 'settings',
      action: async () => {
        const data = {
          groups,
          exportTime: new Date().toISOString(),
          version: '1.5.9'
        };
        
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `onetab-plus-export-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    },
    {
      id: 'import-data',
      label: '导入数据',
      description: '从JSON文件导入数据',
      icon: '📥',
      category: 'settings',
      action: () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (e) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          if (file) {
            const text = await file.text();
            try {
              const data = JSON.parse(text);
              if (data.groups && Array.isArray(data.groups)) {
                for (const group of data.groups) {
                  await dispatch(saveGroup(group));
                }
                alert('数据导入成功！');
              } else {
                alert('文件格式不正确！');
              }
            } catch (error) {
              alert('文件解析失败！');
            }
          }
        };
        input.click();
      }
    },
    {
      id: 'refresh-data',
      label: '刷新数据',
      description: '重新加载所有标签组数据',
      icon: '🔄',
      category: 'settings',
      action: async () => {
        await dispatch(loadGroups());
      }
    }
  ], [dispatch, groups, isAuthenticated]);

  // 根据查询过滤操作
  const filteredActions = useMemo(() => {
    if (!query.trim()) return allActions;
    
    const queryLower = query.toLowerCase();
    return allActions.filter(action => 
      action.label.toLowerCase().includes(queryLower) ||
      action.description?.toLowerCase().includes(queryLower) ||
      action.category.toLowerCase().includes(queryLower)
    );
  }, [allActions, query]);

  // 按类别分组
  const groupedActions = useMemo(() => {
    const groups: Record<string, QuickAction[]> = {};
    
    filteredActions.forEach(action => {
      if (!groups[action.category]) {
        groups[action.category] = [];
      }
      groups[action.category].push(action);
    });
    
    return groups;
  }, [filteredActions]);

  const categoryNames = {
    tab: '标签页操作',
    group: '分组操作',
    search: '搜索功能',
    sync: '云端同步',
    settings: '设置选项'
  };

  // 处理键盘事件
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!isOpen) return;
    
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(prev => 
          prev < filteredActions.length - 1 ? prev + 1 : 0
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(prev => 
          prev > 0 ? prev - 1 : filteredActions.length - 1
        );
        break;
      case 'Enter':
        e.preventDefault();
        if (filteredActions[selectedIndex]) {
          executeAction(filteredActions[selectedIndex]);
        }
        break;
    }
  }, [isOpen, filteredActions, selectedIndex, onClose]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // 重置状态
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // 滚动到选中项
  useEffect(() => {
    if (listRef.current && filteredActions.length > 0) {
      const selectedElement = listRef.current.children[selectedIndex] as HTMLElement;
      if (selectedElement) {
        selectedElement.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedIndex, filteredActions.length]);

  const executeAction = async (action: QuickAction) => {
    try {
      await action.action();
      onClose();
    } catch (error) {
      console.error('执行操作失败:', error);
      alert('操作执行失败，请重试');
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black bg-opacity-50">
      <div className="w-full max-w-lg mx-4 bg-white rounded-lg shadow-2xl">
        {/* 搜索输入框 */}
        <div className="p-4 border-b">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="输入命令或搜索..."
            className="w-full px-3 py-2 text-lg border-none outline-none"
          />
        </div>
        
        {/* 操作列表 */}
        <div 
          ref={listRef}
          className="max-h-96 overflow-y-auto"
        >
          {Object.entries(groupedActions).map(([category, actions]) => (
            <div key={category}>
              <div className="px-4 py-2 text-xs font-medium text-gray-500 bg-gray-50 border-b">
                {categoryNames[category as keyof typeof categoryNames]}
              </div>
              {actions.map((action) => {
                const globalIndex = filteredActions.indexOf(action);
                const isSelected = globalIndex === selectedIndex;
                const isEnabled = action.enabled !== false;
                
                return (
                  <div
                    key={action.id}
                    className={`flex items-center px-4 py-3 cursor-pointer border-b border-gray-100 ${
                      isSelected ? 'bg-blue-50 border-blue-200' : 'hover:bg-gray-50'
                    } ${!isEnabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                    onClick={() => isEnabled && executeAction(action)}
                  >
                    <span className="text-xl mr-3">{action.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-gray-900">
                        {action.label}
                      </div>
                      {action.description && (
                        <div className="text-sm text-gray-500 truncate">
                          {action.description}
                        </div>
                      )}
                    </div>
                    {action.shortcut && (
                      <div className="text-xs text-gray-400 font-mono">
                        {action.shortcut}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          
          {filteredActions.length === 0 && (
            <div className="px-4 py-8 text-center text-gray-500">
              没有找到匹配的操作
            </div>
          )}
        </div>
        
        {/* 提示信息 */}
        <div className="px-4 py-2 text-xs text-gray-400 bg-gray-50 border-t">
          使用 ↑↓ 选择，Enter 执行，Esc 关闭
        </div>
      </div>
    </div>
  );
};

// 快捷键处理Hook
export const useQuickActionPanel = () => {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + K 打开快捷操作面板
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsOpen(true);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  return {
    isOpen,
    openPanel: () => setIsOpen(true),
    closePanel: () => setIsOpen(false)
  };
};
