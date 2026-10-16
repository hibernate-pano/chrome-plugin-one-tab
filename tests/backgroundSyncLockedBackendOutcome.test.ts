// Wave 2A 目标语义已落地（2026-10-16 晚）：未配置/未解锁云盘时后台同步的分类与退避后果。
//
// ══════════════════════════════════════════════════════════════════════════
// 【已落地：让路语义】
//   未配置/未解锁云盘 = 正常的用户状态，不是故障。目标（现已实现）：
//     · performBackgroundSync 对该情形返回 { ok: true, kind: 'yielded', locked: true }；
//     · 因此不推进退避阶梯、不在连续失败达 MAX_CONSECUTIVE_FAILURES(8) 时
//       清掉 alarm（旧行为会静默停掉自动同步），并给用户一次性可见提醒。
//   落点：src/background/backgroundSync.ts 的 outcome 分类 + handleAlarm 的
//   locked 分支；分类判据是 sync-backend 的 LockedBackendError（机器码，非文案）。
//   ⚠️ 真实网络/服务端故障仍走 { ok:false, kind:'failed' } 与退避阶梯 ——
//   对照用例在 tests/newFeatures.test.ts「对照：真实故障仍进退避」。
// ══════════════════════════════════════════════════════════════════════════
//
// 本文件断言的是**让路语义落地后的真实行为**：
//   1) runBackgroundSyncOnce()（= outcome.ok）返回 true；
//   2) handleAlarm 对锁定后端不记账 → 不推进阶梯、按用户档位（10 分钟）重排 alarm；
//   3) 即使已预置 7 次失败，本轮仍不清 SYNC_ALARM、不把计数推到 8。
//
// 为什么必须驱动 handleAlarm 而不是 runBackgroundSyncOnce：
// runBackgroundSyncOnce 明确「不记账退避」（只服务手动触发），用它断不出
// 「退避真的没被推进」这件事；必须看 handleAlarm 收尾后的持久化状态与 alarm 调用。
//
// 环境纪律（抄自 autoSyncDefaultOff.test.ts 的教训）：**整个文件只装一次
// chrome mock**，真实 alarm 回调由 setupBackgroundSync 捕获 —— 每个用例重装
// mock 会让 listener 闭包指向旧 mock，「被断言的观测量与被测代码不在同一对象上」
// 时测试必假绿。settings 种子种进 localStorage（readAutoSyncConfig 直接读盘）。
import { describe, it, before, beforeEach } from 'node:test';
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

if (!process.env.VERBOSE) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

type CreateCall = { name: string; opts: chrome.alarms.AlarmCreateInfo };

function installChromeMock(seedSettings: Record<string, unknown> | null = null) {
  const createCalls: CreateCall[] = [];
  const clearedAlarms: string[] = [];
  const alarmListeners: Array<(alarm: chrome.alarms.Alarm) => void> = [];
  // 退避状态写这里（backoffKv = chrome.storage.local）。
  const mockStore: Record<string, unknown> = {};

  // readAutoSyncConfig 绕过 settings 缓存直接读盘（storage-kv → localStorage 驱动）。
  const lsData = new Map<string, string>();
  const localStorageStub = {
    get length() { return lsData.size; },
    key: (i: number) => [...lsData.keys()][i] ?? null,
    getItem: (k: string) => (lsData.has(k) ? (lsData.get(k) as string) : null),
    setItem: (k: string, v: string) => { lsData.set(k, String(v)); },
    removeItem: (k: string) => { lsData.delete(k); },
    clear: () => lsData.clear(),
  };
  (globalThis as Record<string, unknown>).window = { localStorage: localStorageStub };
  (globalThis as Record<string, unknown>).localStorage = localStorageStub;
  if (seedSettings) lsData.set('user_settings', JSON.stringify(seedSettings));

  (globalThis as Record<string, unknown>).chrome = {
    alarms: {
      create(name: string, opts: chrome.alarms.AlarmCreateInfo) {
        createCalls.push({ name, opts });
      },
      clear(name: string) {
        clearedAlarms.push(name);
        return Promise.resolve();
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
          const out: Record<string, unknown> = {};
          if (typeof keys === 'string') out[keys] = mockStore[keys] ?? undefined;
          else if (Array.isArray(keys)) for (const k of keys) out[k] = mockStore[k] ?? undefined;
          else for (const k of Object.keys(keys)) out[k] = mockStore[k] ?? undefined;
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
    runtime: { getManifest: () => ({ version: 'test' }) },
  };
  return { createCalls, clearedAlarms, alarmListeners, mockStore };
}

/** 等 setupBackgroundSync 的异步段跑完（与 autoSyncDefaultOff.test.ts 同一等待式）。 */
async function waitForSetup(handles: { createCalls: unknown[]; clearedAlarms: unknown[] }): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (handles.createCalls.length > 0 || handles.clearedAlarms.length > 0) return;
    await new Promise(r => setTimeout(r, 5));
  }
}

let handles: ReturnType<typeof installChromeMock>;
let alarmListener: (alarm: chrome.alarms.Alarm) => void;
let BACKOFF_STATE_KEY: string;

/** 只数后台同步 alarm 的 clear：引擎取消上传 alarm（tapstack-scheduled-upload）会混进来。 */
const clearedSyncAlarms = () =>
  handles.clearedAlarms.filter(name => name === 'tapstack-background-sync').length;

