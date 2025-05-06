import React, { useState, useEffect } from 'react';
import { Tab } from '@/types/tab';

interface TabPreviewProps {
  tab: Tab;
  visible: boolean;
  position: { x: number; y: number };
}

/**
 * 标签预览组件
 * 显示标签页的预览信息，包括标题、URL和图标
 */
export const TabPreview: React.FC<TabPreviewProps> = ({ tab, visible, position }) => {
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  // 当标签或可见性变化时，尝试加载预览图
  useEffect(() => {
    if (visible && tab.url) {
      setLoading(true);
      setError(false);

      // 尝试获取预览图
      // 这里我们使用一个简单的方法：尝试获取网站的 Open Graph 图片或 favicon
      // 在实际应用中，你可能需要一个更复杂的服务来生成预览图
      const img = new Image();
      
      // 首先尝试使用 favicon
      if (tab.favicon) {
        img.src = tab.favicon;
      } else {
        // 如果没有 favicon，使用一个默认图标
        setPreviewImage(null);
        setLoading(false);
        return;
      }

      img.onload = () => {
        setPreviewImage(img.src);
        setLoading(false);
      };

      img.onerror = () => {
        // 如果加载失败，设置为 null
        setPreviewImage(null);
        setLoading(false);
        setError(true);
      };

      // 清理函数
      return () => {
        img.onload = null;
        img.onerror = null;
      };
    }
  }, [tab.url, tab.favicon, visible]);

  // 如果不可见，不渲染任何内容
  if (!visible) return null;

  return (
    <div 
      className="fixed z-50 bg-white dark:bg-gray-800 rounded-md shadow-lg border border-gray-200 dark:border-gray-700 p-3 max-w-md"
      style={{
        left: `${position.x + 10}px`,
        top: `${position.y + 10}px`,
        transform: 'translateY(-50%)',
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.2s ease-in-out',
      }}
    >
      <div className="flex flex-col space-y-2">
        {/* 标题 */}
        <div className="font-medium text-gray-900 dark:text-gray-100 text-sm">
          {tab.title}
        </div>
        
        {/* URL */}
        <div className="text-gray-500 dark:text-gray-400 text-xs truncate">
          {tab.url}
        </div>
        
        {/* 预览图 */}
        <div className="mt-2 relative">
          {loading ? (
            <div className="h-24 bg-gray-100 dark:bg-gray-700 rounded flex items-center justify-center">
              <div className="animate-pulse text-gray-400 dark:text-gray-500">加载预览...</div>
            </div>
          ) : previewImage ? (
            <div className="relative h-24 bg-gray-100 dark:bg-gray-700 rounded overflow-hidden">
              <img 
                src={previewImage} 
                alt={tab.title}
                className="w-full h-full object-contain"
              />
            </div>
          ) : (
            <div className="h-24 bg-gray-100 dark:bg-gray-700 rounded flex items-center justify-center">
              <div className="text-gray-400 dark:text-gray-500 text-xs">
                {error ? '无法加载预览' : '无预览可用'}
              </div>
            </div>
          )}
        </div>
        
        {/* 创建时间 */}
        <div className="text-gray-400 dark:text-gray-500 text-xs">
          保存于: {new Date(tab.createdAt).toLocaleString()}
        </div>
      </div>
    </div>
  );
};

export default TabPreview;
