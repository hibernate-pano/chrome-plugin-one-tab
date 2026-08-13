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
 * 只渲染符合 CSP 白名单（manifest.json img-src）的 favicon，其余降级为默认图标。
 *
 * useState 仅跟踪运行时加载失败（onError）—— 协议级安全由 isFaviconUrlSafe 在 render 时
 * 直接判断，不需要 useEffect 协议层检查（避免每个 tab 触发额外 render + 移除旧实现的 console.warn 噪音）。
 * 但 src 变化时需要重置 loadFailed，否则换 tab 后还卡在 fallback 上。
 */
export const SafeFavicon: React.FC<SafeFaviconProps> = ({
  src,
  alt = '',
  className = 'w-4 h-4 flex-shrink-0',
  fallbackIcon
}) => {
  const [loadFailed, setLoadFailed] = useState(false);

  // src 变化 → 重置加载失败标记，让新的 src 有机会重试一次
  useEffect(() => {
    setLoadFailed(false);
  }, [src]);

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

  // URL 通过协议白名单 + 之前没有加载失败 → 渲染 <img>
  if (src && isFaviconUrlSafe(src) && !loadFailed) {
    return (
      <img
        src={src}
        alt={alt}
        className={className}
        onError={() => setLoadFailed(true)}
      />
    );
  }

  return fallbackIcon || defaultFallbackIcon;
};
