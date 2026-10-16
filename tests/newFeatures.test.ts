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
  const clearedAlarms: string[] = [];
  const alarmListeners: Array<(alarm: chrome.alarms.Alarm) => void> = [];

  const chromeMock = {
    alarms: {
      create(name: string, opts: chrome.alarms.AlarmCreateInfo) {
        createCalls.push({ name, opts });
      },
      // 1.23.0：自动同步默认关闭后，setupBackgroundSync 的关态分支会调
      // alarms.clear（自愈关开关前排的那一次）。mock 缺这个方法时，
      // 异步段的 .catch(() => undefined) 抓不到 TypeError（那不是 Promise 拒绝，
      // 是同步抛错），直接变成 unhandledRejection 并让整份测试文件判红。
      // 补齐它，让 mock 与真实 chrome API 面保持一致。
      clear(name: string) {
        clearedAlarms.push(name);
        return Promise.resolve(true);
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
  return { createCalls, clearedAlarms, alarmListeners, mockStore, chromeMock };
}

/**
 * Wave 2A：带 window.localStorage 的 mock + settings 种子。
 *
 * readAutoSyncConfig 绕过 settings 缓存直接读盘（kvGet → storage-kv →
 * localStorage 回退驱动），所以「自动同步开启」的用例必须把种子灌进
 * localStorage，而不是 chrome.storage.local（后者只有退避状态在用）。
 */
function installChromeMockWithSettings(
  seed: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
) {
  const handles = installChromeMock(overrides);
  const lsData = new Map<string, string>();
  const stub = {
    get length() {
      return lsData.size;
    },
    key: (i: number) => [...lsData.keys()][i] ?? null,
    getItem: (k: string) => (lsData.has(k) ? (lsData.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      lsData.set(k, String(v));
    },
    removeItem: (k: string) => {
      lsData.delete(k);
    },
    clear: () => lsData.clear(),
  };
  (globalThis as Record<string, unknown>).window = { localStorage: stub };
  (globalThis as Record<string, unknown>).localStorage = stub;
  lsData.set('user_settings', JSON.stringify(seed));
  return handles;
}

/** 移除 localStorage 桩（防泄漏到同文件后续用例）。 */
function removeLocalStorageStub(): void {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).localStorage;
}

/** 等 setupBackgroundSync 的异步段跑完（排了 alarm 或清了 alarm 都算）。 */
async function waitForSetupDone(handles: {
  createCalls: unknown[];
  clearedAlarms: unknown[];
}): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (handles.createCalls.length > 0 || handles.clearedAlarms.length > 0) return;
    await new Promise(r => setTimeout(r, 5));
  }
}

// ── 1. 后台定时同步 ────────────────────────────────────────────────

describe('背景同步 chrome.alarms 注册', () => {
  // ── 2026-10-11（1.23.0）契约更新 ────────────────────────────────────────
  // 原用例钉的是「注册 interval=1 分钟的 alarm」——那是 1.22 的**唯一档位**。
  // 1.23.0 起自动同步默认关闭、且周期由用户选（5/10/30/60），这条断言的前提
  // （空存储 ⇒ 建 1 分钟 alarm）已不成立：空存储现在对应「关 ⇒ 不建 alarm」。
  //
  // 保留的真正约束（这才是本文件当初要防的东西）：
  //   1) 无论开关状态，alarm listener 必须注册（手动同步与将来重排都要它）；
  //   2) 非本 alarm 名称的事件必须静默返回（不抛错、不误触发同步）。
  // 「开态按档位建 alarm」的断言移到 tests/autoSyncDefaultOff.test.ts
  // ——那里有可控的设置种子，测的是同一个实现但带完整上下文。
  it('注册 listener；空存储（自动同步默认关）下不建 alarm', async () => {
    const { createCalls, alarmListeners } = installChromeMock();
    const { setupBackgroundSync } = await import('@/background/backgroundSync');

    setupBackgroundSync();

    // listener 必须无条件注册（1.23.0 起与开关无关）
    assert.equal(alarmListeners.length, 1, 'alarm listener 必须注册');
    // 默认关闭 ⇒ 不建 alarm（具体「关态清孤儿 alarm」等断言见 autoSyncDefaultOff）
    await new Promise(r => setTimeout(r, 30));
    assert.equal(createCalls.length, 0,
      `默认关闭时不得创建 alarm（实得 ${JSON.stringify(createCalls)}）`);

    // listener 收到非本 alarm 名称时静默返回（不抛错）
    await alarmListeners[0]({ name: 'other-alarm' } as chrome.alarms.Alarm);
  });
});

