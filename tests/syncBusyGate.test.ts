// 同步任务去重闸门（1.22.12）——线上三连超时日志的「重复整库下载」那一半根因。
//
// 【要防的回归类别】downloadAndMerge/upload 内部的 isSyncing 守卫在单写者队列下
// 是**死守卫**：SYNC 消息先 enqueue、任务后执行，轮到第二个任务时前一个必然已
// 跑完、isSyncing=false。于是：
//   - 每次开 popup 的 AutoSync 下载 与 每 60s 的后台 alarm 下载 一个接一个
//     全量串跑（用户日志里 normalizeTabsData 告警 3 组 × 2 轮 = 两轮全量下载）；
//   - AutoSync 为排队付满 30s 协议超时 → 「操作超时…：download」；
//   - 用户点击的 removeTab 排在叠起来的同步管线后面 → 连环超时。
// 修法是把去重挪到**入队之前**，判据取自队列的在途状态（hasQueuedOrRunningJob）。
//
// 本文件钉两层：
//   1) 行为层：backgroundSync 在同步任务在途时整轮让路（可执行验证）；
//   2) 结构层：service-worker 的 SYNC 分支闸门、auto 标记的生产者状态
//      —— SW 入口无法在 node:test 里加载（模块顶层即触 chrome.*），
//      按仓库既有惯例（tests/guards/*）读源码结构断言。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';

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

// ── 结构层：源码断言（剥注释，避免注释里提到函数名造成误判） ──────────────

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('去重闸门：service-worker 的 SYNC 分支（结构层）', () => {
  it(`auto 下载在入队之前用 hasQueuedOrRunningJob('sync:') 拦截，并回 already_syncing`, () => {
    const src = code('src/service-worker.ts');
    const start = src.indexOf("case 'SYNC'");
    assert.ok(start !== -1, '应能找到 SYNC 分支');
    const branch = src.slice(start, src.indexOf('default:', start));

    const gateAt = branch.indexOf("hasQueuedOrRunningJob('sync:')");
    assert.ok(gateAt !== -1, 'SYNC 分支必须有队列在途闸门 —— isSyncing 守卫在队列下永远为假');
    const enqueueAt = branch.indexOf('enqueue(`sync:${data.op}`');
    assert.ok(enqueueAt !== -1, '应能找到入队语句');
    assert.ok(gateAt < enqueueAt, '闸门必须在入队之前 —— 入队后再查就晚了（任务已排上）');

    assert.match(branch, /data\.auto === true/, '闸门只拦 auto（popup 自动触发）下载，手点下载不受影响');
    assert.match(branch, /already_syncing/, '拦截必须回既有 reason already_syncing（调用方已知如何处理）');
  });

  // 2026-10-16：原用例钉的是 AuthProvider 的自动下载必须带 `auto: true`
  //   （没有标记则闸门的 auto 分支永不触发，修复等于没上）。
  //   AuthProvider 随账号体系删除，它是 `auto` 的**唯一生产者**，
  //   现在全仓已无任何调用点发 `auto: true`（自动同步走 backgroundSync 的
  //   alarm 轮询，闸门在那边有独立的在途判据，见下一组用例）。
  //   所以这里从「必须有生产者」反转成两条：
  //     (a) 闸门的 auto 分支不得被静默删除；
  //     (b) 全仓不得从别处复活一个不带约定的新生产者。
  it('auto 分支仍在 SW 的去重闸门里（即使暂时没有生产者也不许被删）', () => {
    const src = code('src/service-worker.ts');
    assert.match(
      src,
      /data\.auto === true/,
      'SW 闸门的 auto 分支被删了——「只拦自动触发、不拦用户手动」的语义将失去守卫'
    );
  });

  it('全仓已无 auto: true 的生产者（AuthProvider 已删，不得从别处复活）', () => {
    const producers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') continue;
          walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          const text = readFileSync(full, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^[ \t]*\/\/.*$/gm, '');
          if (/auto:\s*true/.test(text)) producers.push(full.slice(ROOT.length + 1));
        }
      }
    };
    walk(resolve(ROOT, 'src'));
    assert.deepEqual(
      producers,
      [],
      '又出现了 auto: true 的生产者：它必须同时满足「已同步语义」与闸门约定，否则要去买一组配套断言'
    );
  });
});

