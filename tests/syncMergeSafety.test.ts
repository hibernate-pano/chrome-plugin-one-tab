// 防止「同步覆盖本地数据」——钉死真实生产路径 syncEngine.downloadAndMerge
// 所依赖的两道纯函数防线：mergeTabGroups + validateMergeResult。
//
// 历史背景：旧测试针对 downloadTabsFromCloudFlow（tabSyncWorkflow.ts），
// 但该路径在 v1.12.0 后已是**死代码**——生产自动下载走
//   AuthProvider → smartSyncService.maybeAutoDownload → syncEngine.downloadAndMerge
// 而 downloadAndMerge 的数据安全完全建立在这两个纯函数上：
//   1. mergeTabGroups(local, cloud, strategy) 永不无故丢弃本地组
//   2. validateMergeResult(local, cloud, merged) 在合并异常缩水时拦截 → 触发回滚
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
  // ── mergeTabGroups ────────────────────────────────────────────────
  it('云端空 + 本地有数据 → 合并后保留全部本地组', async () => {
    const { mergeTabGroups } = await import('@/utils/syncUtils');
    const local = [makeGroup('g-A', 'A'), makeGroup('g-B', 'B'), makeGroup('g-C', 'C')];
    const merged = mergeTabGroups(local, [], 'newest');
    assert.deepEqual(
      merged.map(g => g.id).sort(),
      ['g-A', 'g-B', 'g-C'],
      '云端为空时本地组必须全部保留'
    );
  });

  it('云端空 + 本地空 → 合并为空（正常）', async () => {
    const { mergeTabGroups } = await import('@/utils/syncUtils');
    assert.deepEqual(mergeTabGroups([], [], 'newest'), []);
  });

  it('云端独有 + 本地独有 → 合并为并集', async () => {
    const { mergeTabGroups } = await import('@/utils/syncUtils');
    const local = [makeGroup('g-A', 'A')];
    const cloud = [makeGroup('g-Z', 'Z')];
    const merged = mergeTabGroups(local, cloud, 'newest');
    assert.deepEqual(merged.map(g => g.id).sort(), ['g-A', 'g-Z']);
  });

  it('未删除的本地组不会因云端缺失而消失', async () => {
    const { mergeTabGroups } = await import('@/utils/syncUtils');
    const local = [makeGroup('keep', 'Keep')];
    const cloud = [makeGroup('cloud-only', 'CloudOnly')];
    const merged = mergeTabGroups(local, cloud, 'remote'); // 即便远程优先
    assert.ok(merged.some(g => g.id === 'keep'), 'remote 策略也不能丢未删除的本地组');
  });

  // ── validateMergeResult ───────────────────────────────────────────
  it('本地有数据但合并后为空 → 判定 invalid（触发回滚）', async () => {
    const { validateMergeResult } = await import('@/utils/syncUtils');
    const local = [makeGroup('g-A', 'A'), makeGroup('g-B', 'B')];
    const r = validateMergeResult(local, [], []);
    assert.equal(r.valid, false, '本地非空却合并为空必须被拦截');
  });

  it('两边都空 + 合并空 → valid', async () => {
    const { validateMergeResult } = await import('@/utils/syncUtils');
    assert.equal(validateMergeResult([], [], []).valid, true);
  });

  it('合并数低于（本地 - 云端删除）下限 → invalid', async () => {
    const { validateMergeResult } = await import('@/utils/syncUtils');
    const local = [makeGroup('a', 'A'), makeGroup('b', 'B'), makeGroup('c', 'C')];
    // 云端没有任何删除标记，但合并后只剩 1 个 → 异常缩水
    const merged = [makeGroup('a', 'A')];
    assert.equal(validateMergeResult(local, [], merged).valid, false);
  });

  it('云端明确删除 1 个 → 合并少 1 个是 valid', async () => {
    const { validateMergeResult } = await import('@/utils/syncUtils');
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
    const { validateMergeResult } = await import('@/utils/syncUtils');
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

  it('端到端：删过组的用户（本地含软删）+ 云端空 → merge 结果能通过 validate', async () => {
    const { mergeTabGroups, validateMergeResult } = await import('@/utils/syncUtils');
    const local = [
      makeGroup('keep-1', 'Keep1'),
      makeGroup('keep-2', 'Keep2'),
      makeGroup('gone', 'Gone', { isDeleted: true }),
    ];
    const merged = mergeTabGroups(local, [], 'newest');
    assert.equal(merged.length, 2, 'merge 应只保留 2 个活跃组');
    assert.equal(
      validateMergeResult(local, [], merged).valid,
      true,
      '不能因为本地有 1 个软删组就把 2 个活跃组的正常合并判为非法'
    );
  });

  // ── 端到端组合：合并 + 验证 一起守住 ──────────────────────────────
  it('组合：云端空 + 本地有数据，merge 结果能通过 validate', async () => {
    const { mergeTabGroups, validateMergeResult } = await import('@/utils/syncUtils');
    const local = [makeGroup('g-A', 'A'), makeGroup('g-B', 'B')];
    const merged = mergeTabGroups(local, [], 'newest');
    const v = validateMergeResult(local, [], merged);
    assert.equal(v.valid, true);
    assert.equal(merged.length, 2);
  });

  // ── 误删保护闭环：删除 → 云端墓碑 → 恢复 → 合并带回 ──────────────────
  it('误删保护：Web 端恢复（墓碑复位活跃）后，扩展端 merge 能把组带回来', async () => {
    const { mergeTabGroups } = await import('@/utils/syncUtils');
    // 场景：用户在 Web 端误删会话（云端 is_deleted=true，带新时间戳/版本），
    // 又从 Web「已删除」区点恢复 → 云端墓碑复位 is_deleted=false。
    // 扩展端下载时云端行是活跃的，merge 不应把它当墓碑丢弃。
    const cloud = [
      makeGroup('g1', 'G1', {
        isDeleted: false,
        version: 4,
        updatedAt: '2026-06-05T09:00:00.000Z',
      }),
    ];
    const local = [];
    const merged = mergeTabGroups(local, cloud, 'newest');
    assert.equal(merged.some(g => g.id === 'g1'), true, '恢复后的云端活跃组应被合并带回 (remote-only)');
    assert.equal(merged.some(g => g.isDeleted), false, '墓碑已复位，合并结果不应含墓碑');
  });

  it('误删保护：扩展端恢复（restoreGroup 版本+1）上传后，云端墓碑被覆写为活跃', async () => {
    const { mergeTabGroups } = await import('@/utils/syncUtils');
    // 场景：扩展端删组（本地墓碑）→ 用户从扩展端恢复区点恢复 →
    // restoreGroup 置 isDeleted=false 且 version+1 → 上传以 is_deleted:false 覆写云端。
    // 这里验证 merge 对「本地已恢复、云端仍是墓碑」的正确合并：
    // 云端墓碑版本低于本地恢复版本 → 不应用删除，保留本地。
    const local = [makeGroup('g2', 'G2', { isDeleted: false, version: 3 })];
    const cloud = [makeGroup('g2', 'G2', { isDeleted: true, version: 2 })];
    const merged = mergeTabGroups(local, cloud, 'newest');
    assert.equal(
      merged.some(g => g.id === 'g2'),
      true,
      '本地版本更高且已恢复 → 不应被云端旧墓碑删除'
    );
  });

  // ── 回归：移走最后一个标签后自动关组（isDeleted 墓碑 vs 物理移除）──────────
  // 生产 bug：moveTabAndSync 跨组移走最后一枚 tab 时，把空组从本地 storage
  // 物理过滤掉（无墓碑）→ upload() 的 deletedIds 不含本组、云端行 is_deleted=false
  // 残留 → 下载合并把云端该组以 remote-only 复活（“最后一个标签刷新后又回来”）。
  it('回归：云端残留活跃组 + 本地物理移除 → 会被 merge 复活（Bug 场景）', async () => {
    const { mergeTabGroups } = await import('@/utils/syncUtils');
    // 本地：该组已被物理移除（storage 中不存在；本地只剩另一个活跃组）
    const local = [makeGroup('other', 'Other')];
    // 云端：旧组仍为 is_deleted=false（物理移除从未把删除意图播到云端）
    const cloud = [makeGroup('old', 'OldEmptyGroup'), makeGroup('other', 'Other')];
    const merged = mergeTabGroups(local, cloud, 'newest');
    assert.equal(
      merged.some(g => g.id === 'old'),
      true,
      '云端未删残留会被作为 remote-only 复活 —— 这就是最后一个标签删不掉的根因'
    );
  });

  it('回归：本地墓碑 + 云端墓碑（上传已播删除后）→ 刷新不复活、其他组存活', async () => {
    const { mergeTabGroups } = await import('@/utils/syncUtils');
    // 修复后：空组不再物理移除，而是本地打 isDeleted 墓碑 → upload 把 deletedIds
    // 播到云端、markCloudGroupsAsDeleted 使云端同组也 is_deleted=true。
    // 此处验证该稳态：两端都是墓碑 → 刷新/下载不会把组复活回来（Bug 已消除）。
    const local = [
      makeGroup('old', 'OldEmptyGroup', { isDeleted: true, version: 3 }),
      makeGroup('other', 'Other'),
    ];
    const cloud = [
      makeGroup('old', 'OldEmptyGroup', { isDeleted: true, version: 3 }),
      makeGroup('other', 'Other'),
    ];
    const merged = mergeTabGroups(local, cloud, 'newest');
    assert.equal(
      merged.some(g => g.id === 'old'),
      false,
      '两端墓碑 → 空组不复活（物理移除的旧 bug 会在 refreshed 后把它带回来）'
    );
    assert.equal(merged.some(g => g.id === 'other'), true, '其他活跃组不受影响');
  });
});

