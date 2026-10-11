// F3 回归：后台轮询同步失败必须退避（2026-10-10）。
//
// ── 缺陷 ───────────────────────────────────────────────────────────────────
// backgroundSync 用一个 `periodInMinutes: 1` 的 alarm 驱动整条管线，
// 失败**没有任何退避、没有 maxRetries**（修复前全仓 grep 'backoff|退避|retryDelay|
// maxRetries' 零命中）。网络断着 / Supabase 500 / 设置读失败时，整条管线
// （上传 + 全量下载 + 合并 + 写盘）每 60s 准时重跑一次，无限重试地消耗流量与电量，
// 而且这些重试在故障恢复前**永远不可能成功**。
//
// ── 三条拍板要求，各自由下面的用例钉住 ─────────────────────────────────────
//   1) 指数退避 60s → 120s → 300s 封顶（不过度设计）；
//   2) **成功必须复位**（否则一次网络抖动把用户永久锁在 5 分钟一轮）；
//   3) 状态必须活过 SW 回收（MV3 SW 随时被杀 ⇒ 依赖 chrome.alarms + chrome.storage，
//      而不是模块级内存计数器；内存计数器在下一轮唤醒就是 0，退避等于没做）。
//
// ── 为什么退避状态机与 chrome.* 完全解耦（syncBackoff.ts 的形状）──────────
// 纯函数 + 注入式 KV/时钟，于是退避阶梯、复位时机、持久化往返都能 node:test 直测，
// 不必起一个假 chrome。chrome 那一层（alarms 重排）由 backgroundSync 负责，
// 本文件另用结构层用例钉住「依赖 alarms 而非内存计数器」这条关键约束。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};
const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

// syncBackoff 不 import 任何 @/ 模块（刻意解耦 chrome.*），但统一走仓库的
// loader 惯例以免将来它引入依赖时炸掉。
before(async () => {
  register(LOADER_PATH, import.meta.url);
});

type Backoff = typeof import('../src/background/syncBackoff.ts');
let mod: Backoff;

/** 内存 KV —— 模拟 chrome.storage.local 的持久化往返（跨「SW 回收」仍读得到） */
function memKv(initial?: unknown) {
  const map = new Map<string, unknown>();
  if (initial !== undefined) map.set(mod.BACKOFF_STATE_KEY, initial);
  return {
    map,
    kv: {
      async get(key: string) { return map.get(key); },
      async set(key: string, value: unknown) { map.set(key, value); },
      async remove(key: string) { map.delete(key); },
    },
  };
}

/** 注入假时钟：断言「下次何时可跑」时不真等 */
const T0 = Date.UTC(2026, 9, 10, 8, 0, 0);

/** 结构层断言用：读仓库源码并剥注释（避免注释里出现的名字造成误判） */
const readSrc = (rel: string): string =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('F3 · 退避阶梯', () => {
  before(() => { mod = null as never; });

  it('阶梯是 60s → 120s → 300s 封顶', async () => {
    mod = await import('../src/background/syncBackoff.ts');
    assert.deepEqual(
      [...mod.BACKOFF_LADDER_MINUTES],
      [1, 2, 5],
      '阶梯必须就是拍板的 60s → 120s → 300s，别过度设计'
    );
    assert.equal(mod.NORMAL_INTERVAL_MINUTES, 1, '正常轮询周期仍是 60s（退避只推迟下一次，不改变常态节奏）');
    assert.deepEqual(
      [0, 1, 2, 3, 4, 9].map(n => mod.backoffMinutesFor(n)),
      [1, 1, 2, 5, 5, 5],
      '未失败 = 60s；1 次失败 = 60s；2 次 = 120s；≥3 次 = 300s 封顶'
    );
  });

  it('nextAllowedAt = now + 阶梯对应的分钟数', async () => {
    mod = await import('../src/background/syncBackoff.ts');
    assert.equal(mod.nextAllowedAt(T0, 1), T0 + 60_000);
    assert.equal(mod.nextAllowedAt(T0, 2), T0 + 120_000);
    assert.equal(mod.nextAllowedAt(T0, 5), T0 + 300_000);
  });
});

