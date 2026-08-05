import React, { useEffect, useRef } from 'react';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { syncService } from '@/services/syncService';

/** 网络恢复后的自动重试防抖（ms） */
const RETRY_DEBOUNCE_MS = 5_000;

/**
 * 离线提示条（S1 §4.2）。
 *
 * - 自包含：内部调用 useNetworkStatus，online 时渲染 null
 * - offline 时渲染琥珀色提示条：「离线 — 同步将在网络恢复后自动重试」
 * - 网络恢复（offline → online）时防抖 5s 触发一次
 *   `syncService.downloadAndRefresh(false)`；用 ref 做「已重试/重试中」守卫，
 *   防止抖动期间重复调度。
 */
export const NetworkBanner: React.FC = () => {
  const isOnline = useNetworkStatus();
  const prevOnline = useRef(isOnline);
  /** 重试进行中 / 已调度守卫（防止网络抖动期间重复调度） */
  const retryInFlight = useRef(false);

  useEffect(() => {
    const restored = !prevOnline.current && isOnline;
    prevOnline.current = isOnline;

    // 仅「由离线恢复」时触发；首次挂载（本就在线）不重试
    if (!restored || retryInFlight.current) return;

    retryInFlight.current = true;
    const timer = setTimeout(async () => {
      try {
        await syncService.downloadAndRefresh(false);
      } finally {
        retryInFlight.current = false;
      }
    }, RETRY_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      retryInFlight.current = false;
    };
  }, [isOnline]);

  if (isOnline) return null;

  return (
    <div
      role="status"
      className="w-full bg-amber-500 px-3 py-1 text-center text-xs font-medium text-white"
    >
      离线 — 同步将在网络恢复后自动重试
    </div>
  );
};

export default NetworkBanner;
