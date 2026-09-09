// 钉死阶段二存量数据迁移（规格 §7）：
// - 无 stamp 的实体 → 盖 legacy stamp = { d: "legacy", s: version || 1 }
// - 墓碑保留 isDeleted + legacy stamp
// - 已带 stamp 的实体（d !== "legacy"）跳过（幂等）
// - tab 也走相同规则
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

describe('opStampMigration: 存量数据盖 legacy 印记（§7）', () => {
  it('无 stamp 的实体 → 盖 legacy stamp = { d: "legacy", s: version || 1 }', async () => {
    const { migrateOpStamps } = await import('@/utils/opStampMigration');
    const out = migrateOpStamps([
      { id: 'g1', name: 'g', tabs: [], createdAt: NOW, updatedAt: NOW, version: 3, isDeleted: false, isLocked: false } as any,
    ]);
    assert.equal(out.migrated, 1);
    assert.deepEqual(out.groups[0].lastOp, { d: 'legacy', s: 3 });
  });

  it('墓碑保留 isDeleted + legacy stamp', async () => {
    const { migrateOpStamps } = await import('@/utils/opStampMigration');
    const out = migrateOpStamps([
      { id: 'g1', name: 'g', tabs: [], createdAt: NOW, updatedAt: NOW, version: 1, isDeleted: true, isLocked: false } as any,
    ]);
    assert.equal(out.groups[0].isDeleted, true);
    assert.deepEqual(out.groups[0].lastOp, { d: 'legacy', s: 1 });
  });

  it('已带 stamp 的实体（d !== "legacy"）跳过（幂等）', async () => {
    const { migrateOpStamps } = await import('@/utils/opStampMigration');
    const out = migrateOpStamps([
      { id: 'g1', name: 'g', tabs: [], createdAt: NOW, updatedAt: NOW, version: 1, isDeleted: false, isLocked: false, lastOp: { d: 'devA', s: 50 } } as any,
    ]);
    assert.equal(out.migrated, 0);
    assert.deepEqual(out.groups[0].lastOp, { d: 'devA', s: 50 });
  });

  it('tab 也走相同规则', async () => {
    const { migrateOpStamps } = await import('@/utils/opStampMigration');
    const out = migrateOpStamps([
      {
        id: 'g1',
        name: 'g',
        tabs: [
          { id: 't1', url: 'u', title: 't', favicon: '', createdAt: NOW, lastAccessed: NOW, pinned: false } as any,
        ],
        createdAt: NOW, updatedAt: NOW, version: 1, isDeleted: false, isLocked: false,
      } as any,
    ]);
    assert.equal(out.migrated, 2); // 1 组 + 1 tab
    assert.deepEqual(out.groups[0].tabs[0].lastOp, { d: 'legacy', s: 1 });
  });

  it('version 缺失时 s 默认 1（兜底）', async () => {
    const { migrateOpStamps } = await import('@/utils/opStampMigration');
    const out = migrateOpStamps([
      { id: 'g1', name: 'g', tabs: [], createdAt: NOW, updatedAt: NOW, isDeleted: false, isLocked: false } as any,
    ]);
    assert.deepEqual(out.groups[0].lastOp, { d: 'legacy', s: 1 });
  });

  it('不修改已有 d=legacy 的 stamp（幂等二次运行）', async () => {
    const { migrateOpStamps } = await import('@/utils/opStampMigration');
    const out = migrateOpStamps([
      { id: 'g1', name: 'g', tabs: [], createdAt: NOW, updatedAt: NOW, version: 1, isDeleted: false, isLocked: false, lastOp: { d: 'legacy', s: 5 } } as any,
    ]);
    // 已带 stamp 视为已迁移，跳过 → migrated = 0；stamp 原值保留
    assert.equal(out.migrated, 0);
    assert.deepEqual(out.groups[0].lastOp, { d: 'legacy', s: 5 });
  });

  it('空 groups → migrated=0，groups=[]', async () => {
    const { migrateOpStamps } = await import('@/utils/opStampMigration');
    const out = migrateOpStamps([]);
    assert.equal(out.migrated, 0);
    assert.deepEqual(out.groups, []);
  });
});