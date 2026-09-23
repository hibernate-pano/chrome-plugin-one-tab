// V2 影子双写单测：Y-Schema 翻译（幂等/stamp 门控）、灰度与开关、
// Dexie 物化映射、影子入口永不阻断主同步。
//
// 文件头部样板与 tests/mutationHandlers.test.ts 一致：
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

const NOW = '2026-09-24T00:00:00.000Z';
const STAMP = { d: 'devTest', s: 42 };

function mkTab(id: string, over: Record<string, unknown> = {}) {
  return {
    id, url: `https://e.com/${id}`, title: id, createdAt: NOW, lastAccessed: NOW,
    pinned: false, isDeleted: false, ...over,
  };
}
function mkGroup(id: string, tabs: unknown[], over: Record<string, unknown> = {}) {
  return {
    id, name: `g-${id}`, tabs, createdAt: NOW, updatedAt: NOW,
    version: 1, isDeleted: false, isLocked: false, ...over,
  };
}

function memKv() {
  const m = new Map<string, unknown>();
  return {
    async kvGet<T>(k: string): Promise<T | null> {
      return (m.has(k) ? m.get(k) : null) as T | null;
    },
    async kvSet(k: string, v: unknown): Promise<void> {
      m.set(k, v);
    },
    store: m,
  };
}

describe('yShadowConfig: 开关/灰度/阈值', () => {
  it('kill-switch 默认 ON，灰度默认 10%，compact 阈值 500 条 / 256KB', async () => {
    const cfg = await import('@/core/yShadowConfig');
    assert.equal(cfg.SHADOW_WRITE_ENABLED, true);
    assert.equal(cfg.SHADOW_ROLLOUT_PERCENT, 10);
    assert.equal(cfg.COMPACT_LOG_COUNT_THRESHOLD, 500);
    assert.equal(cfg.COMPACT_LOG_BYTES_THRESHOLD, 256 * 1024);
  });
  it('采样稳定且边界正确：0% 全拒、100% 全放、同一 userId 多次一致', async () => {
    const { isShadowSampled } = await import('@/core/yShadowConfig');
    assert.equal(isShadowSampled('any-user', 0), false);
    assert.equal(isShadowSampled('any-user', 100), true);
    const a = isShadowSampled('user-7', 10);
    assert.equal(isShadowSampled('user-7', 10), a);
  });
  it('10% 灰度下既有命中也有未命中（切流真实生效）', async () => {
    const { isShadowSampled } = await import('@/core/yShadowConfig');
    let hit = 0;
    for (let i = 0; i < 100; i++) if (isShadowSampled(`user-${i}`, 10)) hit++;
    assert.ok(hit > 0 && hit < 100, `期望部分命中，实际 ${hit}/100`);
  });
});

