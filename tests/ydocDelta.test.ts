// BUG 1/2/3/4 回归：真实 Y.Doc 走完整影子链路（withYDoc → plansToDoc →
// writeMaterializedView）。既有 tests/yShadow.test.ts 全部注入 FAKE docRunner，
// 真实路径零覆盖，两个 bug 因此绿着发布。
//
// 断言：
// (a) 捕获到的 update 是真增量（含回放后写入的变更，不含已存 state）；
// (b) Y.applyUpdate 按日志顺序回放能重建完整 state（增量可重放）；
// (c) 多事务产生的多个 update 用 Y.mergeUpdates 合并后可整体 apply
//     （拼接流会静默截断，只保留第一段）；
// (d) 物化视图会删除本次快照缺席的行，且 bulkPut 失败也关连接。
//
// @/ 别名模块只能在 register(loader) 之后【动态 import】。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as Y from 'yjs';

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

type Rec = { id: string };

function groupRec(id: string, seq: number) {
  return {
    id,
    name: `g-${id}`,
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    is_deleted: false,
    version: 1,
    last_op_device: 'devA',
    last_op_seq: seq,
  };
}
function tabRec(groupId: string, id: string, seq: number) {
  return {
    id,
    groupId,
    url: `https://e.com/${id}`,
    title: id,
    lastAccessed: NOW,
    is_deleted: false,
    last_op_device: 'devA',
    last_op_seq: seq,
  };
}

/** 造一份「已持久化」的 state（1 组 1 tab），返回 encodeStateAsUpdate 结果 */
function persistedState(Y_ROOT_KEYS: { GROUPS: string; TABS: string; ORDER: string }) {
  const doc = new Y.Doc();
  doc.getMap(Y_ROOT_KEYS.GROUPS).set('g1', groupRec('g1', 1));
  doc.getMap(Y_ROOT_KEYS.TABS).set('g1:t1', tabRec('g1', 't1', 1));
  doc.getArray(Y_ROOT_KEYS.ORDER).push(['g1']);
  return { update: Y.encodeStateAsUpdate(doc) };
}

/** 替身持久化：语义同 y-indexeddb —— 事务内 Y.applyUpdate 回放（会发 'update'） */
function fakePersistence(state: Uint8Array) {
  return async (doc: Y.Doc) => {
    doc.transact(() => {
      Y.applyUpdate(doc, state);
    });
    return { destroy: async () => {} };
  };
}

function groupIds(doc: Y.Doc, rootKey: string): string[] {
  return [...doc.getMap(rootKey).keys()].sort();
}
function tabIds(doc: Y.Doc, rootKey: string): string[] {
  return [...doc.getMap(rootKey).keys()].sort();
}

describe('BUG 1/2 · withYDoc 捕获的是可重放增量（真实 Y.Doc 全路径）', () => {
  it('捕获 update = 真增量：不含已存 state，且 applyUpdate 可重建完整 state', async () => {
    const { withYDoc, plansToDoc, readDocSnapshot, Y_ROOT_KEYS } = (await import(
      '@/core/ydoc'
    )) as typeof import('@/core/ydoc');
    const { writeMaterializedView, snapshotToRows } = (await import('@/core/yMaterialize')) as typeof import('@/core/yMaterialize');

    const { update: stateUpdate } = persistedState(Y_ROOT_KEYS);

    // 本次影子写：新组 g2（g1 保持不变）
    const plans = [
      {
        kind: 'upsertGroup' as const,
        group: groupRec('g2', 2),
        tabs: [tabRec('g2', 't2', 2)],
      },
      { kind: 'setOrder' as const, order: ['g1', 'g2'] },
    ];

    // 真增量的字节数：先回放 state，再同样写一次，量 update 事件
    // 注：update 字节数含 clientID/时钟，与具体 Doc 实例相关，故下面只做
    // 「小于 state+delta 拼接」的方向性断言，不做跨实例字节全等。
    const truth = new Y.Doc();
    Y.applyUpdate(truth, stateUpdate);
    let deltaBytes = 0;
    truth.on('update', (u: Uint8Array) => {
      deltaBytes = u.length;
    });
    plansToDoc(truth, plans, { d: 'devA', s: 2 });
    assert.ok(deltaBytes > 0, '真增量应非空');

    // 真实路径：withYDoc（带回放）→ plansToDoc → readDocSnapshot → 物化
    const out = await withYDoc(
      doc => {
        plansToDoc(doc, plans, { d: 'devA', s: 2 });
        return readDocSnapshot(doc);
      },
      { openPersistence: fakePersistence(stateUpdate) }
    );

    // (a) 是增量（结构性证据，取代已删除的字节数断言）：
    //     单独 apply 到空 doc 后只能得到本次事务写入的 g2，不含已存的 g1。
    //     旧的 `out.update.length < stateUpdate.length + deltaBytes` 字节数比较
    //     实测只差 0 字节（566 vs 566），clientID/时钟 ±1-2 字节就会随机变红。
    // (a') 单独 apply 到空 doc：只有 g2（不含已存的 g1）⇒ 证明不是全量快照
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, out.update);
    assert.deepEqual(groupIds(fresh, Y_ROOT_KEYS.GROUPS), ['g2']);
    assert.deepEqual(tabIds(fresh, Y_ROOT_KEYS.TABS), ['g2:t2']);

    // (b) 按日志顺序回放（state 先、增量后）重建完整 state
    const replayed = new Y.Doc();
    Y.applyUpdate(replayed, stateUpdate);
    Y.applyUpdate(replayed, out.update);
    assert.deepEqual(groupIds(replayed, Y_ROOT_KEYS.GROUPS), ['g1', 'g2']);
    assert.deepEqual(tabIds(replayed, Y_ROOT_KEYS.TABS), ['g1:t1', 'g2:t2']);
    assert.deepEqual(replayed.getArray(Y_ROOT_KEYS.ORDER).toArray(), ['g1', 'g2']);

    // 物化视图也随该快照走完（真实调用点）
    const mv = await writeMaterializedView(snapshotToRows(out.result));
    assert.deepEqual(mv, { persisted: false, groups: 2, tabs: 2 });
  });

  it('多个 update 分片用 Y.mergeUpdates 合并后整体 apply 不丢段（BUG 2）', async () => {
    const { withYDoc } = (await import('@/core/ydoc')) as typeof import('@/core/ydoc');

    // fn 内开两个事务 → 捕获 2 个 update；旧实现字节拼接，apply 只认第一段
    const out = await withYDoc(
      doc => {
        doc.transact(() => {
          doc.getMap('m').set('k1', 'v1');
        });
        doc.transact(() => {
          doc.getMap('m').set('k2', 'v2');
        });
        return null;
      },
      { loadPersisted: false }
    );

    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, out.update); // 旧实现在此静默只剩 { k1: 'v1' }
    assert.deepEqual(fresh.getMap('m').toJSON(), { k1: 'v1', k2: 'v2' });
  });

  it('无变更（fn 不写）→ 捕获空 update，不产生噪声日志', async () => {
    const { withYDoc } = (await import('@/core/ydoc')) as typeof import('@/core/ydoc');
    const out = await withYDoc(() => null, { loadPersisted: false });
    assert.equal(out.update.length, 0);
  });
});

