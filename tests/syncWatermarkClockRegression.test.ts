// P0 回归：增量上传水位必须按账号寻址 + 校验 seq 时钟回退（2026-10-11）。
//
// ── 缺陷 ───────────────────────────────────────────────────────────────────
// F2 增量上传把水位存成**一个裸整数**（键 supabase_sync_watermark_seq），
// 于是有一条「漏传且永不自愈」的静默数据丢失路径：
//
//   1) 某账号日常同步，水位推进到 seq=5000；
//   2) 用户点「清除本地数据」→ storage.clear() 按 Object.values(STORAGE_KEYS)
//      删键。DEVICE_SEQ **在**表里 → 被清零；而水位**不在**表里 → 存活 5000；
//   3) 用户新建会话 → seqRegistry.current() = max(DEVICE_SEQ=0, 观察到的印记)
//      → nextSeq() 从 1 重启 → 新组 lastOp.s = 1；
//   4) selectDirtyGroupsForUpload(groups, 5000) 判 `1 > 5000` 为假 → **跳过**；
//   5) 新组永远不上云；下一次下载合并云端旧行 seq 更大（LWW 云端赢）→
//      **用户新建的会话被静默覆盖消失**，而 UI 上报的是「同步成功」。
//
// v1.22.0 起无回收站、无撤销 ⇒ 这条路径 = 静默数据丢失。
//
// ── 两处修法，缺一不可（各自堵不同的一半）──────────────────────────────────
//   A. 键名按 userId 寻址 → 堵「换账号带旧水位」；
//   B. 水位值绑定 deviceSeq 基线 → 读取时若当前 seq 计数器 < 存下的基线，
//      说明**时钟回退**，旧水位的比较基准已不成立 → 弃用水位当 0（全量）。
//   仅做 A 堵不住本用例的清数据路径：同一账号清数据后水位照样在、seq 照样重启。
//
// ── 判据纪律 ───────────────────────────────────────────────────────────────
// 水位闸门必须**只往「多传」的方向失败**。每条用例都同时断「不上行」
// 与「闸门误杀」（水位可信时必须跳过），否则「恒 0」这种把闸门整个废掉的
// 实现也能全绿 —— 那等于把 F2 的优化整个还原成全量。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbJciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};
const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;
before(async () => {
  register(LOADER_PATH, import.meta.url);
});

import type { SyncWatermark } from '../src/utils/supabase/syncWatermark.ts';
type U = typeof import('../src/utils/supabase/upload.ts');
type W = typeof import('../src/utils/supabase/syncWatermark.ts');
let wmMod: W;
let uploadMod: U;

const groupWithSeq = (id: string, s: number) =>
  ({
    id, name: id,
    tabs: [{ id: `${id}-t`, url: `https://e.com/${id}`, title: id }],
    lastOp: { s, d: 'dev' },
  }) as never;

/** 内存 KV：模拟 chrome.storage → IndexedDB 的持久化往返 */
function memKv() {
  const map = new Map<string, unknown>();
  return {
    map,
    async get(k: string) { return map.get(k) ?? null; },
    async set(k: string, v: unknown) { map.set(k, v); },
  };
}

describe('P0：水位键必须按账号寻址（换账号带旧水位）', () => {
  before(async () => {
    wmMod = await import('@/utils/supabase/syncWatermark');
    uploadMod = await import('@/utils/supabase/upload');
  });

  it('两个账号拿到不同的键名', async () => {
    const a = wmMod.syncWatermarkKey('user-A');
    const b = wmMod.syncWatermarkKey('user-B');
    assert.notEqual(a, b, '账号 A 的水位不得被账号 B 读到');
    assert.ok(a.includes('user-A') && b.includes('user-B'), '键名必须含账号标识');
  });

  it('账号 A 的高水位不会遮蔽账号 B 的新组（B 的键读作未设置 → 全量）', async () => {
    const kv = memKv();
    await kv.set(wmMod.syncWatermarkKey('user-A'), { seq: 5000, deviceSeq: 5000 } satisfies SyncWatermark);

    // 读 B 的键：键不同 ⇒ 未设置 ⇒ 水位 0
    assert.equal(await kv.get(wmMod.syncWatermarkKey('user-B')), null, '账号 B 的水位键必须独立于账号 A');

    const dirty = uploadMod.selectDirtyGroupsForUpload([groupWithSeq('b-new', 1)], 0);
    assert.equal(dirty.length, 1, '账号 B 的新组必须上行（seq=1 > 水位 0）');
  });
});

