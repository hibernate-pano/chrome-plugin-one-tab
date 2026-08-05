// S1 §3: 加密失败逃生口——exportRawBackup 原始（未解密）导出。
//
// 与 syncStatusPersistence.test.ts 同一套基础设施：
// - fake-indexeddb + chrome polyfill + alias loader
// - beforeEach 用 storage.clear() 重置落盘态（固定 key 无法按 id 隔离）

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import 'fake-indexeddb/auto';

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

const GROUPS_KEY = 'tab_groups';

before(async () => {
  register(LOADER_PATH);
  (globalThis as any).chrome = {
    runtime: { id: 'test-extension-id-backup-utils' },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
  };
});

beforeEach(async () => {
  const { storage } = await import('@/utils/storage');
  await storage.clear();
});

async function readBlobJson(blob: Blob): Promise<any> {
  return JSON.parse(await blob.text());
}

describe('exportRawBackup: 原始数据导出（不解密）', () => {
  it('损坏的加密 blob（字符串）→ 拿到原始字节原样，format/version/exportedAt 正确', async () => {
    const { kvSet } = await import('@/storage/storageAdapter');
    // 模拟 key 漂移后「解密不出来」的损坏加密串（SECURE_V1 前缀 + 垃圾内容）
    const corruptedBlob = 'SECURE_V1:!!not-valid-base64-garbage!!';

    await kvSet(GROUPS_KEY, corruptedBlob);

    const { exportRawBackup } = await import('@/utils/backupUtils');
    const blob = await exportRawBackup();

    assert.ok(blob instanceof Blob, '应返回 Blob');
    assert.equal(blob.type, 'application/json');

    const payload = await readBlobJson(blob);
    assert.equal(payload.format, 'tabstack-raw');
    assert.equal(payload.version, 2);
    assert.ok(typeof payload.exportedAt === 'string' && !Number.isNaN(Date.parse(payload.exportedAt)));
    // 关键：原始加密字节原样保留，不经过解密/重编码
    assert.equal(payload.blob, corruptedBlob, '原始加密串必须逐字节保留');
  });

  it('ArrayBuffer 原始值 → base64 保留（可逆）', async () => {
    const { kvSet } = await import('@/storage/storageAdapter');
    const bytes = new TextEncoder().encode('raw-binary-payload-123');
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    await kvSet(GROUPS_KEY, buf);

    const { exportRawBackup } = await import('@/utils/backupUtils');
    const blob = await exportRawBackup();
    const payload = await readBlobJson(blob);

    assert.equal(payload.format, 'tabstack-raw');
    const decoded = new Uint8Array(atob(payload.blob).split('').map(c => c.charCodeAt(0)));
    assert.deepEqual(decoded, bytes, 'base64 解码后应与原始字节一致');
  });

  it('无数据 → 返回 null', async () => {
    const { exportRawBackup } = await import('@/utils/backupUtils');
    const blob = await exportRawBackup();
    assert.equal(blob, null, 'GROUPS key 不存在时应返回 null');
  });
});

describe('rawBackupFilename', () => {
  it('文件名格式: tabstack-raw-backup-YYYY-MM-DD.json', async () => {
    const { rawBackupFilename } = await import('@/utils/backupUtils');
    const name = rawBackupFilename(new Date('2026-08-05T12:00:00.000Z'));
    assert.equal(name, 'tabstack-raw-backup-2026-08-05.json');
  });

  it('默认使用今天（不抛错，格式匹配）', async () => {
    const { rawBackupFilename } = await import('@/utils/backupUtils');
    const name = rawBackupFilename();
    assert.match(name, /^tabstack-raw-backup-\d{4}-\d{2}-\d{2}\.json$/);
  });
});
