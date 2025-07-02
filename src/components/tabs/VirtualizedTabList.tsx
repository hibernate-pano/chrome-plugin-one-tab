/**
 * 虚拟化标签列表组件
 * 用于处理大量标签时的性能优化
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { FixedSizeList as List, ListChildComponentProps } from 'react-window';
import { Tab, TabGroup } from '@/types/tab';
import { useAppSelector } from '@/store/hooks'; // 引入 useAppSelector

interface VirtualizedTabListProps {
  tabs: Tab[];
  groups: TabGroup[];
  searchQuery: string;
  onTabClick: (tab: Tab) => void;
  onTabDelete: (tab: Tab) => void;
  onTabMove: (tabId: string, targetGroupId: string) => void;
  itemHeight?: number;
  containerHeight?: number;
}

interface TabListItem {
  type: 'group' | 'tab';
  data: TabGroup | Tab;
  groupId?: string;
  isExpanded?: boolean;
}

export const VirtualizedTabList: React.FC<VirtualizedTabListProps> = ({
  tabs,
  groups,
  searchQuery,
  onTabClick,
  onTabDelete,
  onTabMove,
  itemHeight = 60,
  containerHeight = 600
}) => {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const listRef = useRef<List>(null);

  // 计算显示的项目列表
  const displayItems = useMemo(() => {
    const items: TabListItem[] = [];
    
    if (searchQuery.trim()) {
      // 搜索模式：只显示匹配的标签页
      const filteredTabs = tabs.filter(tab => 
        tab.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        tab.url.toLowerCase().includes(searchQuery.toLowerCase())
      );
      
      filteredTabs.forEach(tab => {
        items.push({
          type: 'tab',
          data: tab,
          groupId: tab.group_id
        });
      });
    } else {
      // 普通模式：显示分组和标签页
      groups.forEach(group => {
        // 添加分组头
        items.push({
          type: 'group',
          data: group,
          isExpanded: expandedGroups.has(group.id)
        });
        
        // 如果分组展开，添加标签页
        if (expandedGroups.has(group.id)) {
          group.tabs.forEach(tab => {
            items.push({
              type: 'tab',
              data: tab,
              groupId: group.id
            });
          });
        }
      });
    }
    
    return items;
  }, [tabs, groups, searchQuery, expandedGroups]);

  // 切换分组展开状态
  const toggleGroup = useCallback((groupId: string) => {
    setExpandedGroups(prev => {
      const newSet = new Set(prev);
      if (newSet.has(groupId)) {
        newSet.delete(groupId);
      } else {
        newSet.add(groupId);
      }
      return newSet;
    });
  }, []);

  // 初始化时展开所有分组
  useEffect(() => {
    if (groups.length > 0 && expandedGroups.size === 0) {
      setExpandedGroups(new Set(groups.map(g => g.id)));
    }
  }, [groups, expandedGroups.size]);

  // 虚拟化列表项渲染器
  const Row = useCallback(({ index, style }: ListChildComponentProps) => {
    const item = displayItems[index];
    
    return (
      <div style={style}>
        {item.type === 'group' ? (
          <GroupHeader
            group={item.data as TabGroup}
            isExpanded={item.isExpanded || false}
            onToggle={() => toggleGroup((item.data as TabGroup).id)}
          />
        ) : (
          <TabItem
            tab={item.data as Tab}
            groupId={item.groupId}
            searchQuery={searchQuery}
            onClick={() => onTabClick(item.data as Tab)}
            onDelete={() => onTabDelete(item.data as Tab)}
            onMove={(targetGroupId) => onTabMove((item.data as Tab).id, targetGroupId)}
          />
        )}
      </div>
    );
  }, [displayItems, searchQuery, toggleGroup, onTabClick, onTabDelete, onTabMove]);

  return (
    <div className="virtualized-tab-list">
      <List
        ref={listRef}
        height={containerHeight}
        itemCount={displayItems.length}
        itemSize={itemHeight}
        width="100%"
        className="scrollbar-thin scrollbar-thumb-gray-300 scrollbar-track-gray-100"
      >
        {Row}
      </List>
    </div>
  );
};

// 分组头组件
interface GroupHeaderProps {
  group: TabGroup;
  isExpanded: boolean;
  onToggle: () => void;
}

const GroupHeader: React.FC<GroupHeaderProps> = ({ group, isExpanded, onToggle }) => {
  return (
    <div 
      className="group-header flex items-center p-3 bg-gray-50 border-b cursor-pointer hover:bg-gray-100 h-full" // Added h-full
      onClick={onToggle}
    >
      <div className="flex items-center flex-1">
        <svg 
          className={`w-4 h-4 mr-2 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          fill="currentColor"
          viewBox="0 0 20 20"
        >
          <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
        </svg>
        
        <h3 className="font-medium text-gray-900 truncate"> {/* Added truncate */}
          {group.name}
        </h3>
        
        <span className="ml-2 px-2 py-1 text-xs bg-blue-100 text-blue-800 rounded">
          {group.tabs.length}
        </span>
        
        {group.isLocked && (
          <svg className="w-4 h-4 ml-2 text-yellow-500" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
          </svg>
        )}
      </div>
      
      <div className="text-xs text-gray-500">
        {new Date(group.createdAt).toLocaleDateString()}
      </div>
    </div>
  );
};

