// D3 墓碑 7 天单测：deletedAt 盖戳/恢复清空、编解码往返、sweep 语义、audit 比对。
//
// 文件头部样板与 tests/yAudit.test.ts 一致：
// @/ 别名模块只能在 register(loader) 之后【动态 import】。
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

const NOW = Date.parse('2026-09-26T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

type TombMod = typeof import('@/core/tombstone');
type OpsMod = typeof import('@/core/mutationOps');
type CodecMod = typeof import('@/core/tabDataCodec');
type AuditMod = typeof import('@/core/yAudit');

let tomb: TombMod;
let ops: OpsMod;
let codec: CodecMod;
let auditMod: AuditMod;
before(async () => {
  tomb = await import('@/core/tombstone');
  ops = await import('@/core/mutationOps');
  codec = await import('@/core/tabDataCodec');
  auditMod = await import('@/core/yAudit');
});

const STAMP = { d: 'devTest', s: 7 };

function mkGroup(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: `G-${id}`,
    tabs: [],
    createdAt: iso(NOW - 30 * DAY),
    updatedAt: iso(NOW - 30 * DAY),
    isLocked: false,
    ...over,
  };
}

describe('mutationOps deletedAt', () => {
  it('applyDeleteGroup 盖 deletedAt=now', () => {
    const now = iso(NOW);
    // 用有内容的组：空壳会话按 2026-09-28 统一规则走硬删除（不留墓碑、无 deletedAt）
    const g = { ...mkGroup('g1'), tabs: [{ id: 't1', url: 'https://a.com', title: 'A', createdAt: iso(NOW), lastAccessed: iso(NOW), pinned: false }] };
    const out = ops.applyDeleteGroup([g as never], 'g1', now, STAMP).groups;
    assert.equal(out[0].isDeleted, true);
    assert.equal(out[0].deletedAt, now);
  });

  it('applyDeleteGroup：空壳会话硬删除，不产生墓碑/deletedAt', () => {
    const now = iso(NOW);
    const r = ops.applyDeleteGroup([mkGroup('shell') as never], 'shell', now, STAMP);
    assert.equal(r.groups.length, 0, '空壳组被物理移除');
    assert.equal(r.hardDeletedGroupId, 'shell');
  });

  it('applyRemoveTab 盖 tab 级 deletedAt=now', () => {
    const tab = {
      id: 't1', url: 'https://a.com', title: 'A', createdAt: iso(NOW),
      lastAccessed: iso(NOW), pinned: false,
    };
    const g = { ...mkGroup('g1'), tabs: [tab, { ...tab, id: 't2' }] };
    const now = iso(NOW);
    const { groups } = ops.applyRemoveTab([g] as never, 'g1', 't1', now, STAMP);
    const t1 = groups[0].tabs.find((t: { id: string }) => t.id === 't1');
    assert.equal(t1.isDeleted, true);
    assert.equal(t1.deletedAt, now);
  });

  it('applyRestoreGroup 清空 deletedAt', () => {
    const g = { ...mkGroup('g1'), isDeleted: true, deletedAt: iso(NOW - DAY) };
    const { restored } = ops.applyRestoreGroup([g] as never, 'g1', iso(NOW), STAMP);
    assert.equal(restored!.isDeleted, false);
    assert.equal(restored!.deletedAt, undefined);
  });
});

describe('tabDataCodec deleted_at', () => {
  it('serialize/deserialize 往返 deletedAt', () => {
    const tab = {
      id: 't1', url: 'https://a.com', title: 'A', createdAt: iso(NOW),
      lastAccessed: iso(NOW), pinned: false, isDeleted: true, deletedAt: iso(NOW - DAY),
    };
    const wire = codec.serializeTab(tab as never);
    assert.equal((wire as Record<string, unknown>).deleted_at, iso(NOW - DAY));
    const back = codec.deserializeTab(wire, 'g1');
    assert.equal(back!.deletedAt, iso(NOW - DAY));
  });

  it('缺失 deleted_at → undefined（老数据兼容）', () => {
    const tab = {
      id: 't1', url: 'https://a.com', title: 'A', createdAt: iso(NOW),
      lastAccessed: iso(NOW), pinned: false,
    };
    const back = codec.deserializeTab(codec.serializeTab(tab as never), 'g1');
    assert.equal(back!.deletedAt, undefined);
  });
});