describe('背景同步未配置自带存储时按「让路」分类（Wave 2A）', () => {
  it('未配置云盘 ⇒ runBackgroundSyncOnce 返回 true（yielded，不进退避）', async () => {
    // [V1-FLIP → Wave 2A] 原用例断言 false（failed + 退避推进）。
    // 让路语义已落地：storage 为空 → 锁定占位后端抛 LockedBackendError
    // → syncEngine 标记 locked:true → performBackgroundSync 返回
    // { ok:true, kind:'yielded', locked:true } → 本函数返回 true。
    // 退避后果（不进退避、8 次也不清 alarm）由
    // tests/backgroundSyncLockedBackendOutcome.test.ts 逐条钉住。
    installChromeMock();
    const { runBackgroundSyncOnce } = await import('@/background/backgroundSync');

    const result = await runBackgroundSyncOnce();

    assert.equal(
      result,
      true,
      '未配置/未解锁云盘是正常用户状态，必须让路（ok:true），不得再当 failed 记账'
    );
  });

  it('重复触发（无存储）仍返回 true 且不抛异常（不得靠 typeof 空断言）', async () => {
    installChromeMock();
    const { runBackgroundSyncOnce } = await import('@/background/backgroundSync');
    const result = await runBackgroundSyncOnce();
    // 与上一条同环境：再次断言真实分类，顺带覆盖「连续调用不因模块状态漂移」。
    assert.equal(result, true, '无存储/未配置下持续让路（ok:true，kind yielded）');
  });
});

// ── Wave 2A：让路语义的两个对照面（真实故障仍退避 + 一次性提醒） ──────

describe('对照：真实网络/服务端故障仍进退避（让路不得扩散成「什么都不失败」）', () => {
  it('后端抛真实错误 ⇒ handleAlarm 推进阶梯 +1、重排 1 分钟的退避档', async () => {
    const handles = installChromeMockWithSettings({ syncEnabled: true, syncIntervalMinutes: 10 });
    const { setActiveSyncBackend, resetActiveSyncBackend } = await import('@/sync-backend');
    const { setupBackgroundSync } = await import('@/background/backgroundSync');
    const { BACKOFF_STATE_KEY } = await import('@/background/syncBackoff');

    // 真实故障替身：每个后端方法都抛普通 Error（等价于 HTTP 500 / 断网）。
    // 关键是它**不是** LockedBackendError，所以必须仍走 failed/退避。
    const realFailure = async (): Promise<never> => {
      throw new Error('GET 失败（HTTP 500）');
    };
    setActiveSyncBackend({
      id: 'webdav',
      label: 'test-backend',
      fetchFingerprints: realFailure,
      downloadGroups: realFailure,
      uploadGroups: realFailure,
      broadcastDeletes: realFailure,
      purgeExpiredDeletes: realFailure,
      uploadSettings: realFailure,
      downloadSettings: realFailure,
    } as unknown as Parameters<typeof setActiveSyncBackend>[0]);

    try {
      setupBackgroundSync();
      await waitForSetupDone(handles);
      const listener = handles.alarmListeners.at(-1);
      assert.ok(listener, 'handleAlarm 必须注册');

      const createsBefore = handles.createCalls.length;
      await listener({ name: 'tapstack-background-sync' } as chrome.alarms.Alarm);

      const state = handles.mockStore[BACKOFF_STATE_KEY] as
        | { consecutiveFailures: number; lastFailureReason?: string }
        | undefined;
      assert.equal(state?.consecutiveFailures, 1, '真实故障必须推进退避阶梯（+1）');
      assert.match(
        String(state?.lastFailureReason ?? ''),
        /自动下载未成功/,
        `失败原因应来自 failed 分支，实得: ${String(state?.lastFailureReason)}`
      );
      assert.ok(handles.createCalls.length > createsBefore, '失败后必须重排 alarm');
      assert.equal(
        handles.createCalls.at(-1)?.opts.delayInMinutes,
        1,
        '第 1 次真实失败的 delay 走退避阶梯（1 分钟），不是用户档位 10 分钟'
      );
      assert.equal(
        handles.clearedAlarms.filter(n => n === 'tapstack-background-sync').length,
        0,
        '未达上限不得清 alarm'
      );
    } finally {
      resetActiveSyncBackend();
      removeLocalStorageStub();
    }
  });
});