// 标签项组件
interface TabItemProps {
  tab: Tab;
  groupId?: string;
  searchQuery: string;
  onClick: () => void;
  onDelete: () => void;
  onMove: (targetGroupId: string) => void;
}

const TabItem: React.FC<TabItemProps> = ({ 
  tab, 
  groupId, 
  searchQuery, 
  onClick, 
  onDelete, 
  onMove 
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const [showMoveMenu, setShowMoveMenu] = useState(false);
  const { groups } = useAppSelector(state => state.tabs); // Get groups from Redux

  // 高亮搜索关键词
  const highlightText = useCallback((text: string, query: string) => {
    if (!query.trim()) return text;
    
    const regex = new RegExp(`(${query})`, 'gi');
    const parts = text.split(regex);
    
    return parts.map((part, index) => 
      regex.test(part) ? (
        <span key={index} className="bg-yellow-200 font-medium">
          {part}
        </span>
      ) : part
    );
  }, []);

  return (
    <div 
      className="tab-item flex items-center p-3 border-b hover:bg-gray-50 transition-colors h-full" // Added h-full
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* 网站图标 */}
      <div className="flex-shrink-0 w-4 h-4 mr-3">
        {tab.favicon ? (
          <img 
            src={tab.favicon} 
            alt="" 
            className="w-full h-full object-contain"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <div className="w-full h-full bg-gray-300 rounded-sm" />
        )}
      </div>
      
      {/* 标签信息 */}
      <div className="flex-1 min-w-0 cursor-pointer" onClick={onClick}>
        <div className="text-sm font-medium text-gray-900 truncate">
          {highlightText(tab.title, searchQuery)}
        </div>
        <div className="text-xs text-gray-500 truncate">
          {highlightText(tab.url, searchQuery)}
        </div>
      </div>
      
      {/* 操作按钮 */}
      {isHovered && (
        <div className="flex items-center space-x-2 ml-2">
          {/* 移动按钮 */}
          <div className="relative">
            <button
              className="p-1 text-gray-400 hover:text-gray-600 rounded"
              onClick={() => setShowMoveMenu(!showMoveMenu)}
              title="移动到其他分组"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
              </svg>
            </button>
            
            {showMoveMenu && (
              <MoveMenu
                currentGroupId={groupId}
                groups={groups} // Pass groups to MoveMenu
                onMove={onMove}
                onClose={() => setShowMoveMenu(false)}
              />
            )}
          </div>
          
          {/* 删除按钮 */}
          <button
            className="p-1 text-gray-400 hover:text-red-600 rounded"
            onClick={onDelete}
            title="删除标签"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
};

// 移动菜单组件
interface MoveMenuProps {
  currentGroupId?: string;
  groups: TabGroup[]; // Added groups prop
  onMove: (targetGroupId: string) => void;
  onClose: () => void;
}

const MoveMenu: React.FC<MoveMenuProps> = ({ currentGroupId, groups, onMove, onClose }) => {
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.move-menu')) {
        onClose();
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [onClose]);

  return (
    <div className="move-menu absolute right-0 top-full mt-1 w-48 bg-white border rounded-md shadow-lg z-10"> {/* Added move-menu class */}
      <div className="py-1">
        {groups.map((group: TabGroup) => (
          <button
            key={group.id}
            className={`block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 ${
              group.id === currentGroupId ? 'text-gray-400 cursor-not-allowed' : 'text-gray-700'
            }`}
            onClick={() => {
              if (group.id !== currentGroupId) {
                onMove(group.id);
                onClose();
              }
            }}
            disabled={group.id === currentGroupId}
          >
            {group.name}
          </button>
        ))}
      </div>
    </div>
  );
};

// Removed useVirtualizedList hook as it's not used with react-window