describe('P0：seq 时钟回退时水位必须作废（清本地数据路径）', () => {
  before(async () => {
    wmMod = await import('@/utils/supabase/syncWatermark');
    uploadMod = await import('@/utils/supabase/upload');
  });

  /**
   * upload.ts 里 loadSyncWatermark 的判据同构复现（该函数未导出，见下方结构层用例
   * 钉住真实实现确实用上了这两条）。复现的意义：把「时钟回退 ⇒ 水位归 0」
   * 这条语义直接与 selectDirtyGroupsForUpload 串起来验，而不是只断言形状。
   */
  const effectiveWatermark = (w: SyncWatermark | null, currentDeviceSeq: number): number => {
    if (!w) return 0;
    if (currentDeviceSeq < w.deviceSeq) return 0;   // 时钟回退 ⇒ 弃用水位
    return w.seq;
  };

  it('当前 deviceSeq < 水位基线 ⇒ 水位作废，新组 seq 从 1 重启也必须上行', () => {
    // 缺陷链的步骤 2→4：水位 {5000, 5000} 存活；清数据后计数器归零；新组 seq=1。
    const w: SyncWatermark = { seq: 5000, deviceSeq: 5000 };
    const wm = effectiveWatermark(w, 0);
    assert.equal(wm, 0, '时钟回退必须让水位归 0');

    const dirty = uploadMod.selectDirtyGroupsForUpload([groupWithSeq('after-clear', 1)], wm);
    assert.equal(dirty.length, 1, '❌ 回归：新组被旧水位永久遮蔽 → 静默数据丢失');
  });

  it('时钟未回退时水位仍然生效（不得把闸门整个废掉）', () => {
    // 反向防线：没有这条，「恒返回 0」的实现也能通过上一条 —— 那是把 F2 还原成全量。
    const w: SyncWatermark = { seq: 5000, deviceSeq: 5000 };
    const wm = effectiveWatermark(w, 5000); // 计数器未回退 ⇒ 水位可信
    assert.equal(wm, 5000, '未回退时水位必须照常生效');

    const groups = [
      groupWithSeq('already-synced', 4000), // ≤ 水位 → 跳过
      groupWithSeq('fresh', 5001),          // > 水位 → 上行
    ];
    const dirty = uploadMod.selectDirtyGroupsForUpload(groups, wm);
    assert.equal(dirty.length, 1, '只有 seq > 水位的组才上行');
    assert.equal((dirty[0] as { id: string }).id, 'fresh');
  });

  it('水位 = 上行集合 seq 的最大值（不是最后一个组的 seq）', () => {
    const uploadRows = [groupWithSeq('a', 10), groupWithSeq('b', 25), groupWithSeq('c', 7)];
    assert.equal(uploadMod.nextSyncWatermark(uploadRows, 5), 25, '必须取 max 而不是最后一个');
  });
});

describe('P0：水位值形状不符 ⇒ 当未设置（自动迁移，不需清理动作）', () => {
  it('旧版裸整数不再是合法形状 → 走「未设置 → 全量」', () => {
    // 旧版写的是裸 number；新读取要求 {seq, deviceSeq}。旧键名不带账号后缀
    // ⇒ 根本读不到；即便读到裸整数也判形状不符 ⇒ 水位 0 ⇒ 全量（保守方向）。
    const legacyRaw: unknown = 5000;
    const isNewShape = legacyRaw !== null && typeof legacyRaw === 'object';
    assert.equal(isNewShape, false, '裸整数不得被当成新格式水位');
    assert.equal(uploadMod.selectDirtyGroupsForUpload([groupWithSeq('x', 1)], 0).length, 1);
  });

  it('syncWatermark 导出二元组形状（编译期约束 + 结构层）', () => {
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../src/utils/supabase/syncWatermark.ts'),
      'utf8'
    );
    assert.match(src, /export interface SyncWatermark/, '必须导出二元组形状');
    assert.match(src, /seq:\s*number/, 'SyncWatermark 必须含 seq');
    assert.match(src, /deviceSeq:\s*number/, 'SyncWatermark 必须含 deviceSeq 基线');
  });
});

describe('P0：upload.ts 必须真的用上按账号寻址 + 回退校验（结构层）', () => {
  const uploadSrc = () => readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../src/utils/supabase/upload.ts'),
    'utf8'
  );

  it('读取按账号寻址、写入带 deviceSeq、deviceSeq 取自同一个 seqRegistry', () => {
    const src = uploadSrc();
    assert.match(src, /loadSyncWatermark\(userId,\s*currentDeviceSeq\)/, '读取水位必须传 userId');
    assert.doesNotMatch(src, /\bSYNC_WATERMARK_KEY\b/, '不得再直接使用全局裸键常量');
    assert.match(src, /saveSyncWatermark\(userId,\s*nextWatermark,\s*deviceSeqAtWrite\)/, '写入水位必须带 deviceSeq');
    assert.match(src, /tombstoneSeq\.peekDeviceSeq\(\)/, 'deviceSeq 必须取自与墓碑同一个 seqRegistry');
    assert.doesNotMatch(src, /tombstoneSeq\.getDeviceSeq\(\)/, '不得用有写副作用的 getDeviceSeq 做纯读校验：它会把下限提前钉进 device_seq，令紧随的取号多跳一级');
  });

  it('读取处真的做了「时钟回退 ⇒ 归 0」的判据（不是只改形状）', () => {
    const src = uploadSrc();
    const body = src.slice(src.indexOf('async function loadSyncWatermark'));
    assert.match(
      body,
      /currentDeviceSeq\s*<\s*(?:w|wm|raw)\w*\.?deviceSeq|currentDeviceSeq\s*<\s*deviceSeq/,
      '读取时必须比较当前计数器与水位基线'
    );
    assert.match(body, /return 0/, '回退时必须归 0（全量）');
  });

  it('增量日志与实际上行集合同源（不得用全量 groups 的分母）', () => {
    const src = uploadSrc();
    const logBlock = src.slice(src.indexOf('要上传的标签组'));
    assert.match(logBlock, /candidateGroups\.forEach/, '逐组日志必须遍历 candidateGroups');
    assert.match(logBlock, /candidateGroups\.length/, '分母必须是 candidateGroups.length');
  });
});
