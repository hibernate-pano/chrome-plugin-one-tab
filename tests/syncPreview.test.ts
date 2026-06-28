// syncPreview 测试：上传/下载预览统计的核心逻辑。
//
// 「预览」UI 让用户在上传/下载前看到「会新增 X / 更新 Y / 删除 Z」，
// 用户决策的关键依据。统计错 → 用户误删数据或看不到合并变化。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

const NOW = '2026-06-04T08:00:00.000Z';

function makeGroup(id: string, overrides: Record<string, unknown> = {}): any {
  return {
    id,
    name: `Group ${id}`,
    tabs: [{ id: `${id}-t1`, url: `https://x.com/${id}`, title: id, createdAt: NOW, lastAccessed: NOW, pinned: false }],
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

describe('buildUploadPreviewSummary: overwrite 模式', () => {
  it('本地 2 组 + 云端空 → 预览显示 2 个新增', async () => {
    const { buildUploadPreviewSummary } = await import('@/utils/syncPreview');
    const local = [makeGroup('a'), makeGroup('b')];
    const remote: any[] = [];

    const summary = buildUploadPreviewSummary(local, remote, 'overwrite');

    assert.equal(summary.additions, 2);
    assert.equal(summary.beforeCount, 0);
    assert.equal(summary.afterCount, 2);
    assert.equal(summary.addedNames.length, 2);
  });

  it('本地空 + 云端 3 组 → overwrite 后预览 3 个 deletion（云端被覆盖为本地）', async () => {
    const { buildUploadPreviewSummary } = await import('@/utils/syncPreview');
    const summary = buildUploadPreviewSummary([], [makeGroup('a'), makeGroup('b'), makeGroup('c')], 'overwrite');
    // overwrite 模式下，本地数据会覆盖云端。本地空 = 云端现有 3 组将被覆盖掉
    assert.equal(summary.additions, 0);
    assert.equal(summary.deletions, 3, '云端 3 组将被覆盖为空 → preview 显示 3 个 deletion');
  });

  it('本地 + 云端完全相同 → 0 增 0 改 0 删', async () => {
    const { buildUploadPreviewSummary } = await import('@/utils/syncPreview');
    const groups = [makeGroup('a'), makeGroup('b')];
    const summary = buildUploadPreviewSummary(groups, groups, 'overwrite');
    assert.equal(summary.additions, 0);
    assert.equal(summary.updates, 0);
    assert.equal(summary.deletions, 0);
    assert.equal(summary.unchanged, 2);
  });

  it('本地修改组名 → preview 显示 1 个 update', async () => {
    const { buildUploadPreviewSummary } = await import('@/utils/syncPreview');
    const remote = [makeGroup('a', { name: 'Old Name' })];
    const local = [makeGroup('a', { name: 'New Name' })];

    const summary = buildUploadPreviewSummary(local, remote, 'overwrite');
    assert.equal(summary.updates, 1);
    assert.ok(summary.updatedNames.includes('New Name'));
  });

  it('添加超过 3 个新增名时只预览前 3 个', async () => {
    const { buildUploadPreviewSummary, MAX_NAME_PREVIEW } = await import('@/utils/syncPreview');
    const local = Array.from({ length: 5 }, (_, i) => makeGroup(`g-${i}`));
    const remote: any[] = [];
    const summary = buildUploadPreviewSummary(local, remote, 'overwrite');
    assert.equal(summary.additions, 5);
    assert.equal(summary.addedNames.length, 3);
  });

  it('忽略软删组（isDeleted=true）', async () => {
    const { buildUploadPreviewSummary } = await import('@/utils/syncPreview');
    const local = [makeGroup('active'), makeGroup('soft-deleted', { isDeleted: true })];
    const summary = buildUploadPreviewSummary(local, [], 'overwrite');
    assert.equal(summary.additions, 1, '软删组不应计入上传预览');
  });
});

describe('buildUploadPreviewSummary: merge 模式', () => {
  it('本地独有 + 云端独有 → 1 个 unchanged（云端）+ 1 个 addition（本地）', async () => {
    const { buildUploadPreviewSummary } = await import('@/utils/syncPreview');
    const local = [makeGroup('a')];
    const remote = [makeGroup('b')];
    const summary = buildUploadPreviewSummary(local, remote, 'merge');
    // merge 模式下「云端作为 target，本地 upsert 进去」：
    // - 云端已有的 b：unchanged
    // - 本地独有的 a：addition
    assert.equal(summary.additions, 1);
    assert.equal(summary.unchanged, 1);
    assert.equal(summary.afterCount, 2);
  });

  it('merge 模式下云端已有 + 本地同 id + 同内容 → unchanged', async () => {
    const { buildUploadPreviewSummary } = await import('@/utils/syncPreview');
    const g = makeGroup('a');
    const summary = buildUploadPreviewSummary([g], [g], 'merge');
    assert.equal(summary.unchanged, 1);
  });
});

describe('buildDownloadPreviewSummary: overwrite 模式', () => {
  it('下载会清空本地非云端组 → 显示 deletion', async () => {
    const { buildDownloadPreviewSummary } = await import('@/utils/syncPreview');
    const local = [makeGroup('local-only'), makeGroup('shared', { name: 'LocalVer' })];
    const remote = [makeGroup('shared', { name: 'RemoteVer' })];
    const summary = buildDownloadPreviewSummary(local, remote, 'overwrite', 'newest');

    assert.ok(summary.deletions >= 1, 'local-only 应被标记删除');
    assert.ok(summary.updates >= 1, 'shared 组名变更应被标记 update');
  });

  it('云端独有组 → 显示 addition', async () => {
    const { buildDownloadPreviewSummary } = await import('@/utils/syncPreview');
    const local: any[] = [];
    const remote = [makeGroup('new-from-cloud')];
    const summary = buildDownloadPreviewSummary(local, remote, 'overwrite', 'newest');
    assert.equal(summary.additions, 1);
  });

  it('本地和云端相同 → 全部 unchanged', async () => {
    const { buildDownloadPreviewSummary } = await import('@/utils/syncPreview');
    const groups = [makeGroup('a'), makeGroup('b')];
    const summary = buildDownloadPreviewSummary(groups, groups, 'overwrite', 'newest');
    assert.equal(summary.unchanged, 2);
    assert.equal(summary.additions, 0);
    assert.equal(summary.deletions, 0);
  });
});

describe('buildDownloadPreviewSummary: merge 模式', () => {
  it('merge 模式保留本地独有组（不会被标记删除）', async () => {
    const { buildDownloadPreviewSummary } = await import('@/utils/syncPreview');
    // 显式设 displayOrder: 0 避免 mergeTabGroups 自动填充触发 fingerprint 变化
    const local = [makeGroup('local-only', { displayOrder: 0 })];
    const remote: any[] = [];
    const summary = buildDownloadPreviewSummary(local, remote, 'merge', 'newest');
    assert.equal(summary.deletions, 0, 'merge 模式不应删除本地独有组');
    assert.equal(summary.unchanged, 1, '本地独有组在 merge 后保留 → unchanged');
  });

  it('merge 模式云端独有 → 显示 addition', async () => {
    const { buildDownloadPreviewSummary } = await import('@/utils/syncPreview');
    const local: any[] = [];
    const remote = [makeGroup('cloud-A'), makeGroup('cloud-B')];
    const summary = buildDownloadPreviewSummary(local, remote, 'merge', 'newest');
    assert.equal(summary.additions, 2);
  });

  it('merge 模式冲突组（同名同 id 不同内容）→ update', async () => {
    const { buildDownloadPreviewSummary } = await import('@/utils/syncPreview');
    const local = [makeGroup('shared', { name: 'Local', updatedAt: '2026-06-01' })];
    const remote = [makeGroup('shared', { name: 'Remote', updatedAt: '2026-06-04' })];
    const summary = buildDownloadPreviewSummary(local, remote, 'merge', 'newest');
    assert.equal(summary.updates, 1, '冲突组应被标记为 update');
  });
});

describe('buildDownloadPreviewSummary: 软删处理', () => {
  it('本地软删组在预览中被过滤', async () => {
    const { buildDownloadPreviewSummary } = await import('@/utils/syncPreview');
    const local = [makeGroup('active'), makeGroup('soft-del', { isDeleted: true })];
    const remote: any[] = [];
    const summary = buildDownloadPreviewSummary(local, remote, 'overwrite', 'newest');
    assert.equal(summary.beforeCount, 1, '软删组不计入预览基线');
  });
});

describe('SyncPreviewSummary 字段完整性', () => {
  it('返回所有必需字段', async () => {
    const { buildUploadPreviewSummary } = await import('@/utils/syncPreview');
    const summary = buildUploadPreviewSummary([makeGroup('a')], [], 'overwrite');
    assert.ok(typeof summary.additions === 'number');
    assert.ok(typeof summary.updates === 'number');
    assert.ok(typeof summary.deletions === 'number');
    assert.ok(typeof summary.unchanged === 'number');
    assert.ok(typeof summary.beforeCount === 'number');
    assert.ok(typeof summary.afterCount === 'number');
    assert.ok(Array.isArray(summary.addedNames));
    assert.ok(Array.isArray(summary.updatedNames));
    assert.ok(Array.isArray(summary.deletedNames));
  });
});
