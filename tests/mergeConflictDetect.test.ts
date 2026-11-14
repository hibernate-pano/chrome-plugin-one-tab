// 钉死 P0-1 冲突可见化的判定逻辑（纯函数，无 IO）：
// 只有「两端自上次一致后都改过 + 整组覆盖 + 确有内容丢失」才算真冲突；
// 云端只是比本机新（本机没改）、墓碑、无基线都不许误报。
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
const BASE = { d: 'base', s: 1 };
const A = { d: 'devA', s: 2 };
const B = { d: 'devB', s: 2 };

function mkG(id: string, tabs: any[] = [], over: any = {}) {
  return {
    id, name: `g-${id}`, tabs,
    createdAt: NOW, updatedAt: NOW,
    version: 1, isLocked: false,
    ...over,
  };
}
function mkT(id: string) {
  return { id, url: 'https://' + id, title: id, favicon: '', createdAt: NOW, lastAccessed: NOW, pinned: false };
}
const mapOf = (...pairs: Array<[string, 'local' | 'cloud']>) => new Map(pairs);

describe('detectMergeConflicts: 真并发覆盖才报', () => {
  it('两端都改、云端赢且本地丢了标签 ⇒ 报 1 条，winner=cloud，lostTabs 计对', async () => {
    const { detectMergeConflicts } = await import('@/core/mergeConflictDetect');
    const local = [mkG('g1', [mkT('t1'), mkT('t2')], { lastOp: A })];
    const cloud = [mkG('g1', [mkT('t1')], { lastOp: B })];
    const out = detectMergeConflicts(local, cloud, { g1: BASE }, mapOf(['g1', 'cloud']));
    assert.equal(out.length, 1);
    assert.equal(out[0].winner, 'cloud');
    assert.equal(out[0].lostTabs, 1); // t2 只在本机、被云端整组覆盖掉
    assert.equal(out[0].localTabCount, 2);
    assert.equal(out[0].cloudTabCount, 1);
  });

  it('云端只是比本机新（本地印记 == 基线，没改过）⇒ 不报', async () => {
    const { detectMergeConflicts } = await import('@/core/mergeConflictDetect');
    const local = [mkG('g1', [mkT('t1'), mkT('t2')], { lastOp: BASE })]; // 未改
    const cloud = [mkG('g1', [mkT('t1')], { lastOp: B, name: '云端改名' })];
    const out = detectMergeConflicts(local, cloud, { g1: BASE }, mapOf(['g1', 'cloud']));
    assert.equal(out.length, 0);
  });

  it('只有本地改过、云端没变 ⇒ 不报（本地会赢，不构成覆盖）', async () => {
    const { detectMergeConflicts } = await import('@/core/mergeConflictDetect');
    const local = [mkG('g1', [mkT('t1')], { lastOp: A })];
    const cloud = [mkG('g1', [mkT('t1'), mkT('t2')], { lastOp: BASE })]; // 未改
    const out = detectMergeConflicts(local, cloud, { g1: BASE }, mapOf(['g1', 'local']));
    assert.equal(out.length, 0);
  });

  it('无基线（首次同步/新增组）⇒ 不报，只建立基线', async () => {
    const { detectMergeConflicts } = await import('@/core/mergeConflictDetect');
    const local = [mkG('g1', [mkT('t1'), mkT('t2')], { lastOp: A })];
    const cloud = [mkG('g1', [mkT('t1')], { lastOp: B })];
    const out = detectMergeConflicts(local, cloud, {}, mapOf(['g1', 'cloud']));
    assert.equal(out.length, 0);
  });

  it('两端都改但内容完全相同（无标签丢失、无改名）⇒ 不报', async () => {
    const { detectMergeConflicts } = await import('@/core/mergeConflictDetect');
    const local = [mkG('g1', [mkT('t1')], { lastOp: A })];
    const cloud = [mkG('g1', [mkT('t1')], { lastOp: B })];
    const out = detectMergeConflicts(local, cloud, { g1: BASE }, mapOf(['g1', 'cloud']));
    assert.equal(out.length, 0);
  });

  it('两端都改且仅组名不同（无标签丢失）⇒ 也算覆盖（名字被换掉）', async () => {
    const { detectMergeConflicts } = await import('@/core/mergeConflictDetect');
    const local = [mkG('g1', [mkT('t1')], { lastOp: A, name: '我的名字' })];
    const cloud = [mkG('g1', [mkT('t1')], { lastOp: B, name: '别人的名字' })];
    const out = detectMergeConflicts(local, cloud, { g1: BASE }, mapOf(['g1', 'cloud']));
    assert.equal(out.length, 1);
    assert.equal(out[0].lostTabs, 0);
  });

  it('墓碑（任一端 isDeleted）⇒ 不报，即使 winnerByGroupId 谎报了竞争也不报（纵深防御）', async () => {
    const { detectMergeConflicts } = await import('@/core/mergeConflictDetect');
    // 刻意让「若无墓碑守卫就必然误报」的形状：云端墓碑名不同、标签集也不同，
    // 且 winnerByGroupId 声称有竞争。墓碑守卫是唯一挡住误报的那道门。
    const local = [mkG('g1', [mkT('t1'), mkT('t2')], { lastOp: A })];
    const cloud = [mkG('g1', [mkT('t9')], { lastOp: B, name: '云端名', isDeleted: true })];
    const out = detectMergeConflicts(local, cloud, { g1: BASE }, mapOf(['g1', 'cloud']));
    assert.equal(out.length, 0);
  });

  it('赢家不在 winnerByGroupId（仅一侧有 / 无竞争）⇒ 不报', async () => {
    const { detectMergeConflicts } = await import('@/core/mergeConflictDetect');
    const local = [mkG('g1', [mkT('t1')], { lastOp: A })];
    const cloud = [mkG('g1', [mkT('t1'), mkT('t2')], { lastOp: B })];
    const out = detectMergeConflicts(local, cloud, { g1: BASE }, mapOf());
    assert.equal(out.length, 0);
  });
});

describe('buildStampLedger: 基线构建', () => {
  it('活跃组入账、墓碑不入账', async () => {
    const { buildStampLedger } = await import('@/core/mergeConflictDetect');
    const ledger = buildStampLedger([
      mkG('g1', [], { lastOp: A }),
      mkG('g2', [], { lastOp: B, isDeleted: true }),
      mkG('g3'), // 无 lastOp ⇒ {d:'',s:0}
    ]);
    assert.deepEqual(ledger, { g1: A, g3: { d: '', s: 0 } });
  });
});