describe('yTranslate: MutationOp → Y 计划', () => {
  it('saveGroup：仅带本次 stamp 的组生成 upsertGroup，恒附 setOrder', async () => {
    const { planShadowSync } = await import('@/core/yTranslate');
    const g1 = mkGroup('g1', [mkTab('t1')], { lastOp: { ...STAMP } });
    const g2 = mkGroup('g2', [mkTab('t2')], { lastOp: { d: 'devTest', s: 1 } });
    const plans = planShadowSync(
      { op: 'saveGroup', group: g1 } as never, [g1, g2] as never, STAMP, NOW,
    );
    const upserts = plans.filter(p => p.kind === 'upsertGroup');
    assert.equal(upserts.length, 1);
    assert.equal((upserts[0] as { group: { id: string } }).group.id, 'g1');
    assert.equal(plans[plans.length - 1].kind, 'setOrder');
  });
  it('翻译表全覆盖：13 种 op 均可翻译，purgeGroup 生成 removeGroup', async () => {
    const { planShadowSync } = await import('@/core/yTranslate');
    const g = mkGroup('g1', [mkTab('t1')], { lastOp: { ...STAMP } });
    const ops = [
      { op: 'saveGroup', group: g },
      { op: 'removeTab', groupId: 'g1', tabId: 't1' },
      { op: 'deleteGroup', groupId: 'g1' },
      { op: 'deleteAllGroups' },
      { op: 'restoreGroup', groupId: 'g1' },
      { op: 'importGroups', groups: [g] },
      { op: 'renameGroup', groupId: 'g1', name: 'n' },
      { op: 'toggleGroupLock', groupId: 'g1' },
      { op: 'updateGroupFields', groupId: 'g1', fields: {} },
      { op: 'moveGroup', dragIndex: 0, hoverIndex: 0 },
      { op: 'moveTab', sourceGroupId: 'g1', sourceIndex: 0, targetGroupId: 'g1', targetIndex: 0 },
      { op: 'cleanDuplicates' },
    ] as never[];
    for (const op of ops) {
      const plans = planShadowSync(op as never, [g] as never, STAMP, NOW);
      assert.ok(plans.length >= 2, `${(op as { op: string }).op} 应产出 upsert+order`);
    }
    const purge = planShadowSync({ op: 'purgeGroup', groupId: 'g1' } as never, [] as never, STAMP, NOW);
    assert.equal(purge[0].kind, 'removeGroup');
  });
  it('applyYPlans 幂等：同一 plans 应用两次结果一致', async () => {
    const { planShadowSync, applyYPlans, newYState } = await import('@/core/yTranslate');
    const g = mkGroup('g1', [mkTab('t1')], { lastOp: { ...STAMP } });
    const plans = planShadowSync({ op: 'renameGroup', groupId: 'g1', name: 'n' } as never, [g] as never, STAMP, NOW);
    const s1 = newYState();
    applyYPlans(s1, plans, STAMP);
    const snap1 = JSON.stringify({ g: [...s1.groups.values()], t: [...s1.tabs.values()], o: s1.order });
    applyYPlans(s1, plans, STAMP);
    const snap2 = JSON.stringify({ g: [...s1.groups.values()], t: [...s1.tabs.values()], o: s1.order });
    assert.equal(snap1, snap2);
  });
  it('applyYPlans stamp 门控：旧 stamp 重放不覆盖新状态（后写赢）', async () => {
    const { applyYPlans, newYState } = await import('@/core/yTranslate');
    const newer = { d: 'devTest', s: 99 };
    const s = newYState();
    applyYPlans(
      s,
      [{ kind: 'upsertGroup', group: {
        id: 'g1', name: 'new', createdAt: NOW, updatedAt: NOW, isLocked: false,
        is_deleted: false, version: 2, last_op_device: 'devTest', last_op_seq: 99,
      }, tabs: [] }],
      newer,
    );
    applyYPlans(
      s,
      [{ kind: 'upsertGroup', group: {
        id: 'g1', name: 'old-replay', createdAt: NOW, updatedAt: NOW, isLocked: false,
        is_deleted: false, version: 1, last_op_device: 'devTest', last_op_seq: 42,
      }, tabs: [] }],
      STAMP,
    );
    assert.equal(s.groups.get('g1')!.name, 'new');
  });
});

describe('yMaterialize: 快照 → Dexie 行', () => {
  it('snapshotToRows：组行含 tabCount 且按 order 排序；tab 行 updatedAt 回填', async () => {
    const { snapshotToRows } = await import('@/core/yMaterialize');
    const rows = snapshotToRows({
      groups: {
        g1: {
          id: 'g1', name: 'a', createdAt: NOW, updatedAt: NOW, isLocked: false,
          is_deleted: false, version: 1, last_op_device: 'd', last_op_seq: 1,
        },
      },
      tabs: {
        'g1:t1': {
          id: 't1', groupId: 'g1', url: 'https://x.com', title: 'x',
          lastAccessed: NOW, is_deleted: false, last_op_device: 'd', last_op_seq: 1,
        },
        'g1:t2': {
          id: 't2', groupId: 'g1', url: 'https://y.com', title: 'y',
          lastAccessed: NOW, is_deleted: true, last_op_device: 'd', last_op_seq: 2,
        },
      },
      order: ['g1'],
    });
    assert.equal(rows.groups[0].tabCount, 1);
    assert.equal(rows.tabs.find(t => t.id === 't1')!.updatedAt, NOW);
  });
  it('stores schema 含 groupId/updatedAt/is_deleted 索引', async () => {
    const { MV_STORES_SCHEMA } = await import('@/core/yMaterialize');
    assert.ok(MV_STORES_SCHEMA.tab_groups.includes('updatedAt'));
    assert.ok(MV_STORES_SCHEMA.tab_groups.includes('is_deleted'));
    assert.ok(MV_STORES_SCHEMA.tabs.includes('groupId'));
    assert.ok(MV_STORES_SCHEMA.tabs.includes('updatedAt'));
    assert.ok(MV_STORES_SCHEMA.tabs.includes('is_deleted'));
  });
  it('writeMaterializedView 在无 indexedDB 环境不抛错（node），内存兜底可读', async () => {
    const { writeMaterializedView, readMemoryFallback } = await import('@/core/yMaterialize');
    const r = await writeMaterializedView({ groups: [], tabs: [] });
    assert.equal(r.persisted, false);
    assert.deepEqual(readMemoryFallback().groups, []);
  });
});

