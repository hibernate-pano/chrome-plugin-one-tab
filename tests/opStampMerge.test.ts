// 钉死按 OpStamp 全序决胜的合并纯函数（规格 §5）：
// - §5.1 组级：并集 + 按 stamp 决胜；墓碑也参与比较
// - §5.2 组字段：name/isFavorite/displayOrder 跟随组 stamp 赢家；isLocked OR；version 冻结
// - §5.3 标签级：tab 按 id 并集 + stamp 决胜
// - §5.4 URL 去重：同 URL 多活跃 stamp 决胜，败者盖墓碑 + mergeStamp
//
// 性质测试（§10）：交换律 / 幂等 / 收敛——验收"确定性"。
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
    version: 1, isDeleted: false, isLocked: false,
    ...over,
  };
}
function mkT(id: string, url: string, over: any = {}) {
  return { id, url, title: id, favicon: '', createdAt: NOW, lastAccessed: NOW, pinned: false, isDeleted: false, ...over };
}

describe('mergeOpStamped: 交换律 / 幂等 / 收敛（§10 性质测试）', () => {
  it('交换律: merge(A,B) ≡ merge(B,A)', async () => {
    const { mergeOpStamped } = await import('@/utils/opStampMerge');
    const a = [mkG('g1', [mkT('t1', 'https://a')], { lastOp: STAMP_A })];
    const b = [mkG('g1', [mkT('t1', 'https://a')], { lastOp: STAMP_B, name: '改名' })];
    assert.deepEqual(mergeOpStamped(a, b), mergeOpStamped(b, a));
  });
  it('幂等: merge(A,A) ≡ A', async () => {
    const { mergeOpStamped } = await import('@/utils/opStampMerge');
    const a = [mkG('g1', [mkT('t1', 'https://a')], { lastOp: STAMP_A })];
    assert.deepEqual(mergeOpStamped(a, a), a);
  });
  it('收敛: merge(merge(A,B),C) ≡ merge(merge(A,C),B)', async () => {
    const { mergeOpStamped } = await import('@/utils/opStampMerge');
    const base = mkG('g1', [mkT('t1', 'https://a')], { lastOp: { d: 'devBase', s: 1 } });
    const a = [mkG('g1', [mkT('t1', 'https://a')], { lastOp: STAMP_A, name: 'A改' })];
    const b = [mkG('g1', [mkT('t1', 'https://a')], { lastOp: STAMP_B, name: 'B改' })];
    const c = [mkG('g1', [mkT('t1', 'https://a')], { lastOp: { d: 'devC', s: 99 }, name: 'C改' })];
    const lhs = mergeOpStamped(mergeOpStamped([base], a), c);
    const rhs = mergeOpStamped(mergeOpStamped([base], c), b);
    assert.deepEqual(lhs, rhs);
  });
});

describe('mergeOpStamped: §5.1/§5.2 组级', () => {
  it('云端 stamp 更高 → 云端赢家', async () => {
    const { mergeOpStamped } = await import('@/utils/opStampMerge');
    const local = [mkG('g1', [], { lastOp: { d: 'devA', s: 1 }, name: '本地名' })];
    const cloud = [mkG('g1', [], { lastOp: { d: 'devB', s: 99 }, name: '云端名' })];
    const out = mergeOpStamped(local, cloud);
    assert.equal(out[0].name, '云端名');
  });
  it('本地 stamp 更高 → 本地赢家', async () => {
    const { mergeOpStamped } = await import('@/utils/opStampMerge');
    const local = [mkG('g1', [], { lastOp: { d: 'devA', s: 99 }, name: '本地' })];
    const cloud = [mkG('g1', [], { lastOp: { d: 'devB', s: 1 }, name: '云端' })];
    const out = mergeOpStamped(local, cloud);
    assert.equal(out[0].name, '本地');
  });
  it('墓碑 (isDeleted) 同样参与 stamp 比较：赢家是墓碑 → 保留 isDeleted=true', async () => {
    const { mergeOpStamped } = await import('@/utils/opStampMerge');
    const local = [mkG('g1', [], { lastOp: { d: 'devA', s: 5 } })]; // 活跃
    const cloud = [mkG('g1', [], { lastOp: { d: 'devB', s: 99 }, isDeleted: true })];
    const out = mergeOpStamped(local, cloud);
    assert.equal(out[0].isDeleted, true);
  });
  it('活跃 stamp > 墓碑 stamp → 保留活跃（恢复/取消删除语义）', async () => {
    const { mergeOpStamped } = await import('@/utils/opStampMerge');
    const local = [mkG('g1', [], { lastOp: { d: 'devA', s: 99 } })]; // 活跃最新
    const cloud = [mkG('g1', [], { lastOp: { d: 'devB', s: 5 }, isDeleted: true })];
    const out = mergeOpStamped(local, cloud);
    assert.equal(out[0].isDeleted, false);
  });
  it('单侧独有：保留', async () => {
    const { mergeOpStamped } = await import('@/utils/opStampMerge');
    const local = [mkG('g1', [])];
    const cloud = [mkG('g2', [])];
    const out = mergeOpStamped(local, cloud);
    assert.equal(out.length, 2);
  });
  it('version 冻结：保留原值，不 max+1', async () => {
    const { mergeOpStamped } = await import('@/utils/opStampMerge');
    const local = [mkG('g1', [], { lastOp: STAMP_A, version: 5 })];
    const cloud = [mkG('g1', [], { lastOp: STAMP_B, version: 7 })];
    const out = mergeOpStamped(local, cloud);
    assert.equal(out[0].version, 7); // 跟随赢家原值，不 +1
  });
  it('isLocked OR：任一锁定即锁定', async () => {
    const { mergeOpStamped } = await import('@/utils/opStampMerge');
    const local = [mkG('g1', [], { lastOp: STAMP_A, isLocked: false })];
    const cloud = [mkG('g1', [], { lastOp: STAMP_B, isLocked: true })];
    const out = mergeOpStamped(local, cloud);
    assert.equal(out[0].isLocked, true);
  });
  it('无 stamp 的实体（全序最小值）→ 输给任何带 stamp 的实体', async () => {
    const { mergeOpStamped } = await import('@/utils/opStampMerge');
    const local = [mkG('g1', [], { name: '老数据' })]; // 无 lastOp
    const cloud = [mkG('g1', [], { lastOp: STAMP_A, name: '新数据' })];
    const out = mergeOpStamped(local, cloud);
    assert.equal(out[0].name, '新数据');
  });
});

