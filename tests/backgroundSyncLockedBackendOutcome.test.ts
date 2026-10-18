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
type NotificationCall = { id?: string; options: { title?: string; message?: string } };

function installChromeMock(seedSettings: Record<string, unknown> | null = null) {
  const createCalls: CreateCall[] = [];
  const clearedAlarms: string[] = [];
  const alarmListeners: Array<(alarm: chrome.alarms.Alarm) => void> = [];
  // 2026-10-17：通知记录。notifyLockedBackendOnce 需要 chrome.notifications.create
  // 才不发早退（它「API 不可用 ⇒ 静默返回且不置标志」是刻意设计）。
  // 没有这个 mock，通知链路根本无法被测试 —— 那正是它此前零覆盖的原因。
  const notificationCalls: NotificationCall[] = [];
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
    runtime: {
      getManifest: () => ({ version: 'test' }),
      // notifyLockedBackendOnce 用 runtime.getURL('icons/icon128.png') 作图标。
      getURL: (p: string) => `chrome-extension://test/${p}`,
    },
    // 通知：只记录调用，不模拟渲染。传 id 时按 Chrome 语义「同 id 覆盖」，
    // 但本文件断的是**调用次数**（一次性语义），不依赖 id 去重行为。
    notifications: {
      create(idOrOptions: string | NotificationCall['options'], maybeOptions?: NotificationCall['options']) {
        const options = (typeof idOrOptions === 'string' ? maybeOptions : idOrOptions) ?? {};
        notificationCalls.push({
          id: typeof idOrOptions === 'string' ? idOrOptions : undefined,
          options,
        });
        return Promise.resolve(typeof idOrOptions === 'string' ? idOrOptions : 'generated-id');
      },
    },
  };
  return { createCalls, clearedAlarms, alarmListeners, mockStore, notificationCalls };
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
  // syncBackend:'webdav' 是本文件的**被测前提**，不是绕过门禁的手段。
  handles = installChromeMock({
    syncEnabled: true,
    syncIntervalMinutes: 10,
    syncBackend: 'webdav',
    // 2026-10-18 P2-5：锁定提醒是 info 性质，**受「显示通知提醒」开关约束**
    // （与 TabManager.showNotification 同一分流策略）。默认设置里该开关是
    // false，所以本文件必须显式打开，否则通知不发 —— 而那正是修好之后的
    // 正确行为。「开关关掉 ⇒ 不发」另有对应用例在下方。
    showNotifications: true,
  });

  // ── 2026-10-17：本文件**故意不种任何 Supabase session** ─────────────────
  // 这是核心前提，不是遗漏。自带存储用户没有 TapStack 账号，真机上
  // supabaseAuth.getSession() 恒空 —— 若测试必须先伪造 session 才能走到
  // 锁定后端，那它测的就是一个现实中不存在的场景（「已登录用户配了 WebDAV」）。
  //
  // 历史：本文件此前在此处写 `mockStore['sb-stub-auth-token'] = stubSessionJson(...)`
  // 并 monkey-patch 全局 fetch 去 mock `/auth/v1/user`，还配了一大段「三次踩坑」
  // 注释讲解如何骗过门禁。那正是这套假绿的根源：它把
  //   「performBackgroundSync 第 1 步无条件 getCurrentUser ⇒ not_logged_in」
  // 这件**缺陷**当成了测试环境限制来解释，于是缺陷被测试注释合法化了。
  // 2026-10-17 已在 backgroundSync 按 backendId 分流（webdav 跳过登录门禁），
  // 零 session 下可直达锁定后端 —— 因此这里不再需要任何伪造。
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

/** 与 backgroundSync 的 LOCKED_BACKEND_NOTICE_KEY 同值（一次性提醒的去重标志）。 */
const LOCKED_NOTICE_KEY = 'background_sync_locked_notice_shown';

