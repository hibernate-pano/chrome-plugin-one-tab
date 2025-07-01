import React, { useState, useEffect, useMemo } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { updateGroup } from '@/store/slices/tabSlice';
import { TabGroup, Tab } from '@/types/tab';
import { VirtualizedTabList } from './VirtualizedTabListFixed';
import { QuickActionPanel, useQuickActionPanel } from '../common/QuickActionPanelFixed';
import { enhancedSearchService, smartTabAnalyzer } from '@/services/smartTabAnalyzerFixed';

/**
 * 增强型标签列表组件
 * 集成虚拟化列表、智能搜索、快捷操作等功能
 */

interface EnhancedTabListProps {
  className?: string;
}

export const EnhancedTabList: React.FC<EnhancedTabListProps> = ({ className = '' }) => {
  const dispatch = useAppDispatch();
  const { groups, searchQuery: reduxSearchQuery } = useAppSelector(state => state.tabs);
  const [localSearchQuery, setLocalSearchQuery] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [groupSuggestions, setGroupSuggestions] = useState<any[]>([]);
  
  const { isOpen: isQuickActionOpen, openPanel, closePanel } = useQuickActionPanel();

  // 合并所有标签页
  const allTabs = useMemo(() => {
    return groups.flatMap(group => 
      group.tabs.map(tab => ({ ...tab, group_id: group.id }))
    );
  }, [groups]);

  // 搜索结果
  const [searchResults, setSearchResults] = useState<Tab[]>([]);
  const searchQuery = reduxSearchQuery || localSearchQuery;

  // 执行搜索
  useEffect(() => {
    const performSearch = async () => {
      if (searchQuery.trim()) {
        const results = await enhancedSearchService.search(allTabs, searchQuery);
        setSearchResults(results.map(r => r.tab));
      } else {
        setSearchResults([]);
      }
    };

    performSearch();
  }, [searchQuery, allTabs]);

  // 生成智能分组建议
  useEffect(() => {
    const generateSuggestions = async () => {
      if (allTabs.length > 0) {
        const suggestions = await smartTabAnalyzer.suggestGroups(allTabs);
        setGroupSuggestions(suggestions);
      }
    };

    generateSuggestions();
  }, [allTabs]);

  // 处理标签点击
  const handleTabClick = async (tab: Tab) => {
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      try {
        await chrome.tabs.create({ url: tab.url });
      } catch (error) {
        console.error('打开标签页失败:', error);
      }
    }
  };

  // 处理标签删除
  const handleTabDelete = async (tab: Tab) => {
    if (confirm('确定要删除这个标签页吗？')) {
      const group = groups.find(g => g.tabs.some(t => t.id === tab.id));
      if (group) {
        const updatedGroup = {
          ...group,
          tabs: group.tabs.filter(t => t.id !== tab.id),
          updatedAt: new Date().toISOString()
        };
        await dispatch(updateGroup(updatedGroup));
      }
    }
  };

  // 处理标签移动
  const handleTabMove = async (tabId: string, targetGroupId: string) => {
    // 找到源分组和目标分组
    const sourceGroup = groups.find(g => g.tabs.some(t => t.id === tabId));
    const targetGroup = groups.find(g => g.id === targetGroupId);
    
    if (sourceGroup && targetGroup && sourceGroup.id !== targetGroupId) {
      const tabToMove = sourceGroup.tabs.find(t => t.id === tabId);
      if (tabToMove) {
        // 从源分组移除
        const updatedSourceGroup = {
          ...sourceGroup,
          tabs: sourceGroup.tabs.filter(t => t.id !== tabId),
          updatedAt: new Date().toISOString()
        };
        
        // 添加到目标分组
        const updatedTargetGroup = {
          ...targetGroup,
          tabs: [...targetGroup.tabs, tabToMove],
          updatedAt: new Date().toISOString()
        };
        
        // 更新两个分组
        await Promise.all([
          dispatch(updateGroup(updatedSourceGroup)),
          dispatch(updateGroup(updatedTargetGroup))
        ]);
      }
    }
  };

  // 应用智能分组建议
  const applySuggestion = async (suggestion: any) => {
    if (confirm(`确定要创建分组"${suggestion.name}"吗？`)) {
      const newGroup: TabGroup = {
        id: crypto.randomUUID(),
        name: suggestion.name,
        tabs: suggestion.tabs,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isLocked: false
      };
      
      // 这里应该调用 saveGroup action
      console.log('创建新分组:', newGroup);
    }
  };

  // 键盘快捷键处理
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 搜索快捷键
      if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const searchInput = document.querySelector('#tab-search') as HTMLInputElement;
        if (searchInput) {
          searchInput.focus();
        }
      }
      
      // 快捷操作面板
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        openPanel();
      }
      
      // 切换分组建议
      if ((e.ctrlKey || e.metaKey) && e.key === 'g') {
        e.preventDefault();
        setShowSuggestions(!showSuggestions);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [openPanel, showSuggestions]);

  return (
    <div className={`enhanced-tab-list ${className}`}>
      {/* 搜索框 */}
      <div className="p-4 border-b bg-white sticky top-0 z-10">
        <div className="relative">
          <input
            id="tab-search"
            type="search"
            value={localSearchQuery}
            onChange={(e) => setLocalSearchQuery(e.target.value)}
            placeholder="搜索标签页... (支持 domain:, category:, /regex/)"
            className="w-full px-4 py-2 pl-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <svg 
            className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400"
            fill="none" 
            stroke="currentColor" 
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        
        {/* 搜索统计 */}
        {searchQuery && (
          <div className="mt-2 text-sm text-gray-500">
            找到 {searchResults.length} 个标签页
          </div>
        )}
      </div>

      {/* 智能分组建议 */}
      {showSuggestions && groupSuggestions.length > 0 && (
        <div className="p-4 bg-blue-50 border-b">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-medium text-blue-900">智能分组建议</h3>
            <button
              onClick={() => setShowSuggestions(false)}
              className="text-blue-600 hover:text-blue-800"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          
          <div className="space-y-2">
            {groupSuggestions.map((suggestion, index) => (
              <div
                key={index}
                className="flex items-center justify-between p-3 bg-white rounded-lg border"
              >
                <div className="flex-1">
                  <div className="font-medium text-gray-900">{suggestion.name}</div>
                  <div className="text-sm text-gray-500">{suggestion.description}</div>
                  <div className="text-xs text-blue-600">
                    置信度: {Math.round(suggestion.confidence * 100)}%
                  </div>
                </div>
                <button
                  onClick={() => applySuggestion(suggestion)}
                  className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
                >
                  应用
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 工具栏 */}
      <div className="flex items-center justify-between p-4 bg-gray-50 border-b">
        <div className="flex items-center space-x-4">
          <span className="text-sm text-gray-600">
            {groups.length} 个分组，{allTabs.length} 个标签页
          </span>
          
          {groupSuggestions.length > 0 && (
            <button
              onClick={() => setShowSuggestions(!showSuggestions)}
              className={`px-3 py-1 text-sm rounded ${
                showSuggestions 
                  ? 'bg-blue-600 text-white' 
                  : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
              }`}
            >
              智能建议 ({groupSuggestions.length})
            </button>
          )}
        </div>
        
        <div className="flex items-center space-x-2">
          <button
            onClick={openPanel}
            className="px-3 py-1 text-sm bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
            title="快捷操作 (Ctrl+K)"
          >
            ⌘K
          </button>
        </div>
      </div>

      {/* 标签列表 */}
      <div className="flex-1">
        <VirtualizedTabList
          tabs={searchQuery ? searchResults : allTabs}
          groups={groups}
          searchQuery={searchQuery}
          onTabClick={handleTabClick}
          onTabDelete={handleTabDelete}
          onTabMove={handleTabMove}
          containerHeight={600}
        />
      </div>

      {/* 快捷操作面板 */}
      <QuickActionPanel
        isOpen={isQuickActionOpen}
        onClose={closePanel}
      />

      {/* 键盘快捷键提示 */}
      <div className="p-2 bg-gray-100 border-t text-xs text-gray-500">
        快捷键: / 搜索 • Ctrl+K 操作面板 • Ctrl+G 切换建议
      </div>
    </div>
  );
};
