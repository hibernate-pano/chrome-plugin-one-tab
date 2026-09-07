/**
 * 生产环境的 mutationService 单例（规格 §3.2）。
 *
 * 本文件 import 了 chrome 依赖（storage / syncEngine），仅在 SW 实际加载时使用；
 * node:test 不触碰本文件，保持 mutationHandlers.ts 纯净可测。
 *
 * 用途：mutationQueue 串行调用 mutationService.handle(cmd)，由 Task 7 的消息层
 * 把 popup/web 端发送的 MUTATE 消息转交给此处。
 */
import { storage } from '@/utils/storage';
import { syncEngine } from '@/services/syncEngine';
import { createMutationHandlers } from './mutationHandlers';

export const mutationService = createMutationHandlers({
  getGroups: () => storage.getGroups(),
  setGroups: g => storage.setGroups(g),
  scheduleUpload: ms => syncEngine.scheduleUpload(ms),
  now: () => new Date().toISOString(),
});
