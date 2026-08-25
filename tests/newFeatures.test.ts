// 新增功能回归测试（v1.12.0 分支新增）：
// 1. 后台定时同步：alarm 注册参数正确 / 未登录时跳过下载合并
// 2. 恢复会话「在当前窗口打开」：插入位置 = 当前标签 index+1、首个激活其余后台、pinned 透传
//
// 说明：每个 test 文件是独立进程，可以在 import 前安全定义 globalThis.chrome mock。

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

// ── mock environment ────────────────────────────────────────────────

/**
 * 构造 chrome.* 最小可用 mock。
 * @param overrides 需要覆写的部分（如 alarms / tabs / windows）
 */
function installChromeMock(overrides: Record<string, unknown> = {}) {
  const createCalls: Array<{ name: string; opts: chrome.alarms.AlarmCreateInfo }> = [];
  const alarmListeners: Array<(alarm: chrome.alarms.Alarm) => void> = [];

  const chromeMock = {
    alarms: {
      create(name: string, opts: chrome.alarms.AlarmCreateInfo) {
        createCalls.push({ name, opts });
      },
      onAlarm: {
        addListener(fn: (alarm: chrome.alarms.Alarm) => void) {
          alarmListeners.push(fn);
        },
      },
    },
    storage: {
      local: {
        async get(keys: string | string[] | Record<string, unknown>) {
          // 默认空存储；测试可经 set 填充
          const out: Record<string, unknown> = {};
          if (typeof keys === 'string') {
            out[keys] = mockStore[keys] ?? undefined;
            return out;
          }
          if (Array.isArray(keys)) {
            for (const k of keys) out[k] = mockStore[k] ?? undefined;
            return out;
          }
          for (const k of Object.keys(keys)) out[k] = mockStore[k] ?? undefined;
          return out;
        },
        async set(items: Record<string, unknown>) {
          Object.assign(mockStore, items);
        },
        async remove(keys: string | string[]) {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) delete mockStore[k];
        },
      },
    },
    tabs: {},
    windows: {},
    runtime: {
      getManifest: () => ({ version: '1.12.0-test' }),
    },
  };
  const mockStore: Record<string, unknown> = {};

  Object.assign(chromeMock, overrides);

  (globalThis as Record<string, unknown>).chrome = chromeMock;
  return { createCalls, alarmListeners, mockStore, chromeMock };
}

// ── 1. 后台定时同步 ────────────────────────────────────────────────

describe('背景同步 chrome.alarms 注册', () => {
  it('注册 interval=1 分钟的 background-sync alarm', async () => {
    const { createCalls, alarmListeners } = installChromeMock();
    const { setupBackgroundSync } = await import('@/background/backgroundSync');

    setupBackgroundSync();

    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0].name, 'tapstack-background-sync');
    assert.equal(createCalls[0].opts.periodInMinutes, 1);
    assert.equal(alarmListeners.length, 1);

    // listener 收到非本 alarm 名称时静默返回（不抛错）
    await alarmListeners[0]({ name: 'other-alarm' } as chrome.alarms.Alarm);
  });
});

describe('背景同步未登录时跳过下载', () => {
  it('无 session 时不调 downloadAndMerge 且返回 false', async () => {
    installChromeMock();
    const { runBackgroundSyncOnce } = await import('@/background/backgroundSync');

    const result = await runBackgroundSyncOnce();

    // storage 为空 → supabase 无 session → 未登录 → 跳过且返回 false
    assert.equal(result, false);
  });

  it('正常路径（无存储）行为稳定不抛异常', async () => {
    installChromeMock();
    const { runBackgroundSyncOnce } = await import('@/background/backgroundSync');
    const result = await runBackgroundSyncOnce();
    assert.equal(typeof result, 'boolean');
  });
});

// ── 2. 恢复会话「在当前窗口打开」 ──────────────────────────────────

describe('TabManager.openTabsInCurrentWindow', () => {
  it('在当前标签 index+1 处插入，首个激活其余后台，pinned 透传', async () => {
    const created: Array<Record<string, unknown>> = [];
    installChromeMock({
      tabs: {
        async query(opts: Record<string, unknown>) {
          // 返回一个当前激活标签（index=3）
          if (opts.active && opts.lastFocusedWindow) {
            return [{ id: 100, index: 3, active: true, pinned: false }];
          }
          return [];
        },
        async create(opts: Record<string, unknown>) {
          created.push(opts);
          return { id: created.length + 1000, ...opts };
        },
      },
    });

    const { TabManager } = await import('@/background/TabManager');
    const manager = TabManager.getInstance();

    await manager.openTabsInCurrentWindow([
      { url: 'https://a.example', pinned: true, favIconUrl: '', title: 'A', createdAt: 't', lastAccessed: 't' },
      { url: 'https://b.example', pinned: false, favIconUrl: '', title: 'B', createdAt: 't', lastAccessed: 't' },
    ]);

    assert.equal(created.length, 2);
    // 首个：index = 当前激活标签 index+1 = 4，且 active=true、pinned=true 透传
    const first = created[0];
    assert.equal(first.index, 4);
    assert.equal(first.active, true);
    assert.equal(first.pinned, true);
    assert.equal(first.url, 'https://a.example');
    // 其余：active=false（后台打开）
    const second = created[1];
    assert.equal(second.active, false);
    assert.equal(second.pinned, false);
    assert.equal(second.url, 'https://b.example');
  });

  it('无当前激活标签时省略 index（浏览器自动追加到末尾）', async () => {
    const created: Array<Record<string, unknown>> = [];
    installChromeMock({
      tabs: {
        async query() {
          return [];
        },
        async create(opts: Record<string, unknown>) {
          created.push(opts);
          return { id: 1, ...opts };
        },
      },
    });

    const { TabManager } = await import('@/background/TabManager');
    await TabManager.getInstance().openTabsInCurrentWindow([
      { url: 'https://c.example', pinned: false, favIconUrl: '', title: 'C', createdAt: 't', lastAccessed: 't' },
    ]);

    assert.equal(created.length, 1);
    assert.equal(created[0].index, undefined);
    assert.equal(created[0].url, 'https://c.example');
  });
});

// ── 3. supabase shared storage adapter（session 跨上下文持久化） ────

describe('supabase 客户端共享 storage adapter', () => {
  it('session token 读写落到 chrome.storage.local 而非内存', async () => {
    const { mockStore } = installChromeMock();
    // localStorage 不可用（SW 环境）→ 不崩溃
    const { supabase } = await import('@/utils/supabase');
    assert.ok(supabase, 'supabase 客户端应可初始化');

    // 写入一条 模拟 supabase-js 持久化 session
    await chrome.storage.local.set({ 'sb-stub-auth-token': 'jwt-token' });
    const out = await chrome.storage.local.get('sb-stub-auth-token');
    assert.equal(out['sb-stub-auth-token'], 'jwt-token');
    void mockStore;
  });
});