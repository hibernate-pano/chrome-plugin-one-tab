import React, { useState, useEffect } from 'react';
import { isFaviconUrlSafe } from '@/utils/faviconUtils';

interface SafeFaviconProps {
  src?: string;
  alt?: string;
  className?: string;
  fallbackIcon?: React.ReactNode;
}

/**
 * 安全的 Favicon 组件
 * 只显示符合 CSP 策略的 favicon，对于不安全的 URL 显示默认图标
 */
export const SafeFavicon: React.FC<SafeFaviconProps> = ({
  src,
  alt = '',
  className = 'w-4 h-4 flex-shrink-0',
  fallbackIcon
}) => {
  const [shouldShowImage, setShouldShowImage] = useState(false);
  const [imageError, setImageError] = useState(false);

  useEffect(() => {
    // 重置状态
    setImageError(false);
    
    // 检查 URL 是否安全
    if (src && isFaviconUrlSafe(src)) {
      setShouldShowImage(true);
    } else {
      setShouldShowImage(false);
      if (src) {
        console.warn('不安全的 favicon URL，已过滤:', src);
      }
    }
  }, [src]);

  const handleImageError = () => {
    setImageError(true);
    setShouldShowImage(false);
  };

  // 默认的回退图标
  const defaultFallbackIcon = (
    <div className={`bg-gray-200 dark:bg-gray-600 flex items-center justify-center ${className}`}>
      <svg 
        xmlns="http://www.w3.org/2000/svg" 
        className="h-3 w-3 text-gray-500 dark:text-gray-300" 
        fill="none" 
        viewBox="0 0 24 24" 
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    </div>
  );

  // 如果应该显示图片且没有错误，显示图片
  if (shouldShowImage && !imageError) {
    return (
      <img 
        src={src} 
        alt={alt} 
        className={className}
        onError={handleImageError}
      />
    );
  }

  // 否则显示回退图标
  return fallbackIcon || defaultFallbackIcon;
};