describe('BUG 3/4 · Dexie 物化视图删除缺席行 + 必关连接', () => {
  interface FakeDb {
    db: import('@/core/yMaterialize').MVDbLike;
    rows: Map<string, Map<string, Rec>>;
    closed: number;
  }
  function fakeDb(opts: { failOn?: string } = {}): FakeDb {
    const rows = new Map<string, Map<string, Rec>>([
      ['tab_groups', new Map()],
      ['tabs', new Map()],
    ]);
    const state: FakeDb = { db: null as never, rows, closed: 0 };
    state.db = {
      version: () => ({ stores: () => undefined }),
      table<T extends { id: string }>(name: string) {
        return {
          toCollection: () => ({ primaryKeys: async () => [...(rows.get(name) ?? new Map()).keys()] }),
          bulkPut: async (list: T[]) => {
            if (opts.failOn === name) throw new Error('bulkPut boom');
            const m = rows.get(name) ?? new Map<string, Rec>();
            for (const r of list) m.set(r.id, r);
            rows.set(name, m);
          },
          bulkDelete: async (keys: string[]) => {
            const m = rows.get(name);
            if (m) for (const k of keys) m.delete(k);
          },
        };
      },
      close: () => {
        state.closed += 1;
      },
    };
    return state;
  }
  function ids(f: FakeDb, name: string): string[] {
    return [...(f.rows.get(name) ?? new Map()).keys()].sort();
  }

  it('第二次写入会删除快照缺席的组与 tab（purge / 移出组）', async () => {
    const { writeMaterializedView, snapshotToRows } = (await import(
      '@/core/yMaterialize'
    )) as typeof import('@/core/yMaterialize');
    const f = fakeDb();

    const first = await writeMaterializedView(
      {
        groups: [
          { ...groupRec('g1', 1), tabCount: 1 },
          { ...groupRec('g2', 1), tabCount: 1 },
        ],
        tabs: [
          { ...tabRec('g1', 't1', 1), updatedAt: NOW },
          { ...tabRec('g1', 't2', 1), updatedAt: NOW },
          { ...tabRec('g2', 't3', 1), updatedAt: NOW },
        ],
      },
      { createDb: () => f.db }
    );
    assert.equal(first.persisted, true);
    assert.deepEqual(ids(f, 'tab_groups'), ['g1', 'g2']);
    assert.deepEqual(ids(f, 'tabs'), ['t1', 't2', 't3']);

    // g1 整体 purge（removeGroup）：Y.Doc 里 g1 与其 tab 都没了
    const purged = snapshotToRows({
      groups: { g2: groupRec('g2', 1) },
      tabs: { 'g2:t3': tabRec('g2', 't3', 1) },
      order: ['g2'],
    });
    const second = await writeMaterializedView(purged, { createDb: () => f.db });
    assert.equal(second.persisted, true);
    assert.deepEqual(ids(f, 'tab_groups'), ['g2'], '组 g1 必须从物化视图删除');
    // 注：MVTabRow.id 沿用 YTabRec.id（tabId），故 tabs 表主键即 tabId
    assert.deepEqual(ids(f, 'tabs'), ['t3'], 'g1 的 tab 镜像必须删除');

    // 组内 tab 被删：tab 行也要收敛
    await writeMaterializedView(
      {
        groups: [{ ...groupRec('g2', 2), tabCount: 0 }],
        tabs: [],
      },
      { createDb: () => f.db }
    );
    assert.deepEqual(ids(f, 'tabs'), []);
  });

  it('bulkPut 失败 → persisted:false 且连接仍被关闭（BUG 4）', async () => {
    const { writeMaterializedView } = (await import('@/core/yMaterialize')) as typeof import('@/core/yMaterialize');
    const f = fakeDb({ failOn: 'tab_groups' });
    const out = await writeMaterializedView(
      { groups: [{ ...groupRec('g1', 1), tabCount: 0 }], tabs: [] },
      { createDb: () => f.db }
    );
    assert.equal(out.persisted, false);
    assert.equal(f.closed, 1, '失败路径也必须 close()');
  });
});