describe('yShadow.maybeShadowWrite: 永不抛错 + journallog 化', () => {
  async function sampledUser(): Promise<string> {
    const { isShadowSampled } = await import('@/core/yShadowConfig');
    for (let i = 0; i < 10000; i++) {
      if (isShadowSampled(`shadow-user-${i}`, 10)) return `shadow-user-${i}`;
    }
    throw new Error('找不到采样命中 user（实现漂移）');
  }
  function shadowDeps(over: Record<string, unknown> = {}) {
    const kv = memKv();
    return {
      ...kv,
      getGroups: async (): Promise<never[]> => [],
      getUserId: async () => 'user-0',
      docRunner: async () => ({ updateBytes: 10, updateB64: 'AAA' }),
      now: () => NOW,
      ...over,
    };
  }
  it('采样命中 + 快照带 stamp → ok:true，影子日志落盘', async () => {
    const { maybeShadowWrite } = await import('@/core/yShadow');
    const { SHADOW_LOG_KEY } = await import('@/core/yShadowConfig');
    const userId = await sampledUser();
    const g = mkGroup('g1', [mkTab('t1')], { lastOp: { ...STAMP } });
    const deps = shadowDeps({ getUserId: async () => userId, getGroups: async () => [g] });
    const out = await maybeShadowWrite(
      { op: 'renameGroup', groupId: 'g1', name: 'n' }, STAMP, NOW, deps as never,
    );
    assert.equal(out.ok, true);
    const log = await deps.kvGet(SHADOW_LOG_KEY) as unknown[];
    assert.equal(log.length, 1);
  });
  it('未命中灰度 → skipped:rollout，且 docRunner 未被调用', async () => {
    const { maybeShadowWrite } = await import('@/core/yShadow');
    const { isShadowSampled } = await import('@/core/yShadowConfig');
    let unhit = 'user-0';
    for (let i = 0; i < 10000; i++) {
      if (!isShadowSampled(`cold-user-${i}`, 10)) { unhit = `cold-user-${i}`; break; }
    }
    let called = 0;
    const g = mkGroup('g1', [], { lastOp: { ...STAMP } });
    const deps = shadowDeps({
      getUserId: async () => unhit,
      getGroups: async () => [g],
      docRunner: async () => { called++; return { updateBytes: 1, updateB64: 'A' }; },
    });
    const out = await maybeShadowWrite({ op: 'deleteGroup', groupId: 'g1' }, STAMP, NOW, deps as never);
    assert.deepEqual(out, { ok: false, skipped: 'rollout' });
    assert.equal(called, 0);
  });
  it('快照无本次 stamp → skipped:empty（并发覆盖不写 Y）', async () => {
    const { maybeShadowWrite } = await import('@/core/yShadow');
    const userId = await sampledUser();
    const g = mkGroup('g1', [], { lastOp: { d: 'other', s: 999 } });
    const deps = shadowDeps({ getUserId: async () => userId, getGroups: async () => [g] });
    const out = await maybeShadowWrite({ op: 'renameGroup', groupId: 'g1', name: 'n' }, STAMP, NOW, deps as never);
    assert.deepEqual(out, { ok: false, skipped: 'empty' });
  });
  it('docRunner 抛错 → skipped:error 且外层永不抛错', async () => {
    const { maybeShadowWrite } = await import('@/core/yShadow');
    const userId = await sampledUser();
    const g = mkGroup('g1', [], { lastOp: { ...STAMP } });
    const deps = shadowDeps({
      getUserId: async () => userId,
      getGroups: async () => [g],
      docRunner: async () => { throw new Error('y exploded'); },
    });
    const out = await maybeShadowWrite({ op: 'deleteGroup', groupId: 'g1' }, STAMP, NOW, deps as never);
    assert.equal(out.ok, false);
    assert.equal((out as { skipped: string }).skipped, 'error');
  });
  it('update 日志达 compact 阈值 → needsSnapshot=true', async () => {
    const { maybeShadowWrite } = await import('@/core/yShadow');
    const { Y_UPDATE_LOG_KEY } = await import('@/core/yShadowConfig');
    const userId = await sampledUser();
    const g = mkGroup('g1', [], { lastOp: { ...STAMP } });
    const deps = shadowDeps({ getUserId: async () => userId, getGroups: async () => [g] });
    const preload = Array.from({ length: 499 }, (_, i) => ({
      ts: NOW, stamp: { d: 'd', s: i }, op: 'renameGroup', updateB64: 'A', updateBytes: 600,
    }));
    await deps.kvSet(Y_UPDATE_LOG_KEY, preload);
    const out = await maybeShadowWrite({ op: 'renameGroup', groupId: 'g1', name: 'n' }, STAMP, NOW, deps as never);
    assert.equal(out.ok, true);
    assert.equal((out as { needsSnapshot: boolean }).needsSnapshot, true);
  });
});

