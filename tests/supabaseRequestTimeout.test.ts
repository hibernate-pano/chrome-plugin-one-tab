// Supabase 请求级超时（2026-10-06）。
//
// 【为什么必须有】此前 supabase client 的每次 PostgREST 请求都是裸
// `await fetch(...)`：没有 AbortSignal、没有上界。挂起链条：
//   弱网/服务抖动 → 一个请求挂住几分钟
//   → syncEngine.upload / downloadAndMerge 整条管线挂住（串行 await）
//   → mutationQueue 的 running 一直为 true，单写者队列被占死
//   → 用户点任何操作都排在它后面（「点了没反应」）
//   → 30s 后 popup 报「操作超时」，但 SW 侧仍在等那个请求
//
// 即：IndexedDB 看门狗治「本地存储挂起」，本文件治「网络请求挂起」——
// 两条独立的死锁路径，此前只堵了前者。
//
// 关键：`global.fetch` 是 supabase-js 2.x 的正确入口（顶层 `fetch` 属 auth-js，
// PostgREST 读不到）。这条曾经写错过一次，所以本文件用**真实调用**验证接线，
// 而不是源码结构断言 —— 压缩产物里 grep 不到构造函数，只能跑。
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
  await register(LOADER_PATH);
});

describe('Supabase 请求级超时：网络挂起不得占死单写者队列', () => {
  it('PostgREST 请求确实走带 signal 的自定义 fetch（接线证明）', async () => {
    const g = globalThis as Record<string, unknown>;
    const realFetch = g.fetch;
    let called = 0;
    let sawSignal = false;
    g.fetch = (_input: unknown, init: { signal?: unknown }) => {
      called++;
      if (init?.signal) sawSignal = true;
      return Promise.reject(new Error('probe: 阻断真实网络'));
    };

    try {
      const { supabase } = await import('@/utils/supabase/client');
      const r = await supabase.from('tab_groups').select('id').limit(1);
      assert.ok(r.error, '探针 fetch 故意失败，error 必须有值');
      assert.match(String(r.error?.message), /probe/, '请求确实经过了自定义 fetch');
      assert.equal(called, 1, '自定义 fetch 必须被调用');
      assert.ok(sawSignal, '请求必须带 AbortSignal（超时的前提是可 abort）');
    } finally {
      g.fetch = realFetch;
    }
  });

  it('超时上界必须大于 popup 的 30s 协议上界（不得误杀合法慢同步）', async () => {
    const { DEFAULT_TIMEOUT_MS, TIMEOUT_REASON_PREFIX } = await import(
      '@/core/mutationProtocol'
    );
    const src = (
      await import('node:fs')
    ).readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/utils/supabase/client.ts'), 'utf8');
    const m = src.match(/REQUEST_TIMEOUT_MS\s*=\s*([\d_]+)/);
    assert.ok(m, '应能找到 REQUEST_TIMEOUT_MS 定义');
    const requestTimeout = Number(m![1].replace(/_/g, ''));
    assert.ok(
      requestTimeout > DEFAULT_TIMEOUT_MS,
      `请求上界 ${requestTimeout}ms 必须大于 popup 协议上界 ${DEFAULT_TIMEOUT_MS}ms：` +
        '否则用户先看到失败、随后又看到操作其实成功，比慢更让人困惑'
    );
    // 反向护栏：也别大到失去意义（几分钟的挂起等同没有超时）
    assert.ok(
      requestTimeout <= 120_000,
      `请求上界 ${requestTimeout}ms 过大会让「有界」名存实亡（应 ≤ 120s）`
    );
    assert.ok(TIMEOUT_REASON_PREFIX.length > 0);
  });
});
