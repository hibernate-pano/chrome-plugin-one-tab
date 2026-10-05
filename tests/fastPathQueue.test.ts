// 快路径上传必须经单写者队列——1.22.10 修复的回归钉。
//
// 【为什么有这份文件】体检（docs/health-check-2026-10-05.md）P1：syncEngine.scheduleUpload
// 的 setTimeout 快路径此前直接 `void this.upload()`，绕过 mutationQueue。上传路径有四条，
// 其余三条（popup 手动 SYNC、后台轮询 backgroundSync、alarm 兜底）都已在调用方 enqueue，
// 唯独快路径漏了。upload() 内部有两组非原子读-改-写（读广播队列 → markCloudGroupsAsDeleted
// → 按确认清队；读 groups → 整组覆盖写），与队列内正在执行的 mutation 交错时，删除广播
// 意图可能被覆盖丢失 → 对端复活。这与 service-worker.ts「所有数据写动作经 mutationQueue
// 串行化」的设计承诺直接矛盾。
//
// 修复后四条路径分工一处包裹（双层包裹 = 死锁，见 syncEngine.scheduleUpload 注释）：
// 本文件钉的就是第四条——快路径的 upload 必须排在队列里已有任务之后。
//
// 【反向验证】在修复前的代码上跑红过：队列被 test:slow 占住时，timer 直调的 upload()
// 已经跑完并把 pending_upload 清成 false（第一条断言失败）。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { stubSessionJson } from './_helpers/stubSession.ts';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};
const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

if (!process.env.VERBOSE) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

const USER_ID = 'user-under-test';
const SESSION_KEY = 'sb-stub-auth-token';

// 本地存储底座（KV 驱动在无 indexedDB 时回退 localStorage）
const base = new Map<string, string>();
(globalThis as Record<string, unknown>).window = {
  localStorage: {
    get length() {
      return base.size;
    },
    key: (i: number) => [...base.keys()][i] ?? null,
    getItem: (k: string) => (base.has(k) ? (base.get(k) as string) : null),
    setItem: (k: string, v: string) => void base.set(k, String(v)),
    removeItem: (k: string) => void base.delete(k),
    clear: () => base.clear(),
  },
};
(globalThis as Record<string, unknown>).localStorage = (globalThis as any).window.localStorage;

const chromeData = new Map<string, unknown>();
(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get: async (k: string | string[]) => {
        const keys = Array.isArray(k) ? k : [k];
        const out: Record<string, unknown> = {};
        for (const key of keys) if (chromeData.has(key)) out[key] = chromeData.get(key);
        return out;
      },
      set: async (obj: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(obj)) chromeData.set(k, v);
      },
      remove: async (k: string) => void chromeData.delete(k),
    },
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  },
  runtime: { getManifest: () => ({ version: 'test' }) },
  // alarms 存在 → scheduleUpload 走生产分支（双驱动的 setTimeout 快路径 + alarm 兜底）
  alarms: { create: () => undefined, clear: async () => true, onAlarm: { addListener: () => undefined } },
};

// 极简假云端：本用例只考察「上传有没有抢跑」，不考察上传内容。
// upload() 在空本地时不会 upsert，只有 purgeExpiredCloudTombstones 的 GET（失败也被
// syncEngine 吞掉不阻断），因此 GET 返回空集即可。
globalThis.fetch = (async (input: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.pathname.endsWith('/auth/v1/user')) {
    return new Response(JSON.stringify({ id: USER_ID, aud: 'authenticated', role: 'authenticated' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (url.pathname.endsWith('/rest/v1/tab_groups')) {
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
}) as typeof fetch;

const tick = (ms: number) => new Promise(r => setTimeout(r, ms));

before(async () => {
  register(LOADER_PATH);
  chromeData.set(SESSION_KEY, stubSessionJson(USER_ID));

  const { store } = await import('@/store');
  const { setFromCache } = await import('@/store/slices/authSlice');
  store.dispatch(setFromCache({ user: { id: USER_ID } as never, isAuthenticated: true }));

  base.set('storage_version', JSON.stringify(5));
  base.set('tabvaultpro_device_id', JSON.stringify('devA'));
  base.set('op_stamp_migrated', JSON.stringify(true));
});

describe('scheduleUpload 快路径：timer 回调必须经单写者队列（不绕过 mutationQueue）', () => {
  it('队列被占住时上传不得抢跑；队列放行后才执行并清掉 pending_upload', async () => {
    const { enqueue } = await import('@/background/mutationQueue');
    let release = () => {};
    const gate = new Promise<void>(r => {
      release = r;
    });
    // 占住队列：这个 job 不放行，排在它后面的一切（包括快路径上传）都不该执行
    const slow = enqueue('test:slow', () => gate);

    const { syncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');

    // 0ms 定时器：到点后把 upload 入队——必须排在被占住的 slow 之后
    await syncEngine.scheduleUpload(0);
    await tick(50);

    assert.equal(
      await storage.getPendingUpload(),
      true,
      '队列被占住时，快路径上传不得抢跑（修复前：timer 直调 upload()，' +
      '此刻它已经跑完并把 pending_upload 清成 false——与单写者承诺矛盾）'
    );

    release();
    await slow;
    await tick(50);

    assert.equal(
      await storage.getPendingUpload(),
      false,
      '队列放行后，快路径上传应正常执行完成并清掉 pending_upload'
    );
  });
});
