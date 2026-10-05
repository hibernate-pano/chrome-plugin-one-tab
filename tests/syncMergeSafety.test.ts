// 防止「同步覆盖本地数据」——钉死真实生产路径 syncEngine.downloadAndMerge
// 所依赖的纯函数防线 validateMergeResult（现役，@/core/syncDecision）。
//
// 2026-10-05 瘦身：移除了对 @/utils/syncUtils.legacy 的 mergeTabGroups 回归。
// 那份 legacy 合并语义已随文件删除（它被 ESLint 禁接回生产、且不再有回迁计划，
// 留着只是让一批测试守着一段没人会用的代码）。合并语义的现役保障在
// tests/opStampMerge.test.ts（组级 LWW 整组覆盖）。
//
// 历史背景：旧测试针对 downloadTabsFromCloudFlow（tabSyncWorkflow.ts），
// 但该路径在 v1.12.0 后已是**死代码**——生产自动下载走
//   AuthProvider → smartSyncService.maybeAutoDownload → syncEngine.downloadAndMerge
// 而 downloadAndMerge 的数据安全完全建立在 validateMergeResult 上：
//   合并异常缩水时拦截 → 触发回滚到快照。
//
// 纯函数测试零依赖，不受 ESM module-mock 与自定义 TS loader 不兼容的影响。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

const NOW = '2026-06-04T08:00:00.000Z';