describe('sweepExpiredTombstones', () => {
  it('7 天内墓碑保留', () => {
    const g = mkGroup('g1', { isDeleted: true, deletedAt: iso(NOW - 6 * DAY) });
    const r = tomb.sweepExpiredTombstones([g] as never, NOW);
    assert.equal(r.groups.length, 1);
    assert.deepEqual(r.sweptGroupIds, []);
  });

  it('满 7 天整组清除', () => {
    const g = mkGroup('g1', { isDeleted: true, deletedAt: iso(NOW - 7 * DAY) });
    const r = tomb.sweepExpiredTombstones([g] as never, NOW);
    assert.equal(r.groups.length, 0);
    assert.deepEqual(r.sweptGroupIds, ['g1']);
  });

  it('无 deletedAt 回退 updatedAt（老数据）', () => {
    const fresh = mkGroup('g1', { isDeleted: true, updatedAt: iso(NOW - DAY) });
    delete (fresh as Record<string, unknown>).deletedAt;
    assert.equal(tomb.sweepExpiredTombstones([fresh] as never, NOW).groups.length, 1);
    const stale = mkGroup('g2', { isDeleted: true, updatedAt: iso(NOW - 8 * DAY) });
    delete (stale as Record<string, unknown>).deletedAt;
    const r = tomb.sweepExpiredTombstones([stale] as never, NOW);
    assert.deepEqual(r.sweptGroupIds, ['g2']);
  });

  it('过期 tab 从组内摘除，未到期保留', () => {
    const g = {
      ...mkGroup('g1'),
      tabs: [
        { id: 'old', url: 'https://a.com', title: 'A', createdAt: iso(NOW), lastAccessed: iso(NOW), pinned: false, isDeleted: true, deletedAt: iso(NOW - 8 * DAY) },
        { id: 'new', url: 'https://b.com', title: 'B', createdAt: iso(NOW), lastAccessed: iso(NOW), pinned: false, isDeleted: true, deletedAt: iso(NOW - DAY) },
      ],
    };
    const r = tomb.sweepExpiredTombstones([g] as never, NOW);
    assert.equal(r.groups.length, 1);
    assert.deepEqual(r.groups[0].tabs.map((t: { id: string }) => t.id), ['new']);
    assert.deepEqual(r.sweptTabKeys, ['g1:old']);
  });

  it('摘空且未锁定 → 整组连带移除；锁定组保留空壳', () => {
    const open = {
      ...mkGroup('g1'),
      tabs: [{ id: 'old', url: 'https://a.com', title: 'A', createdAt: iso(NOW), lastAccessed: iso(NOW), pinned: false, isDeleted: true, deletedAt: iso(NOW - 8 * DAY) }],
    };
    const r1 = tomb.sweepExpiredTombstones([open] as never, NOW);
    assert.deepEqual(r1.sweptGroupIds, ['g1']);
    const locked = { ...open, id: 'g2', isLocked: true };
    const r2 = tomb.sweepExpiredTombstones([locked] as never, NOW);
    assert.equal(r2.groups.length, 1);
    assert.equal(r2.groups[0].tabs.length, 0);
  });

  it('活跃组（isDeleted 非 true）原样保留', () => {
    const g = mkGroup('g1');
    const r = tomb.sweepExpiredTombstones([g] as never, NOW);
    assert.equal(r.groups.length, 1);
    assert.equal(r.groups[0], g);
  });
});

describe('audit 含 deletedAt 比对', () => {
  it('deletedAt 分叉 → mismatch', async () => {
    const local = [{ ...mkGroup('g1', { isDeleted: true, deletedAt: iso(NOW - DAY) }), tabs: [] }];
    const y = {
      groups: [{ id: 'g1', name: 'G-g1', createdAt: local[0].createdAt, updatedAt: local[0].updatedAt, isLocked: false, is_deleted: true, version: 1, last_op_device: null, last_op_seq: null, tabCount: 0 }],
      tabs: [],
    };
    const r = auditMod.auditShadowConsistency(y as never, local as never);
    assert.ok(r.mismatches.some(m => m.scope === 'group' && m.field === 'deletedAt'));
  });
});
