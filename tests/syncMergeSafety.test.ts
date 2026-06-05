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

  // ── 端到端组合：合并 + 验证 一起守住 ──────────────────────────────
  it('组合：云端空 + 本地有数据，merge 结果能通过 validate', async () => {
    const { mergeTabGroups, validateMergeResult } = await import('@/utils/syncUtils');
    const local = [makeGroup('g-A', 'A'), makeGroup('g-B', 'B')];
    const merged = mergeTabGroups(local, [], 'newest');
    const v = validateMergeResult(local, [], merged);
    assert.equal(v.valid, true);
    assert.equal(merged.length, 2);
  });
});