describe('未配置/未解锁 ⇒ 一次性可见提醒（Wave 2A 前是纯日志，用户零感知）', () => {
  it('同一锁定状态连续两轮 alarm ⇒ 只发一次通知，且文案指向配置/解锁', async () => {
    const notifications: Array<Record<string, unknown>> = [];
    const handles = installChromeMockWithSettings(
      { syncEnabled: true, syncIntervalMinutes: 10 },
      {
        notifications: {
          create(opts: Record<string, unknown>) {
            notifications.push(opts);
            return Promise.resolve();
          },
        },
        runtime: {
          getManifest: () => ({ version: 'test' }),
          getURL: (p: string) => `chrome-extension://test/${p}`,
        },
      }
    );
    const { setupBackgroundSync } = await import('@/background/backgroundSync');
    setupBackgroundSync();
    await waitForSetupDone(handles);
    const listener = handles.alarmListeners.at(-1);
    assert.ok(listener, 'handleAlarm 必须注册');

    try {
      await listener({ name: 'tapstack-background-sync' } as chrome.alarms.Alarm);
      await listener({ name: 'tapstack-background-sync' } as chrome.alarms.Alarm);

      assert.equal(notifications.length, 1, '未配置是持续状态，只应打扰一次');
      assert.match(
        String(notifications[0].message),
        /配置|解锁/,
        '提醒必须告诉用户下一步是配置或解锁'
      );
      assert.match(String(notifications[0].title), /同步/);
    } finally {
      removeLocalStorageStub();
    }
  });

  it('通知发送失败 ⇒ 标志不落盘，下一轮重试（不得把「发失败」记成「已提醒」）', async () => {
    // 2026-10-16 审查 L3：修复前的顺序是先置标志再发通知 —— create 抛错时
    // 标志已留下，同一锁定季后续轮次连尝试都不再做，用户永远看不到提醒
    // （与注释承诺的「下一季会再次提醒」不符）。修复后：create 成功才置标志。
    let attempts = 0;
    const handles = installChromeMockWithSettings(
      { syncEnabled: true, syncIntervalMinutes: 10 },
      {
        notifications: {
          create(_opts: Record<string, unknown>) {
            attempts += 1;
            return Promise.reject(new Error('通知 API 故障'));
          },
        },
        runtime: {
          getManifest: () => ({ version: 'test' }),
          getURL: (p: string) => `chrome-extension://test/${p}`,
        },
      }
    );
    const { setupBackgroundSync } = await import('@/background/backgroundSync');
    setupBackgroundSync();
    await waitForSetupDone(handles);
    const listener = handles.alarmListeners.at(-1);
    assert.ok(listener, 'handleAlarm 必须注册');

    try {
      await listener({ name: 'tapstack-background-sync' } as chrome.alarms.Alarm);
      await listener({ name: 'tapstack-background-sync' } as chrome.alarms.Alarm);

      assert.equal(attempts, 2, '发送失败后下一轮必须再次尝试（失败不是「已提醒」）');
      assert.equal(
        handles.mockStore['background_sync_locked_notice_shown'],
        undefined,
        'create 失败时一次性标志不得落盘'
      );
    } finally {
      removeLocalStorageStub();
    }
  });
});

