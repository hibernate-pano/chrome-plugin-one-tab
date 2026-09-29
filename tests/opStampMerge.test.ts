// 钉死组级 LWW（整组覆盖）合并纯函数（无墓碑模型，2026-09-29）：
// - 组是合并的最小单位：两端都有 → 组 stamp（lastOp）大者整组赢（tabs 全跟赢家）
// - 云端 is_deleted 行 = 删除广播：本地无副本 → 跳过；本地有副本 → stamp 决胜
//   （云端新 → 本地组服从删除；本地新 → 保留本地，下次上传覆盖云端墓碑）
// - 无 tab 级合并、无 URL 去重、合并不铸新 stamp
//
// 性质测试（交换律 / 幂等 / 收敛）保留：LWW 决胜确定性不变。
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
const STAMP_A = { d: 'devA', s: 1 };
const STAMP_B = { d: 'devB', s: 1 };

function mkG(id: string, tabs: any[] = [], over: any = {}) {
  return {
    id, name: `g-${id}`, tabs,
    createdAt: NOW, updatedAt: NOW,
    version: 1, isLocked: false,
    ...over,
  };
}
function mkT(id: string, url: string, over: any = {}) {
  return { id, url, title: id, favicon: '', createdAt: NOW, lastAccessed: NOW, pinned: false, ...over };
}

describe('mergeOpStamped: 交换律 / 幂等 / 收敛（性质测试）', () => {
  it('交换律: merge(A,B) ≡ merge(B,A)', async () => {
    const { mergeOpStamped } = await import('@/core/opStampMerge');
    const a = [mkG('g1', [mkT('t1', 'https://a')], { lastOp: STAMP_A })];
    const b = [mkG('g1', [mkT('t1', 'https://a')], { lastOp: STAMP_B, name: '改名' })];
    assert.deepEqual(mergeOpStamped(a, b), mergeOpStamped(b, a));
  });
  it('幂等: merge(A,A) ≡ A', async () => {
    const { mergeOpStamped } = await import('@/core/opStampMerge');
    const a = [mkG('g1', [mkT('t1', 'https://a')], { lastOp: STAMP_A })];
    assert.deepEqual(mergeOpStamped(a, a), a);
  });
  it('收敛: merge(merge(A,B),C) ≡ merge(merge(A,C),B)', async () => {
    const { mergeOpStamped } = await import('@/core/opStampMerge');
    const base = mkG('g1', [mkT('t1', 'https://a')], { lastOp: { d: 'devBase', s: 1 } });
    const a = [mkG('g1', [mkT('t1', 'https://a')], { lastOp: STAMP_A, name: 'A改' })];
    const b = [mkG('g1', [mkT('t1', 'https://a')], { lastOp: STAMP_B, name: 'B改' })];
    const c = [mkG('g1', [mkT('t1', 'https://a')], { lastOp: { d: 'devC', s: 99 }, name: 'C改' })];
    const lhs = mergeOpStamped(mergeOpStamped([base], a), c);
    const rhs = mergeOpStamped(mergeOpStamped([base], c), b);
    assert.deepEqual(lhs, rhs);
  });
});

