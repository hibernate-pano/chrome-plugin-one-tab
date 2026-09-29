// P0+P1 同步可靠性 6 项修复的回归测试（纯函数/可注入层，无网络无 chrome 依赖）。
//
// 覆盖：
// - P0-3 hasRemoteChanges 以单调 seq 为主信号（syncUtils，之前是 syncEngine 私有函数）
// - P0-1 compareUploadReadback / compareTombstoneReadback / compareHardDeleteReadback
// - P0-3 applyRemoveTab 同步提升组级印记
// - P1-6 purgeGroup 仅允许清回收站墓碑 + purge id 出队
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

const NOW = '2026-09-23T08:00:00.000Z';

function makeGroup(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    tabs: [],
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    version: 1,
    ...overrides,
  };
}

// ── P0-3：hasRemoteChanges seq 为主 ──────────────────────────────────────
describe('P0-3 hasRemoteChanges: 单调 seq 为主信号，时间戳仅参考', () => {
  it('seq 不等 → 有变更（即使 updated_at/version 完全相同）', async () => {
    const { hasRemoteChanges } = await import('@/core/syncDecision');
    const local = [makeGroup('g', { lastOp: { d: 'devA', s: 5 } })];
    const digest = [{ id: 'g', updated_at: NOW, version: 1, last_op_device: 'devA', last_op_seq: 7 }];
    assert.equal(hasRemoteChanges(local as any, digest), true);
  });

  it('云端有印记、本地无印记 → 有变更（迁移前本地 vs 已迁移云端不漏判）', async () => {
    const { hasRemoteChanges } = await import('@/core/syncDecision');
    const local = [makeGroup('g')];
    const digest = [{ id: 'g', updated_at: NOW, version: 1, last_op_device: 'devA', last_op_seq: 3 }];
    assert.equal(hasRemoteChanges(local as any, digest), true);
  });

  it('device 不同但 seq 相同 → 有变更（同 seq 不同设备不可视为同一意图）', async () => {
    const { hasRemoteChanges } = await import('@/core/syncDecision');
    const local = [makeGroup('g', { lastOp: { d: 'devA', s: 5 } })];
    const digest = [{ id: 'g', updated_at: NOW, version: 1, last_op_device: 'devB', last_op_seq: 5 }];
    assert.equal(hasRemoteChanges(local as any, digest), true);
  });

  it('seq/device/version/时间戳全一致 → 无变更（短路成立）', async () => {
    const { hasRemoteChanges } = await import('@/core/syncDecision');
    const local = [makeGroup('g', { lastOp: { d: 'devA', s: 5 } })];
    const digest = [{ id: 'g', updated_at: NOW, version: 1, is_deleted: false, last_op_device: 'devA', last_op_seq: 5 }];
    assert.equal(hasRemoteChanges(local as any, digest), false);
  });

  it('seq 相等但 version 不等 → 仍判有变更（seq 相等不屏蔽其他信号）', async () => {
    const { hasRemoteChanges } = await import('@/core/syncDecision');
    const local = [makeGroup('g', { lastOp: { d: 'devA', s: 5 } })];
    const digest = [{ id: 'g', updated_at: NOW, version: 2, last_op_device: 'devA', last_op_seq: 5 }];
    assert.equal(hasRemoteChanges(local as any, digest), true);
  });

  it('最小列 digest（无印记列）+ 时间戳一致 → 无变更（未迁移云端 fail-open 不误报）', async () => {
    const { hasRemoteChanges } = await import('@/core/syncDecision');
    const local = [makeGroup('g')];
    const digest = [{ id: 'g', updated_at: NOW, version: 1 }];
    assert.equal(hasRemoteChanges(local as any, digest), false);
  });

  it('最小列 digest + updated_at 不等 → 有变更（Web 端只触时间戳的写不漏判）', async () => {
    const { hasRemoteChanges } = await import('@/core/syncDecision');
    const local = [makeGroup('g')];
    const digest = [{ id: 'g', updated_at: '2026-09-23T09:00:00.000Z', version: 1 }];
    assert.equal(hasRemoteChanges(local as any, digest), true);
  });
});