describe('mutationHandlers 影子接线：成功后触发、失败不阻断', () => {
  function memStorage() {
    let groups: never[] = [];
    const entries: { d: string; s: number }[] = [];
    let seqN = 0;
    return {
      async getGroups(): Promise<never[]> { return [...groups]; },
      async setGroups(g: never[]): Promise<void> { groups = [...g]; },
      scheduleUpload(): void {},
      now: () => NOW,
      journal: {
        async appendEntry(p: unknown) {
          seqN += 1;
          const e = { d: 'devTest', s: seqN, ...(p as object) };
          entries.push(e as { d: string; s: number });
          return e;
        },
        async read() { return entries; },
        async markConfirmedUpTo() { return 0; },
      },
      seq: {
        async nextSeq() { return ++seqN; },
        async getDeviceSeq() { return seqN; },
        async bumpSeqIfLower(c: number) { return c > seqN ? (seqN = c) : seqN; },
      },
    };
  }
  it('主写 ok → shadowWrite 被调用且携带本次 stamp；返回值不受影响', async () => {
    const { createMutationHandlers } = await import('@/background/mutationHandlers');
    const deps = memStorage();
    const calls: unknown[] = [];
    const handlers = createMutationHandlers({
      ...deps,
      shadowWrite: (a: unknown) => { calls.push(a); },
    } as never);
    const res = await handlers.handle({ op: 'deleteAllGroups' });
    await new Promise(r => setTimeout(r, 10)); // fire-and-forget 落定
    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);
    assert.equal((calls[0] as { stamp: { d: string; s: number } }).stamp.s, 1);
  });
  it('shadowWrite 同步抛错 → 主写仍 ok:true（影子永不阻断）', async () => {
    const { createMutationHandlers } = await import('@/background/mutationHandlers');
    const deps = memStorage();
    const handlers = createMutationHandlers({
      ...deps,
      shadowWrite: () => { throw new Error('shadow down'); },
    } as never);
    const res = await handlers.handle({ op: 'deleteAllGroups' });
    assert.equal(res.ok, true);
  });
  it('主写失败（restoreGroup 未找到）→ shadowWrite 不被调用', async () => {
    const { createMutationHandlers } = await import('@/background/mutationHandlers');
    const deps = memStorage();
    let called = 0;
    const handlers = createMutationHandlers({
      ...deps,
      shadowWrite: () => { called++; },
    } as never);
    const res = await handlers.handle({ op: 'restoreGroup', groupId: 'missing' });
    await new Promise(r => setTimeout(r, 10));
    assert.equal(res.ok, false);
    assert.equal(called, 0);
  });
});
