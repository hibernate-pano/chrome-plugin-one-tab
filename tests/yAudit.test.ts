// P1 影子对账单测：纯函数 auditShadowConsistency + 采样执行器 maybeAuditConsistency。
//
// 文件头部样板与 tests/yShadow.test.ts 一致：
// @/ 别名模块只能在 register(loader) 之后【动态 import】。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
// 纯类型导入：编译期擦除，运行时零依赖，故不受「@/ 必须 register(loader) 后动态 import」的约束。
import type { Tab, TabGroup } from '@/types/tab';

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

type AuditMod = typeof import('@/core/yAudit');

let audit: AuditMod;
before(async () => {
  audit = await import('@/core/yAudit');
});

// tabs 入参是「只给关心的字段」的偏量：Partial<Tab> 而不是 Record<string, unknown>——
// 后者让 t.id 取出来是 unknown，拼出来的 tab 根本不是 Tab（TS2322）。
function mkGroup(id: string, tabs: Array<Partial<Tab>> = [], over: Partial<TabGroup> = {}): TabGroup {
  return {
    id,
    name: `G-${id}`,
    tabs: tabs.map((t, i) => ({
      id: t.id ?? `t${i}`,
      url: t.url ?? 'https://a.com',
      title: t.title ?? 'A',
      createdAt: t.createdAt ?? '2026-09-26T00:00:00.000Z',
      lastAccessed: t.lastAccessed ?? '2026-09-26T00:00:00.000Z',
      pinned: t.pinned ?? false,
      ...(t.isDeleted === true ? { isDeleted: true } : {}),
    })),
    createdAt: '2026-09-26T00:00:00.000Z',
    updatedAt: '2026-09-26T00:00:00.000Z',
    isLocked: false,
    ...over,
  };
}

function toY(local: Array<ReturnType<typeof mkGroup>>) {
  // 与 toYGroupRec/toYTabRecs 同口径的手工镜像（含墓碑位）
  const groups = local.map(g => ({
    id: g.id,
    name: g.name,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
    isLocked: g.isLocked,
    is_deleted: g.isDeleted === true,
    version: 1,
    last_op_device: null,
    last_op_seq: null,
    tabCount: g.tabs.filter((t: { isDeleted?: boolean }) => !t.isDeleted).length,
  }));
  const tabs: Array<Record<string, unknown>> = [];
  for (const g of local) {
    for (const t of g.tabs) {
      tabs.push({
        id: `${g.id}:${t.id}`,
        groupId: g.id,
        url: t.url,
        title: t.title,
        lastAccessed: t.lastAccessed,
        is_deleted: t.isDeleted === true,
        last_op_device: null,
        last_op_seq: null,
        updatedAt: t.lastAccessed,
      });
    }
  }
  return { groups, tabs };
}

describe('auditShadowConsistency', () => {
  it('完全一致 → match=true，零 mismatch', () => {
    const local = [mkGroup('g1', [{ id: 't1' }, { id: 't2' }]), mkGroup('g2', [])];
    const r = audit.auditShadowConsistency(toY(local) as never, local as never);
    assert.equal(r.match, true);
    assert.equal(r.mismatches.length, 0);
    assert.equal(r.checkedGroups, 2);
    assert.equal(r.checkedTabs, 2);
    assert.equal(r.mismatchRate, 0);
  });

  it('组改名 → group/name mismatch', () => {
    const local = [mkGroup('g1')];
    const y = toY(local) as { groups: Array<Record<string, unknown>>; tabs: Array<Record<string, unknown>> };
    y.groups[0].name = '改过名';
    const r = audit.auditShadowConsistency(y as never, local as never);
    assert.equal(r.match, false);
    assert.equal(r.mismatches[0].scope, 'group');
    assert.equal(r.mismatches[0].field, 'name');
  });

  it('本地删 tab（墓碑）但 Y 仍活跃 → tab/is_deleted mismatch（防复活探针）', () => {
    const local = [mkGroup('g1', [{ id: 't1', isDeleted: true }])];
    const y = toY([mkGroup('g1', [{ id: 't1' }])]);
    const r = audit.auditShadowConsistency(y as never, local as never);
    assert.equal(r.match, false);
    assert.ok(r.mismatches.some(m => m.scope === 'tab' && m.field === 'is_deleted'));
  });

  it('Y 残留本地已无的 tab → missing_local（物化差集删除回归探针）', () => {
    const local = [mkGroup('g1', [])];
    const y = toY([mkGroup('g1', [{ id: 'ghost' }])]);
    const r = audit.auditShadowConsistency(y as never, local as never);
    assert.ok(r.mismatches.some(m => m.scope === 'tab' && m.field === 'missing_local'));
  });

  it('组顺序分叉 → order mismatch 只记一条', () => {
    const local = [mkGroup('g1'), mkGroup('g2')];
    const y = toY([mkGroup('g2'), mkGroup('g1')]);
    const r = audit.auditShadowConsistency(y as never, local as never);
    const orders = r.mismatches.filter(m => m.scope === 'order');
    assert.equal(orders.length, 1);
    assert.equal(orders[0].id, 'pos:0');
  });

  it('mismatch 上限截断：100 个坏 tab 只记 20 条', () => {
    const tabs = Array.from({ length: 100 }, (_, i) => ({ id: `t${i}` }));
    const local = [mkGroup('g1', tabs)];
    const yLocal = [mkGroup('g1', tabs.map(t => ({ ...t, url: 'https://other.com' })))];
    const r = audit.auditShadowConsistency(toY(yLocal) as never, local as never);
    assert.equal(r.mismatches.length, 20);
    assert.equal(r.match, false);
  });
});