// ── P0-1：上传/软删/硬删读回比对 ─────────────────────────────────────────
describe('P0-1 读回比对：静默吞写必须现形', () => {
  it('compareUploadReadback：全一致 → ok', async () => {
    const { compareUploadReadback } = await import('@/utils/supabaseFacade');
    const r = compareUploadReadback(
      [{ id: 'g', updatedAt: NOW, lastOp: { d: 'devA', s: 9 } }],
      [{ id: 'g', updated_at: NOW, last_op_device: 'devA', last_op_seq: 9, is_deleted: false }],
      { checkStamp: true, checkTombstone: true }
    );
    assert.equal(r.ok, true);
  });

  it('compareUploadReadback：云端缺行 → 不 ok（守卫吞写现形）', async () => {
    const { compareUploadReadback } = await import('@/utils/supabaseFacade');
    const r = compareUploadReadback(
      [{ id: 'g', updatedAt: NOW, lastOp: { d: 'devA', s: 9 } }],
      [],
      { checkStamp: true, checkTombstone: true }
    );
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /缺失/);
  });

  it('compareUploadReadback：印记不一致 → 不 ok', async () => {
    const { compareUploadReadback } = await import('@/utils/supabaseFacade');
    const r = compareUploadReadback(
      [{ id: 'g', updatedAt: NOW, lastOp: { d: 'devA', s: 9 } }],
      [{ id: 'g', updated_at: NOW, last_op_device: 'devA', last_op_seq: 4, is_deleted: false }],
      { checkStamp: true, checkTombstone: true }
    );
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /印记/);
  });

  it('compareUploadReadback：未迁移环境 checkStamp=false 时忽略印记列', async () => {
    const { compareUploadReadback } = await import('@/utils/supabaseFacade');
    const r = compareUploadReadback(
      [{ id: 'g', updatedAt: NOW, lastOp: { d: 'devA', s: 9 } }],
      [{ id: 'g', updated_at: NOW }],
      { checkStamp: false, checkTombstone: false }
    );
    assert.equal(r.ok, true);
  });

  it('compareUploadReadback：活跃组读回 is_deleted=true → 不 ok（复位失败现形）', async () => {
    const { compareUploadReadback } = await import('@/utils/supabaseFacade');
    const r = compareUploadReadback(
      [{ id: 'g', updatedAt: NOW }],
      [{ id: 'g', updated_at: NOW, is_deleted: true }],
      { checkStamp: false, checkTombstone: true }
    );
    assert.equal(r.ok, false);
  });

  it('compareTombstoneReadback：目标行缺失或 is_deleted 非 true → 不 ok', async () => {
    const { compareTombstoneReadback } = await import('@/utils/supabaseFacade');
    assert.equal(compareTombstoneReadback(['a'], [{ id: 'a', is_deleted: true }]).ok, true);
    assert.equal(compareTombstoneReadback(['a'], []).ok, false);
    assert.equal(compareTombstoneReadback(['a'], [{ id: 'a', is_deleted: false }]).ok, false);
  });

  it('compareHardDeleteReadback：有残留 → 不 ok；清空 → ok', async () => {
    const { compareHardDeleteReadback } = await import('@/utils/supabaseFacade');
    assert.equal(compareHardDeleteReadback(['a'], []).ok, true);
    const r = compareHardDeleteReadback(['a', 'b'], [{ id: 'b' }]);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /残留/);
  });
});

// ── P0-3：removeTab 提升组印记（无墓碑模型：组是 LWW 广播载体）──────────
describe('P0-3 applyRemoveTab: 标签删除同步提升组级印记', () => {
  it('删 tab 后组 lastOp 盖新 stamp；被删 tab 物理移除无实体可盖', async () => {
    const { applyRemoveTab } = await import('@/core/mutationOps');
    const stamp = { d: 'devA', s: 42 };
    const groups = [
      makeGroup('g', {
        tabs: [
          { id: 't1', url: 'https://a.com', title: 'a', createdAt: NOW, lastAccessed: NOW, pinned: false },
          { id: 't2', url: 'https://b.com', title: 'b', createdAt: NOW, lastAccessed: NOW, pinned: false },
        ],
      }),
    ];
    const r = applyRemoveTab(groups as any, 'g', 't1', NOW, stamp as any);
    assert.deepEqual(r.groups[0].lastOp, stamp);
    assert.equal(r.groups[0].tabs.some((t: any) => t.id === 't1'), false, '被删 tab 物理移除');
  });
});

// ── 无墓碑模型：deleteGroup 门禁 + 出队 ─────────────────────────────────
describe('deleteGroup: 本地物理移除 + 登记删除广播队列', () => {
  function memDeps(groups: any[]) {
    let store: any[] = [...groups];
    const noted: string[] = [];
    const uploads: number[] = [];
    const entries: any[] = [];
    let seqN = 100;
    return {
      store: () => store,
      noted,
      uploads,
      async getGroups() { return [...store]; },
      async setGroups(g: any[]) { store = [...g]; },
      scheduleUpload(ms: number) { uploads.push(ms); },
      now: () => NOW,
      journal: {
        async appendEntry(p: any) { seqN += 1; const e = { d: 'devT', s: seqN, ...p }; entries.push(e); return e; },
      },
      seq: {
        async nextSeq() { return ++seqN; },
        async getDeviceSeq() { return seqN; },
        async bumpSeqIfLower(c: number) { return c > seqN ? (seqN = c) : seqN; },
      },
      async noteGroupDeleted(id: string) { noted.push(id); },
    };
  }

  it('deleteGroup 活跃组 → ok:true，本地移除 + id 出队 + 调度上传', async () => {
    const { createMutationHandlers } = await import('@/background/mutationHandlers');
    const deps = memDeps([makeGroup('g', { isDeleted: false })]);
    const h = createMutationHandlers(deps as any);
    const res = await h.handle({ op: 'deleteGroup', groupId: 'g' });
    assert.equal(res.ok, true);
    assert.equal(deps.store().length, 0);
    assert.deepEqual(deps.noted, ['g']);
    assert.equal(deps.uploads.length, 1);
  });

  it('deleteGroup 老版本墓碑形状的组 → 同样物理移除并出队（残留兜底）', async () => {
    const { createMutationHandlers } = await import('@/background/mutationHandlers');
    const deps = memDeps([makeGroup('g', { isDeleted: true }), makeGroup('keep', {})]);
    const h = createMutationHandlers(deps as any);
    const res = await h.handle({ op: 'deleteGroup', groupId: 'g' });
    assert.equal(res.ok, true);
    assert.deepEqual(deps.store().map((g: any) => g.id), ['keep']);
    assert.deepEqual(deps.noted, ['g']);
    assert.equal(deps.uploads.length, 1);
  });

  it('deleteGroup 不存在的组 → ok:true 且不出队（幂等）', async () => {
    const { createMutationHandlers } = await import('@/background/mutationHandlers');
    const deps = memDeps([]);
    const h = createMutationHandlers(deps as any);
    const res = await h.handle({ op: 'deleteGroup', groupId: 'nope' });
    assert.equal(res.ok, true, '幂等：组不存在时原样返回');
    assert.deepEqual(deps.noted, []);
  });
});