describe('F3 · 失败推进阶梯（可注入时钟，不真等）', () => {
  it('连续失败：间隔递增，且状态持久化（不靠内存计数器）', async () => {
    mod = await import('../src/background/syncBackoff.ts');
    const { kv, map } = memKv();
    let now = T0;

    const s1 = await mod.recordSyncFailure(kv, now, 'network down');
    assert.equal(s1.consecutiveFailures, 1);
    assert.equal(s1.nextAllowedAt, T0 + 60_000, '第 1 次失败 → 60s 后重试');

    // 模拟下一次 alarm 真的等到了窗口之后（推进假时钟，不 sleep）
    now = s1.nextAllowedAt;
    const s2 = await mod.recordSyncFailure(kv, now, 'network down');
    assert.equal(s2.consecutiveFailures, 2);
    assert.equal(s2.nextAllowedAt, now + 120_000, '第 2 次失败 → 120s（间隔递增）');

    now = s2.nextAllowedAt;
    const s3 = await mod.recordSyncFailure(kv, now, 'network down');
    assert.equal(s3.consecutiveFailures, 3);
    assert.equal(s3.nextAllowedAt, now + 300_000, '第 3 次失败 → 300s 封顶');

    now = s3.nextAllowedAt;
    const s4 = await mod.recordSyncFailure(kv, now, 'network down');
    assert.equal(s4.nextAllowedAt, now + 300_000, '之后恒为 300s 封顶（不是无限增长）');

    // 关键：状态落在 KV 里。MV3 SW 被系统杀掉后重新唤醒，模块变量会归零，
    // 而这里读回来的必须是 4 次连续失败 —— 否则退避等于没做。
    assert.ok(map.has(mod.BACKOFF_STATE_KEY), '退避状态必须持久化');
    const restored = await mod.readBackoffState(kv);
    assert.equal(restored.consecutiveFailures, 4, 'SW 回收后仍要记得已经失败 4 次');
    assert.equal(restored.nextAllowedAt, s4.nextAllowedAt);
    assert.equal(restored.lastFailureReason, 'network down', '失败原因随状态留存（可诊断）');
  });

  it('连续失败达上限后停止自动重排（但不是永久停摆）', async () => {
    mod = await import('../src/background/syncBackoff.ts');
    const { kv } = memKv();
    let s = await mod.readBackoffState(kv);
    for (let i = 0; i < mod.MAX_CONSECUTIVE_FAILURES; i++) {
      s = await mod.recordSyncFailure(kv, s.nextAllowedAt, 'boom');
    }
    assert.equal(s.consecutiveFailures, mod.MAX_CONSECUTIVE_FAILURES);
    assert.equal(
      mod.isBackoffExhausted(s.consecutiveFailures),
      true,
      `连续失败 ${mod.MAX_CONSECUTIVE_FAILURES} 次后不再自动重排 alarm`
    );
    assert.equal(
      mod.isBackoffExhausted(mod.MAX_CONSECUTIVE_FAILURES - 1),
      false,
      '未达上限时仍要继续重排（否则一次抖动就永久停掉自动同步）'
    );
  });
});