describe('mergeOpStamped: §5.3 标签级', () => {
  it('tab 按 stamp 决胜', async () => {
    const { mergeOpStamped } = await import('@/utils/opStampMerge');
    const localTab = mkT('t1', 'https://a', { lastAccessed: '2026-01-01T00:00:00.000Z', lastOp: { d: 'devA', s: 1 } });
    const cloudTab = mkT('t1', 'https://a', { lastAccessed: '2026-06-01T00:00:00.000Z', lastOp: { d: 'devB', s: 99 } });
    const local = [mkG('g1', [localTab], { lastOp: { d: 'devA', s: 1 } })];
    const cloud = [mkG('g1', [cloudTab], { lastOp: { d: 'devB', s: 99 } })];
    const out = mergeOpStamped(local, cloud);
    assert.equal(out[0].tabs[0].lastAccessed, '2026-06-01T00:00:00.000Z');
  });
  it('标签墓碑同样参与 stamp 比较', async () => {
    const { mergeOpStamped } = await import('@/utils/opStampMerge');
    const localTab = mkT('t1', 'https://a', { lastOp: { d: 'devA', s: 1 } }); // 活跃
    const cloudTab = mkT('t1', 'https://a', { lastOp: { d: 'devB', s: 99 }, isDeleted: true });
    const local = [mkG('g1', [localTab], { lastOp: { d: 'devA', s: 1 } })];
    const cloud = [mkG('g1', [cloudTab], { lastOp: { d: 'devB', s: 99 } })];
    const out = mergeOpStamped(local, cloud);
    assert.equal(out[0].tabs[0].isDeleted, true);
  });
});

describe('mergeOpStamped: §5.4 URL 去重（跨设备同 URL 重加存活）', () => {
  it('跨设备同 URL 重加：双方都视为独立实体，按 stamp 决胜（重加存活）', async () => {
    // 规格 §5.4 + §12 第 3 条：跨设备同 URL 不同 id = 独立实体，不再被 URL 墓碑误杀。
    const { mergeOpStamped } = await import('@/utils/opStampMerge');
    const localTab = mkT('tLocal', 'https://x.com', { lastOp: { d: 'devA', s: 5 } });
    const cloudTab = mkT('tCloud', 'https://x.com', { lastOp: { d: 'devB', s: 1 } });
    const local = [mkG('g1', [localTab], { lastOp: { d: 'devA', s: 5 } })];
    const cloud = [mkG('g1', [cloudTab], { lastOp: { d: 'devB', s: 1 } })];
    const out = mergeOpStamped(local, cloud);
    const tabIds = out[0].tabs.map(t => t.id).sort();
    assert.deepEqual(tabIds, ['tCloud', 'tLocal']); // 双方都在
  });
  it('同组同 URL 不同 id 双方 stamp：败者盖墓碑并带 mergeStamp', async () => {
    const { mergeOpStamped } = await import('@/utils/opStampMerge');
    const localTab = mkT('tLocal', 'https://x.com', { lastOp: { d: 'devA', s: 1 } });
    const cloudTab = mkT('tCloud', 'https://x.com', { lastOp: { d: 'devB', s: 99 } });
    const local = [mkG('g1', [localTab], { lastOp: { d: 'devA', s: 1 } })];
    const cloud = [mkG('g1', [cloudTab], { lastOp: { d: 'devB', s: 99 } })];
    const out = mergeOpStamped(local, cloud, { mergeStamp: STAMP_A });
    const localOut = out[0].tabs.find(t => t.id === 'tLocal')!;
    assert.equal(localOut.isDeleted, true);
    assert.deepEqual(localOut.lastOp, STAMP_A); // 盖合并设备 stamp
  });
  it('不传 mergeStamp：URL 败者不被墓碑（默认不主动清理）', async () => {
    const { mergeOpStamped } = await import('@/utils/opStampMerge');
    const localTab = mkT('tLocal', 'https://x.com', { lastOp: { d: 'devA', s: 1 } });
    const cloudTab = mkT('tCloud', 'https://x.com', { lastOp: { d: 'devB', s: 99 } });
    const local = [mkG('g1', [localTab], { lastOp: { d: 'devA', s: 1 } })];
    const cloud = [mkG('g1', [cloudTab], { lastOp: { d: 'devB', s: 99 } })];
    const out = mergeOpStamped(local, cloud); // 无 mergeStamp
    const localOut = out[0].tabs.find(t => t.id === 'tLocal')!;
    assert.equal(localOut.isDeleted, false); // 没盖墓碑
  });
});