// S1 §6: syncEngine 集成测试（真实 SyncEngine 类 + 注入 fake deps）。
//
// 约束（AI_HANDOFF §7.5）：`mock.module` 与 `_alias-loader.mjs` 不兼容 →
// 不 mock 模块，直接用 v1.13.6 的 DI 缝（SyncEngineDeps）构造真实实例。
//
// 覆盖三种回归 + 两条状态契约：
//   1. 下载失败 → 回滚（本地不被污染）
//   2. tombstone 冲突 → 删除胜出（组不复活）
//   3. envelope 漂移（ENCRYPTED_V1 旧格式 / key 不匹配）→ 明确失败，不静默空
//   4. 上传失败 → retryable 标记 + 不写 lastSyncAt
//   5. 上传成功 → lastSyncAt 写入（+ lastSyncError 清除）
//
// 注意：syncEngine 的公共 API 是「返回 { success: false, ... }」而非抛错
// （S1a 已包层）。retryable 语义通过返回值的 retryable 字段暴露。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import 'fake-indexeddb/auto';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

const TEST_EXTENSION_ID = 'test-extension-id-sync-engine-integration';
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

/** 记录型 fake storage：追踪 setGroups / setLastSyncStatus 调用 */
function makeFakeStorage(initial: { groups?: any[] } = {}) {
  const state: {
    groups: any[];
    syncSnapshot: any[] | null;
    lastSyncTime: string | null;
    lastSyncStatus: { lastSyncAt: string | null; lastSyncError: string | null };
    setGroupsCalls: any[][];
    setLastSyncStatusCalls: Array<Record<string, unknown>>;
  } = {
    groups: initial.groups ?? [],
    syncSnapshot: null,
    lastSyncTime: null,
    lastSyncStatus: { lastSyncAt: null, lastSyncError: null },
    setGroupsCalls: [],
    setLastSyncStatusCalls: [],
  };

  return {
    state,
    async getGroups() { return [...state.groups]; },
    async setGroups(g: any[]) {
      state.groups = g;
      state.setGroupsCalls.push(g);
    },
    async setSyncSnapshot(snap: any[]) { state.syncSnapshot = snap; },
    async clearSyncSnapshot() { state.syncSnapshot = null; },
    async getSyncSnapshot() { return state.syncSnapshot; },
    async setLastSyncTime(t: string) { state.lastSyncTime = t; },
    async getLastSyncTime() { return state.lastSyncTime; },
    async getLastSyncStatus() { return { ...state.lastSyncStatus }; },
    async setLastSyncStatus(partial: Partial<{ lastSyncAt: string | null; lastSyncError: string | null }>) {
      state.lastSyncStatus = {
        lastSyncAt: partial.lastSyncAt !== undefined ? partial.lastSyncAt : state.lastSyncStatus.lastSyncAt,
        lastSyncError:
          partial.lastSyncError !== undefined ? partial.lastSyncError : state.lastSyncStatus.lastSyncError,
      };
      state.setLastSyncStatusCalls.push({ ...partial });
    },
  };
}

function makeFakeState(overrides: Record<string, unknown> = {}) {
  return () => ({
    auth: { isAuthenticated: true },
    settings: { syncStrategy: 'newest' },
    tabs: { lastLoadedAt: null },
    ...overrides,
  });
}

function makeGCStub() {
  return async () => ({ scanned: 0, deleted: 0, errors: 0 });
}

before(async () => {
  register(LOADER_PATH);
  (globalThis as any).chrome = {
    runtime: { id: TEST_EXTENSION_ID },
  };
});