describe('mergeOpStamped: 组级 LWW（整组覆盖）', () => {
  it('云端 stamp 更高 → 云端整组赢', async () => {
    const { mergeOpStamped } = await import('@/core/opStampMerge');
    const local = [mkG('g1', [mkT('tLocal', 'https://local')], { lastOp: { d: 'devA', s: 1 }, name: '本地名' })];
    const cloud = [mkG('g1', [mkT('tCloud', 'https://cloud')], { lastOp: { d: 'devB', s: 99 }, name: '云端名' })];
    const out = mergeOpStamped(local, cloud);
    assert.equal(out[0].name, '云端名');
    assert.deepEqual(out[0].tabs.map(t => t.id), ['tCloud'], 'tabs 整组跟赢家，不做 tab 级并集');
  });
  it('本地 stamp 更高 → 本地整组赢', async () => {
    const { mergeOpStamped } = await import('@/core/opStampMerge');
    const local = [mkG('g1', [mkT('tLocal', 'https://local')], { lastOp: { d: 'devA', s: 99 }, name: '本地' })];
    const cloud = [mkG('g1', [mkT('tCloud', 'https://cloud')], { lastOp: { d: 'devB', s: 1 }, name: '云端' })];
    const out = mergeOpStamped(local, cloud);
    assert.equal(out[0].name, '本地');
    assert.deepEqual(out[0].tabs.map(t => t.id), ['tLocal']);
  });
  it('无 stamp 的实体（全序最小值）→ 输给任何带 stamp 的实体', async () => {
    const { mergeOpStamped } = await import('@/core/opStampMerge');
    const local = [mkG('g1', [], { name: '老数据' })]; // 无 lastOp
    const cloud = [mkG('g1', [], { lastOp: STAMP_A, name: '新数据' })];
    const out = mergeOpStamped(local, cloud);
    assert.equal(out[0].name, '新数据');
  });
  it('单侧独有：保留', async () => {
    const { mergeOpStamped } = await import('@/core/opStampMerge');
    const local = [mkG('g1', [])];
    const cloud = [mkG('g2', [])];
    const out = mergeOpStamped(local, cloud);
    assert.equal(out.length, 2);
  });
  it('version 冻结：跟随赢家原值，不 max+1', async () => {
    const { mergeOpStamped } = await import('@/core/opStampMerge');
    const local = [mkG('g1', [], { lastOp: STAMP_A, version: 5 })];
    const cloud = [mkG('g1', [], { lastOp: STAMP_B, version: 7 })];
    const out = mergeOpStamped(local, cloud);
    assert.equal(out[0].version, 7);
  });
});

describe('mergeOpStamped: 删除广播（云端 is_deleted 行的服从语义）', () => {
  it('仅云端有且 is_deleted=true → 不收入（行永不入库）', async () => {
    const { mergeOpStamped } = await import('@/core/opStampMerge');
    const cloud = [mkG('g1', [mkT('t1', 'https://a')], { lastOp: STAMP_A, isDeleted: true })];
    const out = mergeOpStamped([], cloud);
    assert.equal(out.length, 0, '云端墓碑行不进合并结果');
  });
  it('云端墓碑 stamp 更新 → 本地活跃副本服从删除（物理移除）', async () => {
    const { mergeOpStamped } = await import('@/core/opStampMerge');
    const local = [mkG('g1', [mkT('t1', 'https://a')], { lastOp: { d: 'devA', s: 5 } })];
    const cloud = [mkG('g1', [mkT('t1', 'https://a')], { lastOp: { d: 'devB', s: 99 }, isDeleted: true })];
    const out = mergeOpStamped(local, cloud);
    assert.equal(out.length, 0, '删除广播生效：本地组被移除');
  });
  it('本地 stamp 更新（离线修改未上传）→ 本地活跃副本保留，删除被本地更新撤销', async () => {
    const { mergeOpStamped } = await import('@/core/opStampMerge');
    const local = [mkG('g1', [mkT('t1', 'https://a')], { lastOp: { d: 'devA', s: 99 }, name: '离线改名' })];
    const cloud = [mkG('g1', [mkT('t1', 'https://a')], { lastOp: { d: 'devB', s: 5 }, isDeleted: true })];
    const out = mergeOpStamped(local, cloud);
    assert.equal(out.length, 1);
    assert.notEqual(out[0].isDeleted, true, '本地活跃副本保留（非墓碑）');
    assert.equal(out[0].name, '离线改名');
  });
});

