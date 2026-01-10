/**
 * 智能分组建议组件
 * 
 * 在保存标签组时显示分组建议
 */

import React, { useState, useEffect } from 'react';
import { Tab } from '@/types/tab';
import { smartGroupService, GroupSuggestion as GroupSuggestionType } from '@/services/smartGroupService';
import { SafeFavicon } from '@/components/common/SafeFavicon';

interface GroupSuggestionProps {
  tabs: Tab[];
  onAccept: (suggestion: GroupSuggestionType) => void;
  onDismiss: () => void;
  className?: string;
}

// 图标组件
const LightbulbIcon = () => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
  </svg>
);

const CheckIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
  </svg>
);

const CloseIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
  </svg>
);

/**
 * 获取建议原因的显示文本
 */
function getReasonText(reason: 'domain' | 'keyword' | 'mixed'): string {
  switch (reason) {
    case 'domain':
      return '基于域名';
    case 'keyword':
      return '基于关键词';
    case 'mixed':
      return '综合分析';
    default:
      return '';
  }
}

/**
 * 单个建议卡片
 */
const SuggestionCard: React.FC<{
  suggestion: GroupSuggestionType;
  onAccept: () => void;
  isExpanded: boolean;
  onToggle: () => void;
}> = ({ suggestion, onAccept, isExpanded, onToggle }) => {
  return (
    <div className="suggestion-card border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      {/* 头部 */}
      <div
        className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
        onClick={onToggle}
      >
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{suggestion.name}</span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300">
            {suggestion.tabs.length} 个标签
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {getReasonText(suggestion.reason)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* 置信度指示器 */}
          <div className="w-16 h-1.5 bg-gray-200 dark:bg-gray-600 rounded-full overflow-hidden">
            <div
              className="h-full bg-green-500 rounded-full"
              style={{ width: `${suggestion.confidence * 100}%` }}
            />
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAccept();
            }}
            className="p-1.5 rounded-lg bg-green-500 hover:bg-green-600 text-white transition-colors"
            title="采用此建议"
          >
            <CheckIcon />
          </button>
        </div>
      </div>

      {/* 展开的标签列表 */}
      {isExpanded && (
        <div className="p-2 space-y-1 max-h-40 overflow-y-auto">
          {suggestion.tabs.map(tab => (
            <div
              key={tab.id}
              className="flex items-center gap-2 p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              <SafeFavicon src={tab.favicon} alt="" className="w-4 h-4" />
              <span className="text-sm truncate flex-1">{tab.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * 智能分组建议组件
 */
export const GroupSuggestionPanel: React.FC<GroupSuggestionProps> = ({
  tabs,
  onAccept,
  onDismiss,
  className = '',
}) => {
  const [suggestions, setSuggestions] = useState<GroupSuggestionType[]>([]);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // 生成建议
    setIsLoading(true);
    const newSuggestions = smartGroupService.generateSuggestions(tabs);
    setSuggestions(newSuggestions);
    setIsLoading(false);
  }, [tabs]);

  if (isLoading) {
    return (
      <div className={`p-4 text-center text-gray-500 ${className}`}>
        分析中...
      </div>
    );
  }

  if (suggestions.length === 0) {
    return null;
  }

  return (
    <div className={`smart-suggestion-panel ${className}`}>
      {/* 头部 */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400">
          <LightbulbIcon />
          <span className="font-medium">智能分组建议</span>
        </div>
        <button
          onClick={onDismiss}
          className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
          title="关闭建议"
        >
          <CloseIcon />
        </button>
      </div>

      {/* 建议列表 */}
      <div className="space-y-2">
        {suggestions.map((suggestion, index) => (
          <SuggestionCard
            key={`${suggestion.name}-${index}`}
            suggestion={suggestion}
            onAccept={() => onAccept(suggestion)}
            isExpanded={expandedIndex === index}
            onToggle={() => setExpandedIndex(expandedIndex === index ? null : index)}
          />
        ))}
      </div>

      {/* 提示 */}
      <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
        点击 ✓ 采用建议，或点击卡片查看详情
      </p>
    </div>
  );
};

export default GroupSuggestionPanel;