describe('SyncEngine 集成: 下载失败 → 回滚', () => {
  it('deps.download 抛网络错误 → 失败返回（retryable），本地数据未被污染', async () => {
    const { SyncEngine } = await import('@/services/syncEngine');
    const localGroups = [makeGroup('local-A'), makeGroup('local-B')];
    const fakeStorage = makeFakeStorage({ groups: localGroups });

    const engine = new SyncEngine({
      storage: fakeStorage,
      downloadTabGroups: async () => {
        throw new TypeError('Failed to fetch');
      },
      cleanupCloudTombstones: makeGCStub(),
      getState: makeFakeState(),
    });

    const result = await engine.downloadAndMerge();

    // 失败被归一为 network 类错误（retryable=true），不静默吞掉
    assert.equal(result.success, false, '下载失败必须返回 success=false');
    assert.ok(result.reason?.includes('Failed to fetch'));
    assert.equal(result.retryable, true, '网络类失败应标记可重试');

    // 快照回滚：本地数据原样保留（最后一次 setGroups 写入的是快照，不是坏数据）
    assert.deepEqual(
      fakeStorage.state.groups.map((g: any) => g.id).sort(),
      ['local-A', 'local-B'],
      '本地数据应被快照回滚，未被空/损坏数据覆盖'
    );
    const lastSet = fakeStorage.state.setGroupsCalls[fakeStorage.state.setGroupsCalls.length - 1];
    assert.deepEqual(
      lastSet.map((g: any) => g.id).sort(),
      ['local-A', 'local-B'],
      'setGroups 不得写入损坏/空数据'
    );
    assert.equal(fakeStorage.state.syncSnapshot, null, '失败后快照应被清理');

    // 失败状态持久化：写 lastSyncError、不写 lastSyncAt
    assert.equal(fakeStorage.state.lastSyncStatus.lastSyncError, '网络连接失败，请检查网络设置');
    assert.equal(fakeStorage.state.lastSyncStatus.lastSyncAt, null, '失败不得覆盖/写入 lastSyncAt');
  });
});

describe('SyncEngine 集成: tombstone 冲突（删除胜出）', () => {
  it('本地 tombstone + 云端对该组的更新也是 tombstone → 合并后组不复活', async () => {
    const { SyncEngine } = await import('@/services/syncEngine');

    // 本地：g-keep 活跃；g-del 已本地删除（tombstone，v3）
    const localGroups = [
      makeGroup('g-keep', { version: 1 }),
      makeGroup('g-del', { version: 3, isDeleted: true, updatedAt: '2026-06-04T09:00:00.000Z' }),
    ];

    // 云端：g-keep 不变；g-del 的「最新更新」就是 tombstone——
    // 本设备删除后经 markCloudGroupsAsDeleted 把云端行置 pending_delete、
    // 版本递增（downloadTabGroups 把 pending_delete OR 进 isDeleted，
    // 见 tombstonePropagation 不变量测试）。
    const cloudGroups = [
      makeGroup('g-keep', { version: 1 }),
      makeGroup('g-del', { version: 4, isDeleted: true, updatedAt: '2026-06-04T10:00:00.000Z' }),
    ];

    const fakeStorage = makeFakeStorage({ groups: localGroups });
    const engine = new SyncEngine({
      storage: fakeStorage,
      downloadTabGroups: async () => cloudGroups,
      cleanupCloudTombstones: makeGCStub(),
      getState: makeFakeState(),
    });

    const result = await engine.downloadAndMerge();

    assert.equal(result.success, true);
    assert.deepEqual(
      result.groups.map((g: any) => g.id),
      ['g-keep'],
      '删除胜出：tombstone 组不得被复活'
    );
    assert.deepEqual(
      fakeStorage.state.groups.map((g: any) => g.id),
      ['g-keep'],
      '落盘结果同样不包含已删组'
    );
    // 成功路径写 lastSyncAt
    assert.ok(fakeStorage.state.lastSyncStatus.lastSyncAt, '成功应写入 lastSyncAt');
  });
});

