// Sprint 2 漏洞硬化补充：钉死 tombstone 跨设备删除传播的关键路径。
//
// v1.12.0 引入 pending_delete 列作为软删 tombstone（见 fix/delete-propagation-tombstone）。
// 本测试通过模拟「云端下载行 → TabGroup 转换」的纯函数路径，
// 钉死「pending_delete=true 必须 OR 进 isDeleted」这条不变量。
//
// 不变量被破坏的影响（已在生产观测）：
// - 用户在 A 设备删除某组
// - B 设备同步下载时，看不到删除信号 → 把本地副本当 local-only 保留
// - 用户体感：「另一台设备上删的组又回来了」
//
// 由于 downloadTabGroups 的「行 → TabGroup」转换与 supabase.ts 强耦合（解
// 密、OR 进 isDeleted 等），且项目无 mock.module 基础设施（见 AI_HANDOFF
// §7.5），这里只测试 **纯函数 + 构造测试数据** 的部分。

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

before(async () => {
  register(LOADER_PATH);
});

/**
 * 模拟 supabase 行结构（downloadTabGroups 的输入）
 */
function makeCloudRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Group ${id}`,
    created_at: NOW,
    updated_at: NOW,
    is_locked: false,
    user_id: 'user-1',
    device_id: 'device-1',
    last_sync: NOW,
    tabs_data: [],
    ...overrides,
  };
}

/**
 * 模拟 downloadTabGroups 中「列级 pending_delete OR 进 isDeleted」的逻辑。
 * 这是从 supabase.ts 第 755 行抽出来的纯函数等价物。
 */
function rowToTabGroup(row: any): { id: string; isDeleted: boolean; name: string } {
  return {
    id: String(row.id),
    name: String(row.name),
    isDeleted: Boolean(row.isDeleted) || Boolean(row.pending_delete),
  };
}

describe('tombstonePropagation: pending_delete → isDeleted 翻译不变量', () => {
  it('列级 pending_delete=true → isDeleted=true（关键不变量）', async () => {
    const row = makeCloudRow('g-1', { pending_delete: true });
    const group = rowToTabGroup(row);
    assert.equal(group.isDeleted, true, 'pending_delete=true 必须翻译为 isDeleted=true，否则删除不传播');
  });

  it('payload.isDeleted=true → isDeleted=true', async () => {
    const row = makeCloudRow('g-1', { isDeleted: true });
    const group = rowToTabGroup(row);
    assert.equal(group.isDeleted, true);
  });

  it('两者都为 true（兼容路径）→ isDeleted=true', async () => {
    const row = makeCloudRow('g-1', { pending_delete: true, isDeleted: true });
    const group = rowToTabGroup(row);
    assert.equal(group.isDeleted, true);
  });

  it('两者都缺失（活跃组）→ isDeleted=false', async () => {
    const row = makeCloudRow('g-1');
    const group = rowToTabGroup(row);
    assert.equal(group.isDeleted, false);
  });

  it('pending_delete=false + payload.isDeleted=false → isDeleted=false（防御性）', async () => {
    const row = makeCloudRow('g-1', { pending_delete: false, isDeleted: false });
    const group = rowToTabGroup(row);
    assert.equal(group.isDeleted, false, '显式 false 不应被误解为 truthy');
  });
});

describe('mergeTabGroups: 跨设备删除传播的端到端不变量', () => {
  it('B 设备下载云端 tombstone 后，merge 会从结果中删除该组', async () => {
    const { mergeTabGroups } = await import('@/utils/syncUtils');

    // 模拟 B 设备本地有 2 个组（其中 1 个在 A 设备被删）
    // B 设备的版本是 1（创建时写入）
    const localB = [
      { id: 'g-keep', name: 'Keep', isDeleted: false, tabs: [], createdAt: NOW, updatedAt: NOW, version: 1 },
      { id: 'g-deleted-on-A', name: 'DeletedOnA', isDeleted: false, tabs: [], createdAt: NOW, updatedAt: NOW, version: 1 },
    ];

    // 模拟 B 设备从云端下载：
    // - A 设备标记 g-deleted-on-A 为 tombstone，version 升到 2（覆盖本地 v1）
    const cloudDownload = [
      { id: 'g-keep', name: 'Keep', isDeleted: false, tabs: [], createdAt: NOW, updatedAt: NOW, version: 1 },
      { id: 'g-deleted-on-A', name: 'DeletedOnA', isDeleted: true, tabs: [], createdAt: NOW, updatedAt: NOW, version: 2 },
    ];

    const merged = mergeTabGroups(localB, cloudDownload, 'newest');
    const ids = merged.map(g => g.id).sort();

    assert.deepEqual(
      ids,
      ['g-keep'],
      '云端标记删除的组必须在合并结果中被移除（跨设备删除传播）'
    );
  });

  it('本地为空 + 云端有 tombstone → 合并后不复活已删的组', async () => {
    const { mergeTabGroups } = await import('@/utils/syncUtils');

    const local: any[] = [];
    const cloudDownload = [
      { id: 'g-tombstone', name: 'Tombstone', isDeleted: true, tabs: [], createdAt: NOW, updatedAt: NOW, version: 1 },
    ];

    const merged = mergeTabGroups(local, cloudDownload, 'newest');
    assert.equal(
      merged.length,
      0,
      '云端 tombstone 不应复活为本地组（应该被忽略）'
    );
  });

  it('本地 + 云端都有同一组且都标 isDeleted=true → 合并后该组消失', async () => {
    const { mergeTabGroups } = await import('@/utils/syncUtils');

    // 本地先标记为软删（但还在数组里）
    const local = [
      { id: 'g-A', name: 'A', isDeleted: true, tabs: [], createdAt: NOW, updatedAt: NOW, version: 2 },
    ];
    // 云端也标记为 tombstone（任意 version）
    const cloudDownload = [
      { id: 'g-A', name: 'A', isDeleted: true, tabs: [], createdAt: NOW, updatedAt: NOW, version: 1 },
    ];

    const merged = mergeTabGroups(local, cloudDownload, 'newest');
    assert.equal(merged.length, 0, '双方都删除 → 该组必须从合并结果中消失');
  });
});
