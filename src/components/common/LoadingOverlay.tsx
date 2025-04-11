import React, { memo } from 'react';

interface LoadingOverlayProps {
  isVisible: boolean;
  message?: string;
}

// 使用 React.memo 减少不必要的重新渲染
// 只有当 props 变化时才会重新渲染
export const LoadingOverlay: React.FC<LoadingOverlayProps> = memo(({
  isVisible,
  message = '正在加载数据...'
}) => {
  if (!isVisible) return null;

  // 使用更轻量级的样式，减少渲染负担
  return (
    <div
      className={`fixed top-0 right-0 mt-4 mr-4 z-50 transition-opacity duration-300`}
      style={{ pointerEvents: 'none' }}
    >
      <div className="flex items-center bg-white bg-opacity-90 px-4 py-2 rounded-lg shadow-sm border border-gray-200">
        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary-600 mr-2"></div>
        {message && (
          <div className="text-xs text-primary-600 font-medium">{message}</div>
        )}
      </div>
    </div>
  );
});