// ── 下载前置保护（decideDownloadPrecheck） ──────────────────────────────
// 防止「本地删除/点开的标签被云端旧数据复活」的第二道防线：
// downloadAndMerge 在拉取云端前，先判断是否需要跳过或先推送本地变更。

describe('syncMergeSafety: 下载前置保护 decideDownloadPrecheck', () => {
  const NOW = Date.parse('2026-06-04T08:00:00.000Z');

  it('forceRemote（覆盖下载）→ 直接 proceed，跳过一切保护', async () => {
    const { decideDownloadPrecheck } = await import('@/utils/syncUtils');
    const decision = decideDownloadPrecheck({
      forceRemote: true,
      lastUploadTime: new Date(NOW - 5_000).toISOString(), // 刚上传过
      pendingUpload: true, // 且有未推送变更
      now: NOW,
    });
    assert.deepEqual(decision, { action: 'proceed' });
  });

  it('UPLOAD_GUARD_MS 窗口内刚上传过 → skip (recent_upload_guard)', async () => {
    const { decideDownloadPrecheck } = await import('@/utils/syncUtils');
    const decision = decideDownloadPrecheck({
      forceRemote: false,
      lastUploadTime: new Date(NOW - 10_000).toISOString(), // 10s 前刚上传
      pendingUpload: false,
      now: NOW,
    });
    assert.deepEqual(decision, { action: 'skip', reason: 'recent_upload_guard' });
  });

  it('上传发生在窗口之外（>35s）→ 不触发 guard', async () => {
    const { decideDownloadPrecheck, UPLOAD_GUARD_MS } = await import('@/utils/syncUtils');
    const decision = decideDownloadPrecheck({
      forceRemote: false,
      lastUploadTime: new Date(NOW - UPLOAD_GUARD_MS - 1_000).toISOString(),
      pendingUpload: false,
      now: NOW,
    });
    assert.deepEqual(decision, { action: 'proceed' });
  });

  it('从未上传过（lastUploadTime=null）→ 不触发 guard', async () => {
    const { decideDownloadPrecheck } = await import('@/utils/syncUtils');
    const decision = decideDownloadPrecheck({
      forceRemote: false,
      lastUploadTime: null,
      pendingUpload: false,
      now: NOW,
    });
    assert.deepEqual(decision, { action: 'proceed' });
  });

  it('lastUploadTime 为未来时间戳（时钟偏差）→ sinceUpload<0，不误杀下载', async () => {
    const { decideDownloadPrecheck } = await import('@/utils/syncUtils');
    const decision = decideDownloadPrecheck({
      forceRemote: false,
      lastUploadTime: new Date(NOW + 60_000).toISOString(),
      pendingUpload: false,
      now: NOW,
    });
    assert.deepEqual(decision, { action: 'proceed' });
  });

  it('有未推送变更且不在 guard 窗口 → upload_first（先推后拉的防复活核心）', async () => {
    const { decideDownloadPrecheck } = await import('@/utils/syncUtils');
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
    const { decideDownloadPrecheck } = await import('@/utils/syncUtils');
    const decision = decideDownloadPrecheck({
      forceRemote: false,
      lastUploadTime: new Date(NOW - 5_000).toISOString(),
      pendingUpload: true,
      now: NOW,
    });
    assert.deepEqual(decision, { action: 'skip', reason: 'recent_upload_guard' });
  });
});