describe('SyncEngine 集成: envelope 漂移（ENCRYPTED_V1 旧格式）', () => {
  it('云端 blob 用旧 V1 格式 + 不同 key 加密 → 解密失败明确报错，不静默空', async () => {
    const { SyncEngine } = await import('@/services/syncEngine');
    const { decryptLocalBlob } = await import('@/utils/secureStorage');
    const { decryptError } = await import('@/utils/errors');

    // 用「另一台设备」的 extension id 按 V1 格式（SECURE_V1: iv||ciphertext）
    // 加密云端数据——模拟旧格式 + key 漂移的真实产物。
    const V1_PREFIX = 'SECURE_V1:';
    const otherKeyHash = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode('another-device-extension-id' + 'storage_key_v1')
    );
    const otherKey = await crypto.subtle.importKey(
      'raw',
      otherKeyHash,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt']
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      otherKey,
      new TextEncoder().encode(JSON.stringify([makeGroup('cloud-A')]))
    );
    const v1Blob = V1_PREFIX + btoa(String.fromCharCode(...iv, ...new Uint8Array(ciphertext)));

    // 模拟 downloadTabGroups 的真实解密路径：V1 blob + 本地（新）key → 失败
    const driftDownload = async (): Promise<any[]> => {
      const groups = await decryptLocalBlob<any[]>(v1Blob);
      if (groups === null) {
        throw decryptError('云端 blob 为 ENCRYPTED_V1 旧格式，解密失败（key 漂移）');
      }
      return groups;
    };

    const localGroups = [makeGroup('local-A')];
    const fakeStorage = makeFakeStorage({ groups: localGroups });
    const engine = new SyncEngine({
      storage: fakeStorage,
      downloadTabGroups: driftDownload,
      cleanupCloudTombstones: makeGCStub(),
      getState: makeFakeState(),
    });

    const result = await engine.downloadAndMerge();

    // 不静默：失败必须被明确暴露（success=false + 原因透出 + retryable=false）
    assert.equal(result.success, false, '解密失败不得返回 success=true 的空结果');
    assert.ok(
      result.reason?.includes('ENCRYPTED_V1') || result.reason?.includes('key 漂移'),
      `失败原因应透出解密错误，实际: ${result.reason}`
    );
    assert.equal(result.retryable, false, 'decrypt 类错误不可重试');

    // 本地数据不被清空（回滚保住了快照）
    assert.deepEqual(
      fakeStorage.state.groups.map((g: any) => g.id),
      ['local-A'],
      '解密失败后本地数据不得被清空'
    );
    // 失败状态持久化为 decrypt 用户文案
    assert.equal(
      fakeStorage.state.lastSyncStatus.lastSyncError,
      '数据解密失败，数据可能已损坏或密钥不匹配'
    );
    assert.equal(fakeStorage.state.lastSyncStatus.lastSyncAt, null);
  });
});

describe('SyncEngine 集成: 上传失败可重试', () => {
  it('deps.upload 抛网络错误 → retryable=true，不写 lastSyncAt', async () => {
    const { SyncEngine } = await import('@/services/syncEngine');
    const fakeStorage = makeFakeStorage({ groups: [makeGroup('a')] });

    const engine = new SyncEngine({
      storage: fakeStorage,
      uploadTabGroups: async () => {
        throw new TypeError('Failed to fetch');
      },
      markCloudGroupsAsDeleted: async () => {},
      cleanupCloudTombstones: makeGCStub(),
      getState: makeFakeState(),
    });

    const result = await engine.upload();

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Failed to fetch'));
    assert.equal(result.retryable, true, '网络类上传失败应标记可重试');

    assert.equal(fakeStorage.state.lastSyncStatus.lastSyncAt, null, '失败不得写 lastSyncAt');
    assert.equal(fakeStorage.state.lastSyncStatus.lastSyncError, '网络连接失败，请检查网络设置');
  });
});

describe('SyncEngine 集成: 成功路径写 lastSyncAt', () => {
  it('deps.upload 成功 → setLastSyncStatus 写入 lastSyncAt（并清除上次错误）', async () => {
    const { SyncEngine } = await import('@/services/syncEngine');
    // 上次失败状态：lastSyncError 已存在——成功必须把它清掉
    const fakeStorage = makeFakeStorage({ groups: [makeGroup('a')] });
    fakeStorage.state.lastSyncStatus = {
      lastSyncAt: '2026-06-04T08:00:00.000Z',
      lastSyncError: '网络连接失败，请检查网络设置',
    };

    const engine = new SyncEngine({
      storage: fakeStorage,
      uploadTabGroups: async () => {},
      markCloudGroupsAsDeleted: async () => {},
      cleanupCloudTombstones: makeGCStub(),
      getState: makeFakeState(),
    });

    const before = Date.now();
    const result = await engine.upload();
    const after = Date.now();

    assert.equal(result.success, true);
    assert.equal(result.retryable, undefined, '成功结果无 retryable 标记');

    // setLastSyncStatus 确实被调用，且带 lastSyncAt
    assert.ok(
      fakeStorage.state.setLastSyncStatusCalls.some(c => 'lastSyncAt' in c),
      '成功路径必须调用 setLastSyncStatus 写入 lastSyncAt'
    );
    const lastSyncAt = fakeStorage.state.lastSyncStatus.lastSyncAt;
    assert.ok(lastSyncAt, 'lastSyncAt 应被写入');
    const t = new Date(lastSyncAt!).getTime();
    assert.ok(t >= before && t <= after, 'lastSyncAt 应在调用期间');

    // 成功清除上次错误（避免 rose dot / SyncTab 错误说明残留）
    assert.equal(fakeStorage.state.lastSyncStatus.lastSyncError, null);
  });
});