// ── Wave 2A：WebDAV 请求级超时（挂死服务器不得钉死单写者队列） ──────────

describe('WebDAV 请求超时：可中止、可区分、不挂起', () => {
  it('挂死的服务器 ⇒ 在预算内抛出专属超时错误（isTimeout），而不是永远挂起', async () => {
    const { WebDavClient, WebDavError, WebDavRequestTimeoutError } = await import(
      '@/sync-backend/webdav/client'
    );
    let capturedSignal: AbortSignal | null | undefined;
    const hungFetch = ((_input: unknown, init?: { signal?: AbortSignal | null }) => {
      capturedSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError'))
        );
      });
    }) as unknown as typeof fetch;

    const client = new WebDavClient(
      { baseUrl: 'https://dav.example.com/', username: 'u', password: 'p' },
      hungFetch,
      undefined,
      { timeoutMs: 40 }
    );

    const started = Date.now();
    await assert.rejects(
      () => client.get('groups.json'),
      (err: unknown) => {
        assert.ok(
          err instanceof WebDavRequestTimeoutError,
          `必须是专属超时错误，实得 ${err instanceof Error ? err.name : String(err)}`
        );
        assert.ok(
          err instanceof WebDavError,
          '仍继承 WebDavError（调用方既有 instanceof WebDavError 分类不被打断）'
        );
        assert.equal((err as { isTimeout?: boolean }).isTimeout, true, 'isTimeout 标记必须为真');
        assert.equal((err as { status?: number }).status, 0, 'status 仍是传输层失败的 0');
        assert.match((err as Error).message, /请求超时/, '文案必须明确是超时而不是普通请求失败');
        assert.match((err as Error).message, /未能完成/, '必须说明请求未完成');
        return true;
      }
    );
    assert.ok(capturedSignal, 'fetch 必须收到 AbortSignal（可中止是超时的前提）');
    assert.ok(Date.now() - started < 2000, '必须在毫秒级返回，证明没有真的挂住');
  });

  it('写请求（PUT）同样有超时 —— 不会把单写者队列钉死到用户操作后面', async () => {
    const { WebDavClient, WebDavRequestTimeoutError } = await import('@/sync-backend/webdav/client');
    const hungFetch = ((_input: unknown, init?: { signal?: AbortSignal | null }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError'))
        );
      })) as unknown as typeof fetch;

    const client = new WebDavClient(
      { baseUrl: 'https://dav.example.com/', username: 'u', password: 'p' },
      hungFetch,
      undefined,
      { timeoutMs: 40 }
    );

    await assert.rejects(
      () => client.put('shard.json', '{}'),
      (err: unknown) => {
        assert.ok(err instanceof WebDavRequestTimeoutError, 'PUT 也必须是专属超时错误');
        assert.equal((err as { method?: string }).method, 'PUT');
        assert.equal((err as { isTimeout?: boolean }).isTimeout, true);
        return true;
      }
    );
  });

  it('对比：普通网络失败不是超时（同一分类体系里可区分）', async () => {
    const { WebDavClient, WebDavError, WebDavRequestTimeoutError } = await import(
      '@/sync-backend/webdav/client'
    );
    const failingFetch = (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
    const client = new WebDavClient(
      { baseUrl: 'https://dav.example.com/', username: 'u', password: 'p' },
      failingFetch,
      undefined,
      { timeoutMs: 5000 }
    );

    await assert.rejects(
      () => client.get('groups.json'),
      (err: unknown) => {
        assert.ok(err instanceof WebDavError, '网络失败仍是 WebDavError');
        assert.ok(!(err instanceof WebDavRequestTimeoutError), '网络失败不得被误判成超时');
        assert.equal((err as { isTimeout?: boolean }).isTimeout, false, 'isTimeout 必须为 false');
        assert.match((err as Error).message, /GET 请求失败/, '文案必须保留原始失败信息');
        return true;
      }
    );
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

    // openTabsInCurrentWindow 的形参就是 Array<{ url: string; pinned?: boolean }>
    // （src/background/TabManager.ts:340）——chrome.tabs.create 也只吃得到
    // url/active/pinned/index，title 与 favicon 根本无处可去。这里只传真会被读的字段。
    await manager.openTabsInCurrentWindow([
      { url: 'https://a.example', pinned: true },
      { url: 'https://b.example', pinned: false },
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
      { url: 'https://c.example', pinned: false },
    ]);

    assert.equal(created.length, 1);
    assert.equal(created[0].index, undefined);
    assert.equal(created[0].url, 'https://c.example');
  });
});