describe('F3 · 成功必须复位', () => {
  it('成功清零连续失败数与 nextAllowedAt，并删掉持久化键', async () => {
    mod = await import('../src/background/syncBackoff.ts');
    const { kv, map } = memKv();
    let now = T0;
    let s = await mod.recordSyncFailure(kv, now, 'net');
    now = s.nextAllowedAt;
    s = await mod.recordSyncFailure(kv, now, 'net');
    now = s.nextAllowedAt;
    s = await mod.recordSyncFailure(kv, now, 'net');
    assert.equal(s.consecutiveFailures, 3);
    assert.ok(map.has(mod.BACKOFF_STATE_KEY), '前置：确实在退避中');

    now = s.nextAllowedAt;
    const after = await mod.recordSyncSuccess(kv, now);

    assert.equal(after.consecutiveFailures, 0, '成功必须清零（否则一次抖动把用户永久锁在 5 分钟一轮）');
    assert.equal(after.nextAllowedAt, 0);
    assert.equal(
      map.has(mod.BACKOFF_STATE_KEY),
      false,
      '复位要真的删掉持久化键：残留的状态会让下次故障从更高的阶梯起步'
    );
    // 复位后下一次失败必须从头开始（60s），而不是接着 300s
    const restart = await mod.recordSyncFailure(kv, now, 'net again');
    assert.equal(restart.consecutiveFailures, 1);
    assert.equal(restart.nextAllowedAt, now + 60_000, '复位后的第一次失败回到 60s');
  });

  it('退避窗口内应当跳过本轮；窗口过后放行', async () => {
    mod = await import('../src/background/syncBackoff.ts');
    const { kv } = memKv();
    const s = await mod.recordSyncFailure(kv, T0, 'net');

    assert.equal(mod.shouldSkipDueToBackoff(s, T0 + 10_000), true, '窗口内：跳过本轮');
    assert.equal(mod.shouldSkipDueToBackoff(s, s.nextAllowedAt - 1), true, '差 1ms 仍算窗口内');
    assert.equal(mod.shouldSkipDueToBackoff(s, s.nextAllowedAt), false, '到点：放行');
    assert.equal(
      mod.shouldSkipDueToBackoff({ consecutiveFailures: 0, nextAllowedAt: 0 }, T0),
      false,
      '未处于退避时永远不该跳过'
    );
  });
});