describe('去重闸门：backgroundSync 的轮询让路（结构层）', () => {
  it('performBackgroundSync 先查在途再入队（不叠第二条整库管线）', () => {
    const src = code('src/background/backgroundSync.ts');
    const start = src.indexOf('async function performBackgroundSync');
    assert.ok(start !== -1, '应能找到 performBackgroundSync');
    const body = src.slice(start);

    const gateAt = body.indexOf("hasQueuedOrRunningJob('sync:')");
    assert.ok(gateAt !== -1, '后台轮询必须有在途闸门 —— alarm 每 60s 一次，会与 AutoSync 叠加');
    const uploadEnqueueAt = body.indexOf("enqueue('sync:upload'");
    const downloadEnqueueAt = body.indexOf("enqueue('sync:download'");
    assert.ok(uploadEnqueueAt !== -1 && downloadEnqueueAt !== -1);
    assert.ok(
      gateAt < uploadEnqueueAt && gateAt < downloadEnqueueAt,
      '闸门必须排在两次入队之前，否则本轮已经把任务排上了'
    );
  });
});

// ── 行为层：backgroundSync 真实执行（chrome mock + 真队列） ────────────────

/** 最小 chrome mock：backgroundSync → store → supabase facade 导入所需。 */
function installChromeMock() {
  const mockStore: Record<string, unknown> = {};
  (globalThis as Record<string, unknown>).chrome = {
    alarms: {
      create: () => undefined,
      onAlarm: { addListener: () => undefined },
      clear: async () => true,
    },
    storage: {
      local: {
        async get(keys: string | string[]) {
          if (typeof keys === 'string') return { [keys]: mockStore[keys] };
          const out: Record<string, unknown> = {};
          for (const k of keys) out[k] = mockStore[k];
          return out;
        },
        async set(items: Record<string, unknown>) {
          Object.assign(mockStore, items);
        },
        async remove(keys: string | string[]) {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete mockStore[k];
        },
      },
    },
    tabs: {},
    windows: {},
    runtime: { getManifest: () => ({ version: '1.22.12-test' }) },
  };
  return mockStore;
}

describe('去重闸门：同步任务在途时后台轮询让路（行为层）', () => {
  it('队列被 sync 任务占着 → runBackgroundSyncOnce 直接跳过；空闲后恢复原逻辑', async () => {
    installChromeMock();
    const { enqueue, resetQueue, hasQueuedOrRunningJob } = await import('@/background/mutationQueue');
    resetQueue();

    // 占住队列：模拟一条正在执行的整库下载（job 不自结束，由测试释放）
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const busy = enqueue('sync:download', () => gate);
    assert.equal(hasQueuedOrRunningJob('sync:'), true);

    const { runBackgroundSyncOnce } = await import('@/background/backgroundSync');
    // 闸门在管线之前：占着队列时本轮根本不进 performBackgroundSync。
    // [V1-FLIP / Wave 2A] 注意布尔返回值已**不再**能区分「在途让路」与
    // 「未配置让路」：账号体系删除后未配置也会返回 true（yielded）。
    // 本用例守的是「占着队列时不叠第二条管线」，判别力在文件开头的结构断言
    // （闸门必须排在两次入队之前）与 backgroundSyncLockedBackendOutcome 的让路语义上。
    const skipped = await runBackgroundSyncOnce();
    assert.equal(skipped, true, '同步任务在途时必须整轮让路，而不是叠第二条管线');

    release();
    await busy;

    // 队列空了 → 闸门放行 → 走原逻辑（Wave 2A：未配置云盘 = 让路 → true），
    // 证明闸门没有永久卡死轮询。
    const idleResult = await runBackgroundSyncOnce();
    assert.equal(idleResult, true, '空闲时必须恢复原逻辑（未配置 ⇒ 让路），闸门不得常驻拦截');
    resetQueue();
  });
});