function makeGroup(id: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name,
    tabs: [
      {
        id: `${id}-tab-1`,
        url: `https://example.com/${id}`,
        title: `${name} tab`,
        createdAt: NOW,
        lastAccessed: NOW,
        pinned: false,
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    version: 1,
    ...overrides,
  };
}

before(async () => {
  register(LOADER_PATH);
});

describe('syncMergeSafety: 同步合并不丢本地数据（真实生产路径防线）', () => {
  // ── validateMergeResult ───────────────────────────────────────────
  it('本地有数据但合并后为空 → 判定 invalid（触发回滚）', async () => {
    const { validateMergeResult } = await import('@/core/syncDecision');
    const local = [makeGroup('g-A', 'A'), makeGroup('g-B', 'B')];
    const r = validateMergeResult(local, [], []);
    assert.equal(r.valid, false, '本地非空却合并为空必须被拦截');
  });

  it('两边都空 + 合并空 → valid', async () => {
    const { validateMergeResult } = await import('@/core/syncDecision');
    assert.equal(validateMergeResult([], [], []).valid, true);
  });

  it('合并数低于（本地 - 云端删除）下限 → invalid', async () => {
    const { validateMergeResult } = await import('@/core/syncDecision');
    const local = [makeGroup('a', 'A'), makeGroup('b', 'B'), makeGroup('c', 'C')];
    // 云端没有任何删除标记，但合并后只剩 1 个 → 异常缩水
    const merged = [makeGroup('a', 'A')];
    assert.equal(validateMergeResult(local, [], merged).valid, false);
  });

  it('云端明确删除 1 个 → 合并少 1 个是 valid', async () => {
    const { validateMergeResult } = await import('@/core/syncDecision');
    const local = [makeGroup('a', 'A'), makeGroup('b', 'B')];
    const cloud = [makeGroup('b', 'B', { isDeleted: true })];
    const merged = [makeGroup('a', 'A')];
    assert.equal(validateMergeResult(local, cloud, merged).valid, true);
  });

  // ── 回归：本地含软删组不应抬高 validate 基线（v1.12.0 review 修复）─────
  // storage.getGroups() 返回的数组是含软删组的（deleteGroup 写 isDeleted=true
  // 回主存储）。mergeTabGroups 第一步会跳过软删组，所以 validateMergeResult
  // 必须用「活跃本地组数」当基线，否则累积的软删组会让正常合并被误判为非法。
  it('本地 3 活跃 + 2 软删，云端空 → 合并 3 个应判 valid（不被软删抬高基线）', async () => {
    const { validateMergeResult } = await import('@/core/syncDecision');
    const local = [
      makeGroup('a', 'A'),
      makeGroup('b', 'B'),
      makeGroup('c', 'C'),
      makeGroup('d-del', 'D', { isDeleted: true }),
      makeGroup('e-del', 'E', { isDeleted: true }),
    ];
    const merged = [makeGroup('a', 'A'), makeGroup('b', 'B'), makeGroup('c', 'C')];
    assert.equal(
      validateMergeResult(local, [], merged).valid,
      true,
      '软删组不应计入 expectedMin，否则正常合并被误判触发回滚'
    );
  });
});

// ── 下载前置保护（decideDownloadPrecheck） ──────────────────────────────
// 防止「本地删除/点开的标签被云端旧数据复活」的第二道防线：
// downloadAndMerge 在拉取云端前，先判断是否需要跳过或先推送本地变更。

describe('syncMergeSafety: 下载前置保护 decideDownloadPrecheck', () => {
  const NOW = Date.parse('2026-06-04T08:00:00.000Z');

  it('forceRemote（覆盖下载）→ 直接 proceed，跳过一切保护', async () => {
    const { decideDownloadPrecheck } = await import('@/core/syncDecision');
    const decision = decideDownloadPrecheck({
      forceRemote: true,
      lastUploadTime: new Date(NOW - 5_000).toISOString(), // 刚上传过
      pendingUpload: true, // 且有未推送变更
      now: NOW,
    });
    assert.deepEqual(decision, { action: 'proceed' });
  });

  it('UPLOAD_GUARD_MS 窗口内刚上传过 → skip (recent_upload_guard)', async () => {
    const { decideDownloadPrecheck } = await import('@/core/syncDecision');
    const decision = decideDownloadPrecheck({
      forceRemote: false,
      lastUploadTime: new Date(NOW - 10_000).toISOString(), // 10s 前刚上传
      pendingUpload: false,
      now: NOW,
    });
    assert.deepEqual(decision, { action: 'skip', reason: 'recent_upload_guard' });
  });

  it('上传发生在窗口之外（>35s）→ 不触发 guard', async () => {
    const { decideDownloadPrecheck, UPLOAD_GUARD_MS } = await import('@/core/syncDecision');
    const decision = decideDownloadPrecheck({
      forceRemote: false,
      lastUploadTime: new Date(NOW - UPLOAD_GUARD_MS - 1_000).toISOString(),
      pendingUpload: false,
      now: NOW,
    });
    assert.deepEqual(decision, { action: 'proceed' });
  });

  it('从未上传过（lastUploadTime=null）→ 不触发 guard', async () => {
    const { decideDownloadPrecheck } = await import('@/core/syncDecision');
    const decision = decideDownloadPrecheck({
      forceRemote: false,
      lastUploadTime: null,
      pendingUpload: false,
      now: NOW,
    });
    assert.deepEqual(decision, { action: 'proceed' });
  });

  it('lastUploadTime 为未来时间戳（时钟偏差）→ sinceUpload<0，不误杀下载', async () => {
    const { decideDownloadPrecheck } = await import('@/core/syncDecision');
    const decision = decideDownloadPrecheck({
      forceRemote: false,
      lastUploadTime: new Date(NOW + 60_000).toISOString(),
      pendingUpload: false,
      now: NOW,
    });
    assert.deepEqual(decision, { action: 'proceed' });
  });

  it('有未推送变更且不在 guard 窗口 → upload_first（先推后拉的防复活核心）', async () => {
    const { decideDownloadPrecheck } = await import('@/core/syncDecision');
    // 真实场景：删除书签 → pending=true、upload alarm 排在未来 → 此时任何
    // downloadAndMerge 都必须先把删除推上云，否则云端旧数据会复活已删内容。
    const decision = decideDownloadPrecheck({
      forceRemote: false,
      lastUploadTime: new Date(NOW - 120_000).toISOString(),
      pendingUpload: true,
      now: NOW,
    });
    assert.deepEqual(decision, { action: 'upload_first' });
  });

  it('guard 规则优先于 upload_first：刚传完又出现 pending → skip 下载，等下轮 alarm 推送', async () => {
    const { decideDownloadPrecheck } = await import('@/core/syncDecision');
    const decision = decideDownloadPrecheck({
      forceRemote: false,
      lastUploadTime: new Date(NOW - 5_000).toISOString(),
      pendingUpload: true,
      now: NOW,
    });
    assert.deepEqual(decision, { action: 'skip', reason: 'recent_upload_guard' });
  });
});

// ── 云端软删写入方式（降级行为护栏）────────────────────────────────────────
// 复核发现：把「印记列探测失败」当成「不能软删」→ 降级硬删 → 云端行永久消失、
// 他端活跃副本重新 INSERT = 幽灵复活。印记列与「把 is_deleted 置 true」无关。
describe('decideCloudTombstoneWrite: 只有连 is_deleted 列都没有才允许硬删', () => {
  it('有 is_deleted 列时永远不做硬删（印记列缺失或探测失败也只降级为不带 stamp 的软删）', async () => {
    const { decideCloudTombstoneWrite } = await import('@/core/syncDecision');
    assert.equal(decideCloudTombstoneWrite(true, true), 'stamp');
    assert.equal(decideCloudTombstoneWrite(true, false), 'plain', '印记列缺失 → 必须仍是软删');
  });

  it('仅当云端连 is_deleted 列都没有时才硬删', async () => {
    const { decideCloudTombstoneWrite } = await import('@/core/syncDecision');
    assert.equal(decideCloudTombstoneWrite(false, false), 'hard-delete');
    assert.equal(decideCloudTombstoneWrite(false, true), 'hard-delete');
  });
});