// ── 3. 灵敏数据跨上下文存取：会话内存，跨 SW 重启唯独丢掉口令 ────────
//
// 2026-10-16：原组是「supabase 客户端共享 storage adapter ——
// session token 读写落到 chrome.storage.local 而非内存」。
// supabase-js 与它的跨上下文 session 持久化随云端整体删除。
// 现在唯一的敏感信息是 WebDAV 应用密码与加密口令，它们走
// `chrome.storage.session`（跨上下文、但**不落盘**）。本组的守卫方向是：
//   · 凭据的跨上下文回路真实可用（set/get 同一 username 往返）；
//   · 但回路的存放位置必须是 session（非 local）—— 落进 local 才是真的泄露。
describe('会话凭据的跨上下文存取（session 存储，不落盘）', () => {
  it('同一 username 的 set/get 往返', async () => {
    installChromeMock({
      // chrome.storage.session 是 MV3 的内存态 kv：此处用真内存 Map 模拟。
      storage: (() => {
        const sessionData = new Map<string, unknown>();
        const localData = new Map<string, unknown>();
        const api = (m: Map<string, unknown>) => ({
          // 注意参数类型：config.ts 用的是「对象形 get({KEY})」，不是数组形。
          async get(keys: string | string[] | Record<string, unknown>) {
            const out: Record<string, unknown> = {};
            const list =
              typeof keys === 'string'
                ? [keys]
                : Array.isArray(keys)
                  ? keys
                  : Object.keys(keys);
            for (const k of list) out[k] = m.get(k);
            return out;
          },
          async set(items: Record<string, unknown>) {
            for (const [k, v] of Object.entries(items)) m.set(k, v);
          },
          async remove(keys: string | string[]) {
            const list = Array.isArray(keys) ? keys : [keys];
            for (const k of list) m.delete(k);
          },
        });
        return { session: api(sessionData), local: api(localData) };
      })(),
    });
    const { setSessionSecrets, getSessionSecrets, clearSessionSecrets } =
      await import('@/sync-backend/webdav/config');

    await clearSessionSecrets();
    await setSessionSecrets('u', 'p', 'pp');
    const back = await getSessionSecrets('u');
    assert.deepEqual(back, { password: 'p', passphrase: 'pp' });
    assert.equal(await getSessionSecrets('someone-else'), null, '换了用户必须视为未解锁');
    await clearSessionSecrets();
  });

  it('存放位置是 session 而不是 local（否则就是落盘）', () => {
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../src/sync-backend/webdav/config.ts'),
      'utf8'
    );
    // 存储镜像在两个地方写死：存配置校验用 local、存口令用 session。
    // 后者一旦写成 local，应用密码与加密口令会躺在磁盘上 —— 这正是要防的。
    assert.match(src, /chrome\.storage\.session/, '口令回路必须走 chrome.storage.session');
  });
});