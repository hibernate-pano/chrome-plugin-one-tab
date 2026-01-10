import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Tab } from '@/types/tab';
import { extractDomain } from '@/utils/smartGrouping';

interface TabPreviewProps {
  tab: Tab;
  visible: boolean;
  position: { x: number; y: number };
  onClose?: () => void;
}

/**
 * 标签预览组件 - 增强版
 * 显示标签页的预览信息，包括标题、URL、图标和更多元信息
 */
export const TabPreview: React.FC<TabPreviewProps> = ({ tab, visible, position, onClose }) => {
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_loading, setLoading] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_error, setError] = useState(false);

  // 提取域名
  const domain = useMemo(() => extractDomain(tab.url), [tab.url]);

  // 格式化时间
  const formatDate = useCallback((dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return `今天 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
    } else if (diffDays === 1) {
      return `昨天 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
    } else if (diffDays < 7) {
      return `${diffDays}天前`;
    } else {
      return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
    }
  }, []);

  // 当标签或可见性变化时，尝试加载预览图
  useEffect(() => {
    if (visible && tab.url) {
      setLoading(true);
      setError(false);

      const img = new Image();

      if (tab.favicon) {
        img.src = tab.favicon;
      } else {
        setPreviewImage(null);
        setLoading(false);
        return;
      }

      img.onload = () => {
        setPreviewImage(img.src);
        setLoading(false);
      };

      img.onerror = () => {
        setPreviewImage(null);
        setLoading(false);
        setError(true);
      };

      return () => {
        img.onload = null;
        img.onerror = null;
      };
    }
  }, [tab.url, tab.favicon, visible]);

  // 处理键盘事件
  useEffect(() => {
    if (!visible) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose?.();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [visible, onClose]);

  if (!visible) return null;

  // 计算位置，确保不超出屏幕
  const calculatePosition = () => {
    const previewWidth = 320;
    const previewHeight = 200;
    const padding = 10;

    let x = position.x + padding;
    let y = position.y;

    // 如果超出右边界，显示在左边
    if (x + previewWidth > window.innerWidth) {
      x = position.x - previewWidth - padding;
    }

    // 如果超出下边界，向上调整
    if (y + previewHeight > window.innerHeight) {
      y = window.innerHeight - previewHeight - padding;
    }

    // 确保不超出上边界
    y = Math.max(padding, y);

    return { x, y };
  };

  const pos = calculatePosition();

  return (
    <div
      className="fixed z-50 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 p-4 w-80 animate-smooth-fade-in"
      style={{
        left: `${pos.x}px`,
        top: `${pos.y}px`,
      }}
      role="tooltip"
      aria-label={`${tab.title} 的预览`}
    >
      <div className="flex flex-col space-y-3">
        {/* 头部：图标和域名 */}
        <div className="flex items-center space-x-2">
          {previewImage ? (
            <img
              src={previewImage}
              alt=""
              className="w-5 h-5 rounded"
              loading="lazy"
            />
          ) : (
            <div className="w-5 h-5 rounded bg-gray-200 dark:bg-gray-600 flex items-center justify-center">
              <svg className="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
              </svg>
            </div>
          )}
          <span className="text-xs text-gray-500 dark:text-gray-400 truncate flex-1">
            {domain}
          </span>
          {tab.isPinned && (
            <span className="text-xs bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-300 px-1.5 py-0.5 rounded">
              固定
            </span>
          )}
        </div>

        {/* 标题 */}
        <h3 className="font-medium text-gray-900 dark:text-gray-100 text-sm leading-tight line-clamp-2">
          {tab.title}
        </h3>

        {/* URL */}
        <p className="text-gray-500 dark:text-gray-400 text-xs truncate">
          {tab.url}
        </p>

        {/* 分隔线 */}
        <div className="border-t border-gray-100 dark:border-gray-700" />

        {/* 元信息 */}
        <div className="flex items-center justify-between text-xs text-gray-400 dark:text-gray-500">
          <div className="flex items-center space-x-1">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>保存于 {formatDate(tab.createdAt)}</span>
          </div>
          {tab.lastAccessed && tab.lastAccessed !== tab.createdAt && (
            <div className="flex items-center space-x-1">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
              <span>访问于 {formatDate(tab.lastAccessed)}</span>
            </div>
          )}
        </div>

        {/* 同步状态 */}
        {tab.syncStatus && tab.syncStatus !== 'synced' && (
          <div className="flex items-center space-x-1 text-xs">
            {tab.syncStatus === 'local-only' && (
              <span className="text-yellow-600 dark:text-yellow-400 flex items-center space-x-1">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <span>仅本地</span>
              </span>
            )}
            {tab.syncStatus === 'conflict' && (
              <span className="text-red-600 dark:text-red-400 flex items-center space-x-1">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span>有冲突</span>
              </span>
            )}
          </div>
        )}

        {/* 快捷操作提示 */}
        <div className="text-xs text-gray-400 dark:text-gray-500 flex items-center justify-center space-x-2 pt-1 border-t border-gray-100 dark:border-gray-700">
          <span>点击打开</span>
          <span>•</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  );
};

export default TabPreview;
