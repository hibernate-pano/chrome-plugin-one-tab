/**
 * 网络状态 hook（S1 §4.1）
 *
 * 返回 isOnline（true = 在线）。
 * 信号源：
 *   1. navigator.onLine 初始值
 *   2. window online/offline 事件
 *   3. 30s 轮询兜底（MV3 Service Worker / popup 上下文可能丢失事件）
 *
 * 清理：组件卸载时移除事件监听 + 清除轮询定时器。
 */

import { useEffect, useState } from 'react';

/** 轮询兜底间隔（ms） */
const POLL_INTERVAL_MS = 30_000;

function readOnline(): boolean {
  return typeof navigator !== 'undefined' ? navigator.onLine : true;
}

export function useNetworkStatus(): boolean {
  const [isOnline, setIsOnline] = useState<boolean>(readOnline);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    if (typeof window !== 'undefined') {
      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);
    }

    // 30s 轮询兜底：事件丢失（MV3 上下文销毁/节流）时仍能感知网络变化
    const pollTimer = setInterval(() => {
      setIsOnline(readOnline());
    }, POLL_INTERVAL_MS);

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
      }
      clearInterval(pollTimer);
    };
  }, []);

  return isOnline;
}
