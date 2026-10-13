/**
 * 同步后端解析入口（2026-10-13，阶段 0：「加接缝」）。
 *
 * ── 本文件解决的问题（比它看起来重要）───────────────────────────────────
 * 1.22.x 的 S3 拆分留下的 `setSyncPort()` / `resetSyncPort()` 是**全仓零调用**
 * （2026-10-13 `rg setSyncPort . --hidden -g '!node_modules'` 复核：
 * 命中只有它自己的定义与文档提及）。也就是说那条「未来多实现」的接缝
 * **从未被真正接上**——端口抽象是空转的。本文件把它接成真的：
 * 所有后端解析走这里，`tabGroupSyncService` 不再自己绑死一个实现。
 *
 * ── 阶段 0 的行为契约（零变化）──────────────────────────────────────────
 * 默认解析结果**恒为 Supabase**。WebDAV 适配器在后续阶段接入时，
 * 才在这里加「读设置决定后端」的分支；在此之前本文件不改变任何调用序列。
 *
 * ── 为什么解析结果要缓存而不每次 new ────────────────────────────────────
 * 适配器是无状态对象，但 Supabase 适配器的方法内部会触达 supabase 客户端
 * （有会话缓存）。每次 new 虽然不会错，但会让「同一个后端被反复构造」这件事
 * 出现在性能敏感的同步路径上。用模块级单例 + 显式 setter（测试用）即可。
 */
import type { SyncBackendId, SyncBackendPort } from './ports';
import { SupabaseBackendAdapter } from './supabaseAdapter';

let activeBackend: SyncBackendPort | null = null;

/** 解析当前生效的同步后端。阶段 0 恒为 Supabase（见文件头行为契约）。 */
export function getActiveSyncBackend(): SyncBackendPort {
  if (!activeBackend) activeBackend = new SupabaseBackendAdapter();
  return activeBackend;
}

/**
 * 显式指定后端。调用方：
 *   · 测试（注入替身，替代原先空转的 setSyncPort）
 *   · 后续阶段的设置层（用户选了 WebDAV 就传 WebDAV 适配器）
 */
export function setActiveSyncBackend(backend: SyncBackendPort): void {
  activeBackend = backend;
}

/** 恢复默认解析（Supabase）。测试的 afterEach 用。 */
export function resetActiveSyncBackend(): void {
  activeBackend = null;
}

/** 当前后端标识（UI 展示与「换后端 ⇒ 水位作废」判据用）。 */
export function getActiveSyncBackendId(): SyncBackendId {
  return getActiveSyncBackend().id;
}

export type { SyncBackendPort, SyncBackendId, RemoteGroupFingerprint, UploadGroupsResult } from './ports';
export { SupabaseBackendAdapter } from './supabaseAdapter';

