import React from 'react';

interface LoadingOverlayProps {
  isVisible: boolean;
  message?: string;
  transparent?: boolean;
}

export const LoadingOverlay: React.FC<LoadingOverlayProps> = ({ 
  isVisible, 
  message = '正在加载数据...',
  transparent = true
}) => {
  if (!isVisible) return null;

  return (
    <div 
      className={`fixed inset-0 flex items-center justify-center z-50 transition-opacity duration-300 ${
        transparent ? 'bg-white bg-opacity-50' : 'bg-white'
      }`}
      style={{ pointerEvents: 'none' }}
    >
      <div className="flex flex-col items-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
        {message && (
          <div className="mt-2 text-sm text-primary-600 font-medium">{message}</div>
        )}
      </div>
    </div>
  );
};
