// 「恢复即消费」的撤销（P0-4）—— 行为级回归。
//
// ── 这个功能在防什么 ──────────────────────────────────────────────────────
//
// 1.24.1 定案：点开标签 = 消费掉那条记录；恢复整个会话 = 消费掉整条会话。
// 那是**不可逆的删除**（无回收站），而且是本产品最高频的两个动作。
// 恢复之后卡片凭空消失，用户第一反应是「我是不是点错了」，而他**没有任何办法
// 退回去** —— 这就是 P0-4 记的缺陷。
//
// 撤销要同时回滚两件事，少一件就是**假的撤销**：
//   ① 本地记录写回；
//   ② 那条删除广播意图撤回（否则下次上传仍会把云端行标墓碑 ⇒ 别的设备上
//      这条会话消失 ⇒ 两台设备分叉，且用户看不见）。
//
// 断言分三层：
//   · 纯函数（core/consumeUndo.ts）：还原的形状、位置、印记；
//   · 编排（background/mutationHandlers.ts）：撤意图在写记录**之前**、失败即中止；
//   · 撤回本身（utils/storage.ts）：队列里的那条意图真的被摘掉了
//     （行为级守卫另见 tests/retractDeleteIntent.test.ts）。
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
/** 被消费前那条记录的印记（快照里的 lastOp = {d:'devA', s:50}，比它新）。 */
const NEWER_STAMP = { d: 'devA', s: 101 };

const mkTab = (id: string) => ({
  id,
  url: `https://${id}.com`,
  title: id,
  favicon: '',
  createdAt: NOW,
  lastAccessed: NOW,
  pinned: false,
});

