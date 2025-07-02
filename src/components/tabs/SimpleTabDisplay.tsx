import React from 'react';
import { useAppSelector } from '@/store/hooks';
import { TabGroup, Tab } from '@/types/tab';

/**
 * 简单标签列表组件
 * 用于演示集成的基本功能
 */

interface SimpleTabDisplayProps {
  searchQuery?: string;
  className?: string;
}

export const SimpleTabDisplay: React.FC<SimpleTabDisplayProps> = ({ 
  searchQuery = '',
  className = '' 
}) => {
  const { groups, isLoading } = useAppSelector(state => state.tabs);

  // 过滤标签组
  const filteredGroups = groups.filter(group => 
    searchQuery === '' || 
    group.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    group.tabs.some(tab => 
      tab.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      tab.url.toLowerCase().includes(searchQuery.toLowerCase())
    )
  );

  if (isLoading) {
    return (
      <div className={`p-6 ${className}`}>
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          <span className="ml-3 text-gray-600">正在加载标签页...</span>
        </div>
      </div>
    );
  }

  if (filteredGroups.length === 0) {
    return (
      <div className={`p-6 ${className}`}>
        <div className="text-center py-12">
          <div className="text-gray-400 mb-4">
            <svg className="w-16 h-16 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-gray-900 mb-2">
            {searchQuery ? '没有找到匹配的标签页' : '还没有保存的标签页'}
          </h3>
          <p className="text-gray-500">
            {searchQuery ? '尝试使用不同的搜索关键词' : '点击 "保存标签页" 开始使用'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`p-4 ${className}`}>
      <div className="space-y-4">
        {filteredGroups.map((group: TabGroup) => (
          <GroupCard key={group.id} group={group} />
        ))}
      </div>
    </div>
  );
};

interface GroupCardProps {
  group: TabGroup;
}

const GroupCard: React.FC<GroupCardProps> = ({ group }) => {
  const [isExpanded, setIsExpanded] = React.useState(true);

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200">
      {/* 组头部 */}
      <div 
        className="px-4 py-3 border-b border-gray-100 cursor-pointer hover:bg-gray-50 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center">
            <button className="mr-2 p-1 hover:bg-gray-200 rounded">
              <svg 
                className={`w-4 h-4 transform transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                fill="none" 
                stroke="currentColor" 
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
            <h3 className="text-sm font-medium text-gray-900">{group.name}</h3>
            <span className="ml-2 px-2 py-1 text-xs bg-gray-100 text-gray-600 rounded">
              {group.tabs.length} 个标签页
            </span>
          </div>
          <div className="text-xs text-gray-500">
            {new Date(group.createdAt).toLocaleDateString()}
          </div>
        </div>
      </div>

      {/* 标签页列表 */}
      {isExpanded && (
        <div className="p-2">
          <div className="space-y-1">
            {group.tabs.map((tab) => (
              <TabItem key={tab.id} tab={tab} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

interface TabItemProps {
  tab: Tab;
}

const TabItem: React.FC<TabItemProps> = ({ tab }) => {
  const handleClick = () => {
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      chrome.tabs.create({ url: tab.url });
    } else {
      window.open(tab.url, '_blank');
    }
  };

  return (
    <div 
      className="flex items-center p-2 hover:bg-gray-50 rounded cursor-pointer group"
      onClick={handleClick}
    >
      {/* 网站图标 */}
      <div className="flex-shrink-0 mr-3">
        {tab.favicon ? (
          <img 
            src={tab.favicon} 
            alt="" 
            className="w-4 h-4"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <div className="w-4 h-4 bg-gray-300 rounded-sm"></div>
        )}
      </div>

      {/* 标题和URL */}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-900 truncate">
          {tab.title || '无标题'}
        </div>
        <div className="text-xs text-gray-500 truncate">
          {tab.url}
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="flex-shrink-0 ml-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <button 
          className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"
          onClick={(e) => {
            e.stopPropagation();
            console.log('删除标签页:', tab.title);
          }}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>
    </div>
  );
};

export default SimpleTabDisplay;
