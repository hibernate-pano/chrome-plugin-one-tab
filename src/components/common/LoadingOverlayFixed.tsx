import React from 'react';

interface LoadingOverlayProps {
  message?: string;
  isVisible?: boolean;
}

export const LoadingOverlay: React.FC<LoadingOverlayProps> = ({ 
  message = '加载中...', 
  isVisible = true 
}) => {
  if (!isVisible) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 flex items-center space-x-4">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
        <span className="text-gray-700">{message}</span>
      </div>
    </div>
  );
};
