import type { Middleware } from '@reduxjs/toolkit';
import { sendSyncCommand } from '@/shared/mutationProtocol';

/**
 * @deprecated 阶段一：变更类 thunk 已转为 SW 语义命令，上传调度由
 * mutationHandlers 在 SW 端完成。此中间件仅为仍留在 popup 的同步侧
 * action（如设置保存）兜底转发，命令在 SW 执行。
 */
export const autoSyncMiddleware: Middleware = () => next => action => {
  const result = next(action);
  const a = action as { type?: string; error?: unknown };
  if (typeof a.type === 'string' && !a.error && a.type.startsWith('settings/')) {
    void sendSyncCommand('scheduleUpload', { delayMs: 3000 });
  }
  return result;
};