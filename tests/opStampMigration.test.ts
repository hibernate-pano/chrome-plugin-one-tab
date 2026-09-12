// 钉死阶段二存量数据迁移（规格 §7）：
// - 无 stamp 的实体 → 盖 { d: 本设备 id, s: version || 1 }
// - 墓碑保留 isDeleted + 补印记
// - 已带 stamp 的实体跳过（幂等）
// - tab 用所属组的 version 作序（不引入假设备 id）
//
// 文件样板与 tests/mutationOps.test.ts 一致：@/ 别名需在 register(loader) 之后动态 import。
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

before(async () => {
  register(LOADER_PATH);
});

const NOW = '2026-01-01T00:00:00.000Z';
const DEV = 'devA';

describe('opStampMigration: 存量数据补本设备印记（§7）', () => {
  it('无 stamp 的组 → 盖 { d: 本设备, s: version || 1 }', async () => {
    const { migrateOpStamps } = await import('@/utils/opStampMigration');
    const out = migrateOpStamps(
      [
        { id: 'g1', name: 'g', tabs: [], createdAt: NOW, updatedAt: NOW, version: 3, isDeleted: false, isLocked: false } as any,
      ],
      DEV
    );
    assert.equal(out.migrated, 1);
    assert.deepEqual(out.groups[0].lastOp, { d: DEV, s: 3 });
  });

  it('墓碑保留 isDeleted + 补印记', async () => {
    const { migrateOpStamps } = await import('@/utils/opStampMigration');
    const out = migrateOpStamps(
      [
        { id: 'g1', name: 'g', tabs: [], createdAt: NOW, updatedAt: NOW, version: 1, isDeleted: true, isLocked: false } as any,
      ],
      DEV
    );
    assert.equal(out.groups[0].isDeleted, true);
    assert.deepEqual(out.groups[0].lastOp, { d: DEV, s: 1 });
  });

  it('已带 stamp 的实体跳过（幂等）', async () => {
    const { migrateOpStamps } = await import('@/utils/opStampMigration');
    const out = migrateOpStamps(
      [
        { id: 'g1', name: 'g', tabs: [], createdAt: NOW, updatedAt: NOW, version: 1, isDeleted: false, isLocked: false, lastOp: { d: 'devB', s: 50 } } as any,
      ],
      DEV
    );
    assert.equal(out.migrated, 0);
    assert.deepEqual(out.groups[0].lastOp, { d: 'devB', s: 50 });
  });

  it('tab 补印记：与本组同序（不使用假设备 id）', async () => {
    const { migrateOpStamps } = await import('@/utils/opStampMigration');
    const out = migrateOpStamps(
      [
        {
          id: 'g1',
          name: 'g',
          tabs: [
            { id: 't1', url: 'u', title: 't', favicon: '', createdAt: NOW, lastAccessed: NOW, pinned: false } as any,
          ],
          createdAt: NOW, updatedAt: NOW, version: 7, isDeleted: false, isLocked: false,
        } as any,
      ],
      DEV
    );
    assert.equal(out.migrated, 2); // 1 组 + 1 tab
    assert.deepEqual(out.groups[0].lastOp, { d: DEV, s: 7 });
    assert.deepEqual(out.groups[0].tabs[0].lastOp, { d: DEV, s: 7 });
  });

  it('version 缺失时 s 默认 1（兜底）', async () => {
    const { migrateOpStamps } = await import('@/utils/opStampMigration');
    const out = migrateOpStamps(
      [{ id: 'g1', name: 'g', tabs: [], createdAt: NOW, updatedAt: NOW, isDeleted: false, isLocked: false } as any],
      DEV
    );
    assert.deepEqual(out.groups[0].lastOp, { d: DEV, s: 1 });
  });

  it('二次运行不修改已补的印记（幂等）', async () => {
    const { migrateOpStamps } = await import('@/utils/opStampMigration');
    const seeded = [{ id: 'g1', name: 'g', tabs: [], createdAt: NOW, updatedAt: NOW, version: 1, isDeleted: false, isLocked: false, lastOp: { d: DEV, s: 5 } } as any];
    const out = migrateOpStamps(seeded, DEV);
    assert.equal(out.migrated, 0);
    assert.deepEqual(out.groups[0].lastOp, { d: DEV, s: 5 });
  });

  it('两台设备迁移同一份旧数据 → 印记不同（保证合并可决定性收敛）', async () => {
    const { migrateOpStamps } = await import('@/utils/opStampMigration');
    const legacyGroup = { id: 'g1', name: 'g', tabs: [], createdAt: NOW, updatedAt: NOW, version: 4, isDeleted: false, isLocked: false } as any;
    const onA = migrateOpStamps([{ ...legacyGroup }], 'devA').groups[0];
    const onB = migrateOpStamps([{ ...legacyGroup }], 'devB').groups[0];
    assert.notDeepEqual(onA.lastOp, onB.lastOp, '两台设备盖出相同印记会让合并平局 → 各自保留副本、永不收敛');
  });

  it('空 groups → migrated=0，groups=[]', async () => {
    const { migrateOpStamps } = await import('@/utils/opStampMigration');
    const out = migrateOpStamps([], DEV);
    assert.equal(out.migrated, 0);
    assert.deepEqual(out.groups, []);
  });
});
