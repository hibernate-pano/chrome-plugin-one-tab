// 同步后端替身（2026-10-16 取代 stubSession.ts）。
//
// ── 为什么换掉原来那份 ─────────────────────────────────────────────────────
// 旧 helper 造的是一份「假 Supabase session JSON」，用途是让
// `uploadTabGroups` 的 `ensureAuthenticated` 前置放行。账号体系与云端后端整体
// 删除后那条门禁不复存在，**没有任何代码再读 session**，于是这个 fixture
// 变成纯噪声：一个它不再满足任何断言的 setup。
//
// 现在的形态：测试要跑真实的 SyncEngine（测 precheck / fail-closed / 队列接线），
// 而 SyncEngine 的网络出口只有一处 —— `@/sync-backend` 的
// `getActiveSyncBackend()`。以前满足这个出口靠的是「PostgREST 假网关」，
// 现在直接注入一个后端替身更短、更准，也不用再造一套 URL 解析桩。
//
// 用法（必须在被测模块被 import 之前完成）：
//   const { installFakeSyncBackend } = await import('./_helpers/fakeSyncBackend.ts');
//   installFakeSyncBackend();
// `reset()` 用于把替身里的调用记录清空（用例之间不串味）。
//
// 替身默认返回「远端为空」：几乎所有留下来的用例考的都是
// 本地判据 / 存储 fail-closed / 闸门，而不是远端数据本身。

import type { SyncBackendPort, RemoteGroupFingerprint } from '../../src/sync-backend/ports';
import type { TabGroup, UserSettings } from '../../src/types/tab';

export interface FakeSyncBackendCalls {
  fetchFingerprints: number;
  downloadGroups: number;
  uploadGroups: Array<{ count: number; overwriteRemote: boolean }>;
  broadcastDeletes: string[][];
  purgeExpiredDeletes: number[];
  uploadSettings: UserSettings[];
  downloadSettings: number;
}

export interface FakeSyncBackendHandle {
  /** 远端会话（默认 []）。用例要考远端参与时自己塞。 */
  groups: TabGroup[];
  /** 远端指纹（默认 []）。 */
  fingerprints: RemoteGroupFingerprint[];
  /** 逐次调用记录，用例可以断言「发了没有 / 发了什么」。 */
  calls: FakeSyncBackendCalls;
  /** 远端设置的上传内容（用于「设置不被降级值覆盖」这类断言）。 */
  uploadedSettings: UserSettings[];
  /** downloadSettings 的返回值。 */
  remoteSettings: Record<string, unknown> | null;
}

/**
 * 把替身装进 `@/sync-backend`。返回的 handle 可以直接改远端状态。
 *
 * ⚠️ 必须在 `@/sync-backend` 被任何被测模块 import **之前**调用 —— 它走的是
 * `setActiveSyncBackend()` 的模块级 override，晚于第一次 import 就会被
 * `getActiveSyncBackend()` 里的缓存实例抢在前面（那次调用会先 void
 * primeSyncBackend() 并 logWarn）。
 */
export async function installFakeSyncBackend(
  overrides: Partial<FakeSyncBackendHandle> = {},
): Promise<FakeSyncBackendHandle> {
  const handle: FakeSyncBackendHandle = {
    groups: overrides.groups ?? [],
    fingerprints: overrides.fingerprints ?? [],
    calls: {
      fetchFingerprints: 0,
      downloadGroups: 0,
      uploadGroups: [],
      broadcastDeletes: [],
      purgeExpiredDeletes: [],
      uploadSettings: [],
      downloadSettings: 0,
    },
    uploadedSettings: overrides.uploadedSettings ?? [],
    remoteSettings: overrides.remoteSettings ?? null,
  };

  const backend: SyncBackendPort = {
    id: 'webdav',
    label: '测试替身',
    async fetchFingerprints() {
      handle.calls.fetchFingerprints += 1;
      return handle.fingerprints;
    },
    async downloadGroups() {
      handle.calls.downloadGroups += 1;
      return handle.groups;
    },
    async uploadGroups(groups, opts) {
      handle.calls.uploadGroups.push({
        count: groups.length,
        overwriteRemote: opts?.overwriteRemote === true,
      });
      return { writtenIds: groups.map(g => g.id), overwroteRemote: opts?.overwriteRemote === true };
    },
    async broadcastDeletes(ids) {
      handle.calls.broadcastDeletes.push([...ids]);
      // 自带存储没有账号闸门 ⇒ 全部广播成功、没有一条被挡下。
      return { broadcastIds: [...ids], blockedIds: [] };
    },
    async purgeExpiredDeletes(maxAgeDays = 30) {
      handle.calls.purgeExpiredDeletes.push(maxAgeDays);
      return 0;
    },
    async uploadSettings(settings) {
      handle.calls.uploadSettings.push(settings);
      handle.uploadedSettings.push(settings);
    },
    async downloadSettings() {
      handle.calls.downloadSettings += 1;
      return handle.remoteSettings;
    },
  };

  const { setActiveSyncBackend } = await import('../../src/sync-backend/index.ts');
  setActiveSyncBackend(backend);
  return handle;
}

/**
 * 断开替身，回到「读设置解析」的默认路径。
 * afterEach 用：否则一个替身会泄到下一个文件（同进程内跨文件是有可能的）。
 */
export async function resetFakeSyncBackend(): Promise<void> {
  const { resetActiveSyncBackend } = await import('../../src/sync-backend/index.ts');
  resetActiveSyncBackend();
}