const mkGroup = (id: string, tabs: string[], over: Partial<import('@/types/tab').TabGroup> = {}) => ({
  id,
  name: `会话 ${id}`,
  tabs: tabs.map(mkTab),
  createdAt: NOW,
  updatedAt: NOW,
  isLocked: false,
  version: 3,
  lastOp: { d: 'devA', s: 50 },
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────
// 1. 纯函数：还原的形状
// ─────────────────────────────────────────────────────────────────────────

describe('applyRestoreConsumed：整组撤销', () => {
  it('会话回到列表，且带一个**比删除时更新的印记**', async () => {
    const { applyRestoreConsumed } = await import('@/core/consumeUndo');
    const snapshot = mkGroup('g1', ['t1', 't2']);
    const out = applyRestoreConsumed([], { group: snapshot }, NOW, NEWER_STAMP);
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.equal(out.changed, true);
    assert.equal(out.groups.length, 1);
    assert.equal(out.groups[0].id, 'g1');
    // 印记必须换新：旧印记比墓碑旧 ⇒ 跨设备合并会输给云端墓碑。
    assert.deepEqual(out.groups[0].lastOp, NEWER_STAMP);
    assert.notDeepEqual(out.groups[0].lastOp, snapshot.lastOp);
  });

  it('标签一条不少地回来', async () => {
    const { applyRestoreConsumed } = await import('@/core/consumeUndo');
    const snapshot = mkGroup('g1', ['t1', 't2', 't3']);
    const out = applyRestoreConsumed([], { group: snapshot }, NOW, NEWER_STAMP);
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.deepEqual(out.groups[0].tabs.map(t => t.id), ['t1', 't2', 't3']);
  });

  it('回到列表后仍按 createdAt 倒序（卡片回到它原来的位置）', async () => {
    const { applyRestoreConsumed } = await import('@/core/consumeUndo');
    const older = mkGroup('old', ['a'], { createdAt: '2026-01-01T00:00:00.000Z' });
    const newer = mkGroup('new', ['b'], { createdAt: '2026-06-01T00:00:00.000Z' });
    const target = mkGroup('mid', ['c'], { createdAt: '2026-03-01T00:00:00.000Z' });
    const out = applyRestoreConsumed([newer, older], { group: target }, NOW, NEWER_STAMP);
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.deepEqual(out.groups.map(g => g.id), ['new', 'mid', 'old']);
  });

  it('幂等：已经撤销过再来一次不报错、也不重复插入', async () => {
    const { applyRestoreConsumed } = await import('@/core/consumeUndo');
    const snapshot = mkGroup('g1', ['t1']);
    const first = applyRestoreConsumed([], { group: snapshot }, NOW, NEWER_STAMP);
    assert.ok(first.ok);
    if (!first.ok) return;
    const second = applyRestoreConsumed(first.groups, { group: snapshot }, NOW, NEWER_STAMP);
    assert.ok(second.ok);
    if (!second.ok) return;
    assert.equal(second.changed, false);
    assert.equal(second.groups.length, 1);
  });
});

describe('applyRestoreConsumed：单条标签撤销', () => {
  it('标签插回**原来的下标**，不是追加到末尾', async () => {
    const { applyRestoreConsumed } = await import('@/core/consumeUndo');
    const snapshot = mkGroup('g1', ['t1', 't2', 't3']);
    const current = mkGroup('g1', ['t1', 't3'], { lastOp: { d: 'devA', s: 60 } });
    const out = applyRestoreConsumed([current], {
      group: snapshot,
      consumedTabId: 't2',
      consumedIndex: 1,
    }, NOW, NEWER_STAMP);
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.deepEqual(out.groups[0].tabs.map(t => t.id), ['t1', 't2', 't3']);
    assert.deepEqual(out.groups[0].lastOp, NEWER_STAMP);
  });

  it('消费掉的是**最后一条**标签时（整组已被移除），整组回来', async () => {
    const { applyRestoreConsumed } = await import('@/core/consumeUndo');
    const snapshot = mkGroup('g1', ['t1']);
    const out = applyRestoreConsumed([], {
      group: snapshot,
      consumedTabId: 't1',
      consumedIndex: 0,
    }, NOW, NEWER_STAMP);
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.equal(out.groups.length, 1);
    assert.deepEqual(out.groups[0].tabs.map(t => t.id), ['t1']);
  });

  it('幂等：标签已经在列表里就不再插一次', async () => {
    const { applyRestoreConsumed } = await import('@/core/consumeUndo');
    const snapshot = mkGroup('g1', ['t1', 't2']);
    const current = mkGroup('g1', ['t1', 't2']);
    const out = applyRestoreConsumed([current], {
      group: snapshot,
      consumedTabId: 't2',
      consumedIndex: 1,
    }, NOW, NEWER_STAMP);
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.equal(out.changed, false);
    assert.equal(out.groups[0].tabs.length, 2);
  });

  it('凭据与数据对不上时**失败**而不是插一条错的', async () => {
    const { applyRestoreConsumed } = await import('@/core/consumeUndo');
    const snapshot = mkGroup('g1', ['t1']);
    const out = applyRestoreConsumed([], {
      group: snapshot,
      consumedTabId: 't-not-there',
      consumedIndex: 0,
    }, NOW, NEWER_STAMP);
    assert.equal(out.ok, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 1b. 一次消费掉多条（搜索页的批量恢复）
//
// 为什么单条形式不够：批量恢复可能从**同一个会话**里消费掉好几条。
// 逐条撤销会算错位置 —— 先插回来的那条会把后面的下标顶偏，于是
// 「撤销之后标签顺序变了」：那是用户自己排的顺序，撤销不该偷偷改它。
// ─────────────────────────────────────────────────────────────────────────

describe('applyRestoreConsumed：一次撤销多条', () => {
  it('多条一起撤销，顺序与消费前**逐字一致**', async () => {
    const { applyRestoreConsumed } = await import('@/core/consumeUndo');
    const snapshot = mkGroup('g1', ['t1', 't2', 't3', 't4']);
    // 消费掉了第 2、3 条（t2、t3）⇒ 当前剩 [t1, t4]
    const current = mkGroup('g1', ['t1', 't4'], { lastOp: { d: 'devA', s: 60 } });
    const out = applyRestoreConsumed([current], {
      group: snapshot,
      consumedTabs: [
        { tabId: 't2', index: 1 },
        { tabId: 't3', index: 2 },
      ],
    }, NOW, NEWER_STAMP);
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.deepEqual(
      out.groups[0].tabs.map(t => t.id),
      ['t1', 't2', 't3', 't4'],
      '撤销后必须与消费前逐字一致（顺序也是用户自己排的）'
    );
    assert.deepEqual(out.groups[0].lastOp, NEWER_STAMP);
  });

  it('消费掉的是**首尾**两条时，位置也要对', async () => {
    const { applyRestoreConsumed } = await import('@/core/consumeUndo');
    const snapshot = mkGroup('g1', ['t1', 't2', 't3']);
    const current = mkGroup('g1', ['t2'], { lastOp: { d: 'devA', s: 60 } });
    const out = applyRestoreConsumed([current], {
      group: snapshot,
      consumedTabs: [
        { tabId: 't1', index: 0 },
        { tabId: 't3', index: 2 },
      ],
    }, NOW, NEWER_STAMP);
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.deepEqual(out.groups[0].tabs.map(t => t.id), ['t1', 't2', 't3']);
  });

  it('已经撤销过一条时，那条跳过、其余照常插回（幂等）', async () => {
    const { applyRestoreConsumed } = await import('@/core/consumeUndo');
    const snapshot = mkGroup('g1', ['t1', 't2', 't3']);
    // t2 已经在列表里（撤销过一次），t3 还没回来
    const current = mkGroup('g1', ['t1', 't2'], { lastOp: { d: 'devA', s: 60 } });
    const out = applyRestoreConsumed([current], {
      group: snapshot,
      consumedTabs: [
        { tabId: 't2', index: 1 },
        { tabId: 't3', index: 2 },
      ],
    }, NOW, NEWER_STAMP);
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.equal(out.changed, true, 't3 还没回来 ⇒ 这一次确实改变了东西');
    assert.deepEqual(out.groups[0].tabs.map(t => t.id), ['t1', 't2', 't3']);
  });

  it('凭据里有一条对不上 ⇒ **整次失败**（不插任何一条）', async () => {
    const { applyRestoreConsumed } = await import('@/core/consumeUndo');
    const snapshot = mkGroup('g1', ['t1', 't2']);
    const current = mkGroup('g1', ['t1'], { lastOp: { d: 'devA', s: 60 } });
    const out = applyRestoreConsumed([current], {
      group: snapshot,
      consumedTabs: [
        { tabId: 't2', index: 1 },
        { tabId: 't-not-there', index: 2 },
      ],
    }, NOW, NEWER_STAMP);
    assert.equal(out.ok, false, '宁可不做，也不要插一半（插一半 = 顺序还是错的）');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 编排：撤意图在写记录之前，失败即中止
// ─────────────────────────────────────────────────────────────────────────

interface HandlerDeps {
  groups: import('@/types/tab').TabGroup[];
  events: string[];
  uploads: number[];
  retracted: string[];
  deleted: string[];
  failRetract?: boolean;
}

function memDeps(initial: import('@/types/tab').TabGroup[] = []): HandlerDeps {
  const d: HandlerDeps = {
    groups: [...initial],
    events: [],
    uploads: [],
    retracted: [],
    deleted: [],
  };
  // 持久化的 seq 地板（生产里是 chrome.storage 里的 DEVICE_SEQ）。
  // 起点取 100：高于快照的 {s:50}，模拟「这���会话当初就是从这台设备发出去的、
  // 本机时钟已经走过 50」。
  //
  // 【为什么这个地板必须是持久化的、而不是从 groups 里现算】——
  // 消费之后这条会话**已经不在本机了**，所以「观察到的最大印记」看不到它；
  // 唯一还能保证新号比它大的，就是那个**只增不减**的持久化号位
  // （core/opStamp.ts + utils/seqRegistry.ts 的 current() = max(持久值, 观察值)）。
  // 墓碑取号走的是同一个持久化 key ⇒ 墓碑的号也大于被删会话原来的号。
  let seqN = 100;
  return Object.assign(d, {
    now: () => NOW,
    async getGroups() {
      return [...d.groups];
    },
    async setGroups(g: import('@/types/tab').TabGroup[]) {
      d.events.push('setGroups');
      d.groups = [...g];
    },
    scheduleUpload(ms: number) {
      d.uploads.push(ms);
    },
    journal: {
      async appendEntry(p: unknown) {
        seqN += 1;
        return { d: 'devA', s: seqN, ts: NOW, ...(p as object) };
      },
      async read() { return []; },
      async markConfirmedUpTo() { return 0; },
    },
    seq: {
      async nextSeq() { return ++seqN; },
      async getDeviceSeq() { return seqN; },
      async bumpSeqIfLower(c: number) { return c > seqN ? (seqN = c) : seqN; },
    },
    async noteGroupDeleted(ids: readonly string[]) { d.deleted.push(...ids); },
    async retractGroupDeleted(ids: readonly string[]) {
      d.events.push('retract');
      if (d.failRetract) throw new Error('KV 写不进去');
      d.retracted.push(...ids);
    },
  });
}

describe('mutationHandlers：restoreConsumed 的编排', () => {
  it('先撤删除意图、再写记录（顺序反了就是假撤销）', async () => {
    const { createMutationHandlers } = await import('@/background/mutationHandlers');
    const snapshot = mkGroup('g1', ['t1', 't2']);
    const deps = memDeps([]);
    const handlers = createMutationHandlers(deps as never);
    const res = await handlers.handle({ op: 'restoreConsumed', group: snapshot });
    assert.equal(res.ok, true, JSON.stringify(res.error ?? ''));
    assert.deepEqual(deps.events, ['retract', 'setGroups']);
    assert.deepEqual(deps.retracted, ['g1']);
    assert.equal(deps.groups.length, 1);
    assert.equal(deps.groups[0].id, 'g1');
  });

  it('撤意图失败 ⇒ **不写记录**、如实报错（fail-closed）', async () => {
    const { createMutationHandlers } = await import('@/background/mutationHandlers');
    const snapshot = mkGroup('g1', ['t1']);
    const deps = memDeps([]);
    deps.failRetract = true;
    const handlers = createMutationHandlers(deps as never);
    const res = await handlers.handle({ op: 'restoreConsumed', group: snapshot });
    assert.equal(res.ok, false);
    // 记录没被写回来 —— 撤不掉的删除意图下写回来只会被下一次上传又删掉。
    assert.equal(deps.events.includes('setGroups'), false);
    assert.equal(deps.groups.length, 0);
    assert.match(String(res.error), /撤销失败/);
  });

  it('落盘的记录带**新印记**（不是入参快照那份）', async () => {
    const { createMutationHandlers } = await import('@/background/mutationHandlers');
    const snapshot = mkGroup('g1', ['t1']);
    const deps = memDeps([]);
    const handlers = createMutationHandlers(deps as never);
    const res = await handlers.handle({ op: 'restoreConsumed', group: snapshot });
    assert.equal(res.ok, true);
    const onDisk = deps.groups[0];
    assert.notDeepEqual(onDisk.lastOp, snapshot.lastOp);
    assert.ok(onDisk.lastOp && onDisk.lastOp.s > (snapshot.lastOp?.s ?? 0));
  });

  it('撤销后必须调度上传（否则云端墓碑不会被复位）', async () => {
    const { createMutationHandlers } = await import('@/background/mutationHandlers');
    const snapshot = mkGroup('g1', ['t1']);
    const deps = memDeps([]);
    const handlers = createMutationHandlers(deps as never);
    await handlers.handle({ op: 'restoreConsumed', group: snapshot });
    assert.equal(deps.uploads.length, 1, '撤销后必须置位上传');
  });

  it('没装「撤回意图」能力时**拒绝撤销**（不能写回一条会被立刻删掉的记录）', async () => {
    const { createMutationHandlers } = await import('@/background/mutationHandlers');
    const snapshot = mkGroup('g1', ['t1']);
    const deps = memDeps([]);
    const withoutRetract = { ...deps } as Record<string, unknown>;
    delete withoutRetract.retractGroupDeleted;
    const handlers = createMutationHandlers(withoutRetract as never);
    const res = await handlers.handle({ op: 'restoreConsumed', group: snapshot });
    assert.equal(res.ok, false);
    assert.match(String(res.error), /不支持撤销/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. 过期删除意图：不写墓碑
//
// ⚠️ 这里原来有一组「validDeleteIntents」单测（判据：本机还有这条记录 ⇒
// 意图过期 ⇒ 不写墓碑）。**那条判据是错的**，已连同实现一起删掉：
//
// 下载合并会把**云端的活跃副本**带进本机（老版本墓碑组被剥掉后，云端那一行
// 仍是活跃的，本机因此又有了这条记录）—— 此时删除意图**必须**照写，
// 否则那条「本机已经删掉的会话」下一轮又从云端回来
// （tests/legacyTombstoneDeleteBroadcast.test.ts 守的就是它，
//  把过滤器套上去会让那个测试当场变红）。
//
// 真正要守的是「意图还在不在队列里」：撤销会把那条 id 从队列里摘掉，
// 写墓碑前重读队列 ⇒ 撤掉了就不写
// （行为级守卫：tests/deleteIntentRetractedMidUpload.test.ts）。
// ─────────────────────────────────────────────────────────────────────────