describe('mergeOpStamped: 无 tab 级合并 / 无 URL 去重（无墓碑模型）', () => {
  it('同 URL 不同 id 的 tab 不被去重：整组覆盖语义下 tabs 跟赢家', async () => {
    const { mergeOpStamped } = await import('@/core/opStampMerge');
    const local = [mkG('g1', [mkT('tLocal', 'https://x.com')], { lastOp: { d: 'devA', s: 5 } })];
    const cloud = [mkG('g1', [mkT('tCloud', 'https://x.com'), mkT('tCloud2', 'https://y.com')], { lastOp: { d: 'devB', s: 1 } })];
    const out = mergeOpStamped(local, cloud);
    // 本地 stamp 高 → 本地整组赢：云端 tabs 不并集进来
    assert.deepEqual(out[0].tabs.map(t => t.id), ['tLocal']);
  });
  it('合并不产生墓碑：任何输出的 tab/组都不带 isDeleted=true', async () => {
    const { mergeOpStamped } = await import('@/core/opStampMerge');
    const local = [mkG('g1', [mkT('t1', 'https://a')], { lastOp: { d: 'devA', s: 9 } })];
    const cloud = [mkG('g2', [mkT('t2', 'https://b')], { lastOp: { d: 'devB', s: 9 }, isDeleted: true })];
    const out = mergeOpStamped(local, cloud);
    assert.equal(out.some(g => g.isDeleted), false);
    assert.equal(out.some(g => g.tabs.some(t => t.isDeleted)), false);
  });
});

// ── 客户端决胜 与 服务端守卫放行 的一致性契约 ─────────────────────────────
// 这两个规则一个在 TS（谁赢）、一个在 SQL（谁能写）。两者不一致时会出现最糟的
// 静默状态：客户端认为「本地赢」，于是不上传（或上传后被丢弃），然后下次下载
// 又把本地改动覆盖回去 —— 用户看到编辑成功却消失。
// 历史事故正是如此：服务端用 NEW <= OLD 拒收，而客户端对「相等」判本地赢。
//
// 注意：下面的 serverAllows 是 SQL 守卫的 JS 镜像，其真实行为由
// tests/opStampGuard.pg.test.ts 在真实 Postgres 上钉死（两处必须一致）。
describe('客户端决胜 ↔ 服务端守卫 一致性（双侧都有印记、非墓碑翻转）', () => {
  /** supabase/migrations/20260910 守卫（修复后）：仅 NEW.s < OLD.s 拒收 */
  const serverAllows = (local: { s: number }, cloud: { s: number }) => !(local.s < cloud.s);

  it('客户端判「本地赢」时，服务端必须放行本次写入', async () => {
    const { compareStamps } = await import('@/core/opStamp');
    const stamps = [
      { d: 'devA', s: 1 }, { d: 'devA', s: 400 }, { d: 'devB', s: 1 },
      { d: 'devB', s: 400 }, { d: 'devC', s: 400 },
    ];
    for (const local of stamps) {
      for (const cloud of stamps) {
        const clientPicksLocal = compareStamps(local, cloud) >= 0;
        if (!clientPicksLocal) continue;
        assert.ok(
          serverAllows(local, cloud),
          `客户端判本地赢 (${local.d},${local.s}) vs 云端 (${cloud.d},${cloud.s})，但服务端会拒收 → 编辑静默丢失`
        );
      }
    }
  });

  it('服务端拒收时，客户端必须也判云端赢（否则本地留着永远不会上云的修改）', async () => {
    const { compareStamps } = await import('@/core/opStamp');
    const stamps = [
      { d: 'devA', s: 1 }, { d: 'devA', s: 400 }, { d: 'devB', s: 1 }, { d: 'devB', s: 400 },
    ];
    for (const local of stamps) {
      for (const cloud of stamps) {
        if (serverAllows(local, cloud)) continue;
        assert.ok(
          compareStamps(local, cloud) < 0,
          `服务端拒收 (${local.d},${local.s}) vs (${cloud.d},${cloud.s})，但客户端不认为云端赢`
        );
      }
    }
  });
});