describe('F3 · 让路不算失败（回归：不能把「有任务在途」推进退避阶梯）', () => {
  // 这条是行为层的判据，配合 backgroundSync 的 outcome 分类：
  // 「让路」（队列里有 sync 任务 / 未登录 / 保护性跳过）都是**正常**的，
  // 它们下轮照常 60s 就跑到。若把它们计成失败，一次「用户正好在开 popup」的
  // 时序就能把失败次数推爆、最终停掉自动同步 —— 那比不做退避更糟。
  it('structure：performBackgroundSync 的三类返回各自标注了 ok 与 kind', () => {
    const src = readSrc('src/background/backgroundSync.ts');
    assert.match(src, /return \{ ok: true, kind: 'yielded', detail: '让路：已有同步任务在途' \};/,
      '让路必须是 ok（不进退避）');
    assert.match(src, /return \{ ok: true, kind: 'not_logged_in',/,
      '未登录不是同步故障');
    assert.match(src, /kind: 'yielded'/, '保护性跳过（recent_upload_guard 等）同样不是故障');
    assert.match(src, /return \{ ok: false, kind: 'failed', detail: '读不到 pending_upload 判据/,
      '真故障（fail-closed 中止）必须 ok:false —— 进退避阶梯');
    assert.match(src, /return \{ ok: false, kind: 'failed', detail: `上传未成功:/,
      '上传失败是真故障（修复前它 return true，于是每 60s 无限重试）');
  });

  it('behavior：handleAlarm 只在 outcome.ok === false 时推进阶梯', () => {
    const src = readSrc('src/background/backgroundSync.ts');
    const start = src.indexOf('async function handleAlarm');
    assert.ok(start !== -1, '应能找到 handleAlarm');
    const body = src.slice(start, src.indexOf('\n/**', start + 10));
    const successAt = body.indexOf('if (outcome.ok)');
    const failureAt = body.indexOf('recordSyncFailure');
    assert.ok(successAt !== -1 && failureAt !== -1);
    assert.ok(successAt < failureAt, '成功分支（复位）必须排在失败分支之前');
    assert.match(body, /if \(outcome\.ok\) \{\s*const before = state\.consecutiveFailures;\s*await recordSyncSuccess\(/,
      '成功 → recordSyncSuccess（复位）');
    assert.match(body, /\} else \{\s*const next = await recordSyncFailure\(/,
      '非成功 → recordSyncFailure（推进阶梯）；让路/未登录走不到这里');
  });
});

describe('F3 · 结构层：退避必须活过 SW 回收（不得依赖内存计数器）', () => {
  it('退避状态存在 chrome.storage.local（持久化），不是模块级变量', () => {
    const src = readSrc('src/background/backgroundSync.ts');
    assert.match(
      src,
      /chrome\.storage\.local\.get\(key\)/,
      '退避状态必须落 chrome.storage.local —— MV3 SW 随时被杀，模块变量下一轮就是 0'
    );
    assert.match(src, /chrome\.storage\.local\.set\(/, '失败计数要写回持久化存储');
    assert.match(src, /chrome\.storage\.local\.remove\(/, '复位要删掉持久化键');
    assert.doesNotMatch(
      src,
      /let\s+consecutiveFailures|var\s+consecutiveFailures/,
      '不得用模块级变量计失败次数：SW 一回收就归零，退避等于没做'
    );
    assert.doesNotMatch(
      src,
      /setTimeout\([^)]*consecutiveFailures/,
      '不得用 setTimeout 表达退避：MV3 SW idle 被杀后定时器必然丢失，只有 chrome.alarms 可靠'
    );
  });

  it('重排走 chrome.alarms.create（同名覆盖），周期恒为 60s、退避只改 delay', () => {
    const src = readSrc('src/background/backgroundSync.ts');
    const start = src.indexOf('function rescheduleAlarm');
    assert.ok(start !== -1, '应能找到 rescheduleAlarm');
    const body = src.slice(start, src.indexOf('\n}', start));
    assert.match(body, /chrome\.alarms\.create\(SYNC_ALARM, \{/,
      '重排必须用 chrome.alarms.create（同名覆盖旧 alarm）');
    assert.match(body, /periodInMinutes: NORMAL_INTERVAL_MINUTES/,
      'periodInMinutes 必须恒等于正常周期：退避只推迟**下一次**触发，' +
      '把它写成 period 会让故障恢复后仍停在慢速节奏（违反「成功必须复位」）');
    assert.match(body, /delayInMinutes: minutes/,
      '退避的那一拍由 delayInMinutes 表达');
  });

  it('setupBackgroundSync 同步创建 alarm（不 await），退避校正异步进行', () => {
    // 若整个注册都塞进 async IIFE，SW 刚起来的那段窗口里 alarm 根本不存在，
    // 而 Chrome 只保证「已存在的 alarm」会唤醒 SW。
    const src = readSrc('src/background/backgroundSync.ts');
    const start = src.indexOf('export function setupBackgroundSync');
    const body = src.slice(start, src.indexOf('\n/**', start + 10));
    const syncCreate = body.indexOf('rescheduleAlarm(NORMAL_INTERVAL_MINUTES)');
    const firstAwait = body.indexOf('await ');
    assert.ok(syncCreate !== -1, '必须先同步排一次正常节奏');
    assert.ok(
      syncCreate < firstAwait,
      '同步创建必须排在任何 await 之前（否则注册完成时 alarm 可能还不存在）'
    );
  });

  it('readBackoffState 读失败时 fail-open（读不到不该阻塞同步）', async () => {
    mod = await import('../src/background/syncBackoff.ts');
    const kv = {
      async get() { throw new Error('storage unavailable'); },
      async set() {},
      async remove() {},
    };
    const s = await mod.readBackoffState(kv);
    assert.equal(s.consecutiveFailures, 0, '读不到退避状态 → 按未退避处理');
    assert.equal(mod.shouldSkipDueToBackoff(s, Date.now()), false, '不得因此阻塞同步');
  });
});