import type { Middleware } from '@reduxjs/toolkit';
import { sendSyncCommand } from '@/shared/mutationProtocol';
import { isSettingsUploadTrigger } from '@/core/settingsUploadTrigger';

/**
 * @deprecated 阶段一：变更类 thunk 已转为 SW 语义命令，上传调度由
 * mutationHandlers 在 SW 端完成。此中间件仅为仍留在 popup 的同步侧
 * action（如设置保存）兜底转发，命令在 SW 执行。
 *
 * 判据在 core/settingsUploadTrigger.ts（纯函数，可单测）：只有「设置真的
 * 写到了盘上」才排上传，**读设置不排**。原判据是 `type.startsWith('settings/')`
 * —— 那把 `settings/loadSettings/*`（读）也算成了「设置变了」，于是每次开
 * 管理器页、每轮后台轮询都排一次**没有增量白名单的全量上传**（出站流量）。
 * 判据为什么这么定，见那个文件。
 */
export const autoSyncMiddleware: Middleware = () => next => action => {
  const result = next(action);
  const a = action as { type?: string };
  if (isSettingsUploadTrigger(a.type)) {
    void sendSyncCommand('scheduleUpload', { delayMs: 3000 });
  }
  return result;
};