before(async () => {
  register(LOADER_PATH);
  // 自动同步开启（否则 handleAlarm 第一步就是「关则自杀」，根本走不到管线）。
  handles = installChromeMock({ syncEnabled: true, syncIntervalMinutes: 10 });
  const mod = await import('@/background/backgroundSync');
  ({ BACKOFF_STATE_KEY } = await import('@/background/syncBackoff'));

  // 清掉 settings 的 60s 进程内缓存（种子是 before 里灌的，防串味）。
  const { cacheManager } = await import('@/utils/performance');
  cacheManager.getCache('storage').delete('settings');

  mod.setupBackgroundSync();
  await waitForSetup(handles);
  assert.equal(handles.alarmListeners.length, 1, 'handleAlarm 必须注册（本文件的断言都靠它）');
  alarmListener = handles.alarmListeners[0];
});

const SYNC_ALARM_EVENT = { name: 'tapstack-background-sync' } as chrome.alarms.Alarm;

beforeEach(() => {
  delete handles.mockStore[BACKOFF_STATE_KEY];
});

describe('未配置/未解锁云盘 = 让路（不推进退避；不清 alarm）', () => {
  it('runBackgroundSyncOnce ⇒ true（outcome.ok = true，kind = yielded）', async () => {
    const { runBackgroundSyncOnce } = await import('@/background/backgroundSync');

    const result = await runBackgroundSyncOnce();

    // [V1-FLIP → Wave 2A] 原断言为 false（failed + 进退避）。让路语义落地后：
    // 未配置/未解锁是正常用户状态 ⇒ { ok:true, kind:'yielded', locked:true }。
    assert.equal(
      result,
      true,
      '未配置/未解锁云盘是正常用户状态，必须让路（ok:true）而不是 failed'
    );

    // runBackgroundSyncOnce 是「手动触发/调试」路径：按设计**不记账退避**。
    // （handleAlarm 路径的「不记账」由下面两条用例断言。）
    assert.equal(
      handles.mockStore[BACKOFF_STATE_KEY],
      undefined,
      'runBackgroundSyncOnce 不推进退避（退避只在 handleAlarm 路径记账）'
    );
  });

  it('handleAlarm 触发一轮 ⇒ 不进退避、不清 alarm、按用户档位（10 分钟）重排', async () => {
    const createsBefore = handles.createCalls.length;
    const clearedBefore = clearedSyncAlarms();

    await alarmListener(SYNC_ALARM_EVENT);

    // [V1-FLIP → Wave 2A] 原断言 consecutiveFailures === 1 且 lastFailureReason
    // 匹配 /自动下载未成功/（那是 failed 分支的记账证据）。让路语义下必须反过来：
    // 不记账（recordSyncSuccess 复位后键被删除）且绝不允许失败原因落盘。
    const state = handles.mockStore[BACKOFF_STATE_KEY] as
      | { consecutiveFailures: number; lastFailureReason?: string }
      | undefined;
    assert.equal(
      state,
      undefined,
      '未配置/未解锁不得记账失败（没有记录 = 让路而非失败）'
    );

    assert.ok(
      handles.createCalls.length > createsBefore,
      '让路后必须保持 alarm 活着（否则用户配置好也没有任何自动路径救回来）'
    );
    assert.equal(
      handles.createCalls.at(-1)?.opts.delayInMinutes,
      10,
      '让路必须按用户档位（10 分钟）重排，而不是 1 分钟的退避档'
    );
    assert.equal(
      clearedSyncAlarms(),
      clearedBefore,
      '让路不得清 SYNC_ALARM'
    );
  });

  it('已预置 7 次失败时触发一轮 ⇒ 仍不清 alarm、不把计数推到 8（旧「静默停摆」不再可达）', async () => {
    // 预置「已连续失败 7 次且退避窗口已过」，本轮触发即第 8 次。
    handles.mockStore[BACKOFF_STATE_KEY] = {
      consecutiveFailures: 7,
      nextAllowedAt: 0,
      lastFailureReason: '自动下载未成功: (前置轮次)',
    };
    const createsBefore = handles.createCalls.length;
    const clearedBefore = clearedSyncAlarms();

    await alarmListener(SYNC_ALARM_EVENT);

    // [V1-FLIP → Wave 2A] 原断言 consecutiveFailures === 8 且 SYNC_ALARM 被 clear
    // （那正是「设置页宣称每 10 分钟同步、实际已停摆」的旧机制）。
    // 让路语义下：未配置不推进计数 ⇒ 永远到不了 8；同时复位可残留的旧计数
    // （本轮根本没碰网络，留着旧计数只会在用户解锁后提前触发上限）。
    assert.equal(
      handles.mockStore[BACKOFF_STATE_KEY],
      undefined,
      '未配置/未解锁不得把计数推到 MAX_CONSECUTIVE_FAILURES(8)'
    );
    assert.equal(
      clearedSyncAlarms(),
      clearedBefore,
      '不得清 SYNC_ALARM（自动同步必须继续活着）'
    );
    assert.ok(
      handles.createCalls.length > createsBefore,
      '按用户档位把 alarm 排下去（不是停摆）'
    );
    assert.equal(
      handles.createCalls.at(-1)?.opts.delayInMinutes,
      10,
      'delay = 用户档位 10 分钟'
    );
  });
});