beforeEach(() => {
  delete handles.mockStore[BACKOFF_STATE_KEY];
  // 一次性提醒标志必须逐用例复位：它是「同一锁定季只提醒一次」的去重依据，
  // 跨用例残留会让后续用例看到「已提醒过」而一次通知都不发（假绿的反面：
  // 断言 0 条通知也能过）。这是状态型断言必须显式复位的原因。
  delete handles.mockStore[LOCKED_NOTICE_KEY];
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

// ─────────────────────────────────────────────────────────────────────────
// 一次性可见提醒（2026-10-17 补）
//
// 【为什么单独一组】此前这条链路**零覆盖**：把 handleAlarm 里的
// `await notifyLockedBackendOnce()` 整行删掉，全量 1369 条测试仍然全绿。
// 而它正是 B1 要修的核心之一 —— 修复前只有 logWarn，用户零感知；
// 设置页却宣称「每 N 分钟后台同步一次」，实际静默停摆。
//
// 【一次性语义为什么重要】每 10 分钟弹一条「请配置云盘」是骚扰，用户会
// 直接关掉整个扩展的通知权限，反而让真正的失败提醒也被关掉。所以
// 同一锁定季只提醒一次，跑通一轮（kind='done'）后才清标志、允许下一季再提醒。
// ─────────────────────────────────────────────────────────────────────────
describe('锁定态：一次性可见提醒', () => {
  it('锁定让路 ⇒ 发一条通知；第二轮不再发（一次性）', async () => {
    // 通知记录跨用例共享（同一份 chrome mock），所以断**增量**而不是绝对数。
    // 注意：本组必须排在锁定让路用例之后运行才符合真实顺序；但即使单独跑，
    // 增量断言同样成立（基数为 0）。
    const before = handles.notificationCalls.length;

    // 第一轮：未配置云盘 ⇒ 锁定 ⇒ 让路 + 提醒
    await alarmListener(SYNC_ALARM_EVENT);
    assert.equal(
      handles.notificationCalls.length - before,
      1,
      '锁定让路必须发**恰好一条**通知：用户此前零感知，而设置页在承诺自动同步'
    );
    const sent = handles.notificationCalls.at(-1);
    assert.match(
      sent?.options.title ?? '',
      /TapStack/,
      '通知标题要能让用户认出是哪个扩展'
    );
    assert.match(
      sent?.options.message ?? '',
      /配置|解锁/,
      '正文要告诉用户下一步做什么（配置或解锁），不能只说「同步失败」'
    );

    // 第二轮：仍是锁定态 ⇒ 不得再发（一次性）
    await alarmListener(SYNC_ALARM_EVENT);
    assert.equal(
      handles.notificationCalls.length - before,
      1,
      '同一锁定季只提醒一次：重复弹窗会让用户关掉整个扩展的通知权限，' +
        '连带把真正的失败提醒一起关掉'
    );
  });

  it('连续多轮锁定只发一次（标志不被保护性让路误清）', async () => {
    const before = handles.notificationCalls.length;
    await alarmListener(SYNC_ALARM_EVENT);
    const afterFirst = handles.notificationCalls.length - before;

    // ── 前提断言（2026-10-17 QA 复验抓到的假绿）────────────────────────
    // 没有这一句时，若通知链路整个坏掉（notifyLockedBackendOnce 未被调用），
    // afterFirst 会是 0，下面的「不增」就退化成 assert.equal(0, 0) —— 恒真。
    // 即：这条用例会替一条根本不发通知的实现作证。断言「0 不增」之前，
    // 必须先证明「第一轮真的发过」。
    assert.equal(
      afterFirst,
      1,
      '前提：第一轮必须真的发了通知，否则下面的「不增」是恒真断言（假绿）'
    );

    // 连续多轮锁定：标志一直在，通知数不增
    await alarmListener(SYNC_ALARM_EVENT);
    await alarmListener(SYNC_ALARM_EVENT);
    assert.equal(
      handles.notificationCalls.length - before,
      afterFirst,
      '连续多轮锁定只发一次：标志不得被保护性让路（already_syncing 等）误清'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// P2-5：锁定提醒受「显示通知提醒」开关约束
//
// 修复前 `notifyLockedBackendOnce` 直接 chrome.notifications.create，
// 绕过开关 —— 用户在设置里关掉通知后，每 10 分钟仍会收到这一条。
// 唯一能做的反应是关掉整个扩展的通知权限，连带把真正的失败提醒也关掉。
//
// 判别力：把开关关掉后必须**一条都不发**。若实现不读开关（修复前），
// 本用例会红。
// ─────────────────────────────────────────────────────────────────────────
describe('P2-5：通知开关关闭时不发锁定提醒', () => {
  it('showNotifications=false ⇒ 锁定让路也不发通知', async () => {
    // 前置：先证明「开着的时候确实会发」，否则本用例会因为「它压根不发」
    // 而恒绿 —— 那正是恒真断言的形状。
    const before = handles.notificationCalls.length;

    // 模拟「用户在另一个窗口关掉了通知开关」：直接改种子写进的那份 settings。
    const { storage } = await import('@/utils/storage');
    const current = await storage.getSettings();
    await storage.setSettings({ ...current, showNotifications: false });
    // getSettings 有 60s 进程内缓存，绕开它，让下一次读取看到新值。
    const { cacheManager } = await import('@/utils/performance');
    cacheManager.getCache('storage').delete('settings');

    try {
      await alarmListener(SYNC_ALARM_EVENT);
      assert.equal(
        handles.notificationCalls.length - before,
        0,
        '通知开关关闭时不得发送锁定提醒 —— 否则用户会直接关掉整个扩展的通知权限'
      );
    } finally {
      // 复位：后续用例不得受这条影响
      await storage.setSettings({ ...current, showNotifications: true });
      cacheManager.getCache('storage').delete('settings');
    }
  });
});