describe('maybeAuditConsistency', () => {
  function mkDeps(over: Record<string, unknown> = {}) {
    const store = new Map<string, unknown>();
    const local = [mkGroup('g1', [{ id: 't1' }])];
    return {
      store,
      deps: {
        getGroups: async () => local,
        getUserId: async () => 'u1',
        kvGet: async (k: string) => (store.has(k) ? store.get(k) : null),
        kvSet: async (k: string, v: unknown) => {
          store.set(k, v);
        },
        readMaterialized: async () => toY(local),
        now: () => '2026-09-26T00:00:00.000Z',
        ...over,
      },
    };
  }

  it('采样命中（u1:37 实测命中 5%）→ 返回结果并写 y_audit_log', async () => {
    const { deps, store } = mkDeps({ sampleKey: 'u1:37' });
    const r = await audit.maybeAuditConsistency(37, deps as never);
    assert.notEqual(r, null);
    assert.equal(r!.match, true);
    assert.equal((store.get('y_audit_log') as Array<unknown>).length, 1);
  });

  it('采样命中 → 同时写按天聚合 y_audit_daily（门禁判定读这份）', async () => {
    const { deps, store } = mkDeps({ sampleKey: 'u1:37' });
    await audit.maybeAuditConsistency(37, deps as never);
    const daily = store.get('y_audit_daily') as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(daily), 'y_audit_daily 必须被写入');
    assert.equal(daily.length, 1);
    // now() 固定为 2026-09-26 → 桶落在这一天
    assert.equal(daily[0].date, '2026-09-26');
    assert.equal(daily[0].samples, 1);
    assert.equal(daily[0].overThresholdSamples, 0, '完全一致的对账不该记超阈');
    assert.equal(daily[0].worstMismatchRate, 0);
  });

  it('多次命中同一天 → 累加到同一个桶，而不是每天多行', async () => {
    const { deps, store } = mkDeps({ sampleKey: 'u1:37' });
    await audit.maybeAuditConsistency(37, deps as never);
    await audit.maybeAuditConsistency(37, deps as never);
    const daily = store.get('y_audit_daily') as Array<Record<string, unknown>>;
    assert.equal(daily.length, 1);
    assert.equal(daily[0].samples, 2);
  });

  it('聚合写入失败不影响对账结果返回（永不阻断主同步）', async () => {
    const { deps } = mkDeps({
      sampleKey: 'u1:37',
      // 只让 y_audit_daily 的写入炸掉：逐条日志照常，聚合失败被吞
      kvSet: async (k: string, v: unknown) => {
        if (k === 'y_audit_daily') throw new Error('quota exceeded');
        void v;
      },
    });
    const r = await audit.maybeAuditConsistency(37, deps as never);
    assert.notEqual(r, null, '聚合失败不该让对账结果变成 null');
  });

  it('采样未命中（u1:0 实测落空）→ 返回 null 且不读 Y 不写日志', async () => {
    let read = 0;
    const { deps, store } = mkDeps({
      sampleKey: 'u1:0',
      readMaterialized: async () => {
        read += 1;
        return toY([mkGroup('g1', [{ id: 't1' }])]);
      },
    });
    const r = await audit.maybeAuditConsistency(0, deps as never);
    assert.equal(r, null);
    assert.equal(read, 0);
    assert.equal(store.has('y_audit_log'), false);
  });

  it('reader 抛错 → 返回 null 且不抛（永不阻断主同步）', async () => {
    const { deps } = mkDeps({
      sampleKey: 'u1:37',
      readMaterialized: async () => {
        throw new Error('y damaged');
      },
    });
    const r = await audit.maybeAuditConsistency(37, deps as never);
    assert.equal(r, null);
  });

  it('getGroups 抛错 → 返回 null 且不抛', async () => {
    const { deps } = mkDeps({
      sampleKey: 'u1:37',
      getGroups: async () => {
        throw new Error('storage down');
      },
    });
    const r = await audit.maybeAuditConsistency(37, deps as never);
    assert.equal(r, null);
  });
});
