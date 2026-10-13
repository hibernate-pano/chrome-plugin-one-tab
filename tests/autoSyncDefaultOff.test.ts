// 1.23.0 回归：自动同步默认关闭 + 用户四档间隔（5/10/30/60 分钟）。
//
// ── 产品拍板（2026-10-11）──────────────────────────────────────────────────
// 自动同步每轮都是出站流量（Supabase egress 配额），60s 全量轮询是配额见底的主因：
//   · 默认关闭：后台 alarm 不注册、打开 popup 不自动拉取，点「同步」手动获取；
//   · 用户在菜单中开启后四选一：5/10/30/60 分钟（默认 10）；
//   · 本地改动的上传保持事件驱动，不受本开关影响（关掉上传省不下什么，
//     反而把编辑困在本机且无声）。
//
// ── 本文件钉住的行为契约 ─────────────────────────────────────────────────
//  A. 默认关：空存储下 setupBackgroundSync 不得创建 alarm（还要清掉可能的孤儿 alarm）
//  B. 开 + 档位：settings.syncEnabled=true 时按 syncIntervalMinutes 建周期 alarm
//  C. alarm 触发时开关已被关 → 本轮自杀（清 alarm、不跑管线）
//  D. 档位校验：非法值回落 10（fail-safe），合法四档原样通过
//  E. 旧契约更新：periodInMinutes = 用户档位（不再是写死的 1）
//  F. 默认设置：DEFAULT_SETTINGS.syncEnabled=false、interval=10；存量用户保留 true
//
// ── 判据纪律（为什么每条都要反向）───────────────────────────────────────
// 「关时不建 alarm」这条没有反向对照的话，把 alarm 恒建出来的实现也能过 A
// （只要 A 只断「空存储下没建」——不对，恒建会挂 A。但「读不到配置时按开处理」
// 的 fail-open 实现需要 E2 与 A 一起才锁得住）。档位校验同理：只测回落不测通过，
// 「恒返回 10」的实现也能全绿 —— 那等于把四档功能整个废掉。
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
before(async () => {
  register(LOADER_PATH);
});

// ── chrome mock（alarm 记录 + storage.local 可注入设置）───────────────────
type CreateCall = { name: string; opts: chrome.alarms.AlarmCreateInfo };

function installChromeMock(seedSettings: Record<string, unknown> | null = null) {
  const createCalls: CreateCall[] = [];
  const clearedAlarms: string[] = [];
  const alarmListeners: Array<(alarm: chrome.alarms.Alarm) => void> = [];
  const mockStore: Record<string, unknown> = {};
  if (seedSettings) mockStore['user_settings'] = seedSettings;
  // storageAdapter 在无 indexedDB 的 node 环境回退到 window.localStorage；
  // readAutoSyncConfig 经 storage.getSettings 读的是这条链，不是 chrome.storage.local。
  // 所以设置种子要种进 localStorage 桩（与 concededPrecheckDegrade.test.ts 同模式）。
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
  if (seedSettings) {
    lsData.set('user_settings', JSON.stringify(seedSettings));
  }
  // settings 有 60s 进程内缓存（cachedAsyncFn('storage','settings')）。
  // 同一测试文件里多个用例各换一份种子，若不逐用例清缓存，后一个用例会读到
  // **前一个**的种子 —— 表现为「档位用例串味」（用 30 的种子跑出 10 的结果），
  // 读起来像实现有 bug，其实是缓存没隔离。逐用例清一次，测试彼此独立。
  // 与 tests/settingsReadScoping.test.ts 的 beforeEach 同思路（那里清的是 groups 键）。

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
          if (typeof keys === 'string') {
            out[keys] = mockStore[keys] ?? undefined;
          } else if (Array.isArray(keys)) {
            for (const k of keys) out[k] = mockStore[k] ?? undefined;
          } else {
            for (const k of Object.keys(keys)) out[k] = mockStore[k] ?? undefined;
          }
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
    runtime: { getManifest: () => ({ version: '1.23.0-test' }) },
  };
  return {
    createCalls,
    clearedAlarms,
    alarmListeners,
    mockStore,
    /**
     * 在「另一个执行上下文」（模拟 popup）改盘 —— SW 进程的 60s 缓存毫不知情。
     * F 段用它复现「用户点关闭但 SW 关不掉」那个审查缺陷。
     */
    setStoredSettings(next: Record<string, unknown> | null) {
      if (next === null) lsData.delete('user_settings');
      else lsData.set('user_settings', JSON.stringify(next));
    },
  };
}

/**
 * 清掉 settings 的进程内缓存（60s TTL，见 cachedAsyncFn('storage','settings')）。
 *
 * 【为什么逐用例必须清】同一测试文件里多个用例各换一份设置种子，
 * 而 getSettings 走 cachedAsyncFn 的 60s 缓存 —— 不清的话后一个用例会读到
 * **前一个**用例的种子，表现为「档位用例串味」（用 30 的种子跑出 10 的结果）。
 * 读起来像实现有 bug，其实是缓存没隔离（与 settingsReadScoping.test.ts 同思路）。
 *
 * 【一个被证伪的猜测，留档免得重犯】调试时我一度怀疑 Redux 单例里的 settings
 * 才是污染源（loadSettings.fulfilled 会写它）。写探针跑了两条连续用例验证：
 * 「先空存储(关) → 再开+5分钟」在**只清缓存**的情况下本来就正常。
 * 真正的病灶是 B 段循环里漏了一行 invalidateSettingsCache —— 即我批量替换
 * 脚本没覆盖到那个调用点。教训：先写探针复现再改，别用「看起来应该对」的
 * 猜测当根因（与 1.22.17 审查时「先证最省事方案不够」的同一条纪律）。
 */
async function invalidateSettingsCache(): Promise<void> {
  const { cacheManager } = await import('@/utils/performance');
  cacheManager.getCache('storage').delete('settings');

}

/**
 * 等 setupBackgroundSync 内部的异步段跑完。
 *
 * 【为什么必须轮询而不是固定 sleep(20)】首次调用要真走一遍 storage 冷读
 * （kvGet → 迁移扫描 → 缓存回填），实测冷读耗时超过 20ms，固定 sleep 会让
 * 「还没建 alarm」与「不该建 alarm」分不清 —— 那正是我用 20ms 时踩到的假红：
 * A 段空存储用例与 B 段开启用例一起变红，读起来像实现坏了。
 * 轮询等待条件而非时间，测试就不再依赖机器快慢（与本仓 pgHarness 同一思路）。
 */
async function waitForSetup(handles: { createCalls: unknown[]; clearedAlarms: unknown[] }): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    // 关闭分支会 clear 一次，开启分支会 create 一次；任一发生即视为异步段已跑完。
    if (handles.createCalls.length > 0 || handles.clearedAlarms.length > 0) return;
    await new Promise(r => setTimeout(r, 5));
  }
}

describe('A. 默认关闭：空存储下不建 alarm，且清掉孤儿 alarm', () => {
  beforeEach(() => {});

  it('空存储（新用户/键缺失）→ 不创建任何 alarm，并 clear 一次', async () => {
    const handles = installChromeMock(null);
    const { createCalls, clearedAlarms } = handles;
    const { setupBackgroundSync } = await import('@/background/backgroundSync');

    await invalidateSettingsCache();
    setupBackgroundSync();
    await waitForSetup(handles);

    assert.equal(createCalls.length, 0, `空存储下不应创建 alarm（实得 ${JSON.stringify(createCalls)}）`);
    assert.ok(clearedAlarms.includes('tapstack-background-sync'),
      `必须清掉可能残留的孤儿 alarm（实得 ${JSON.stringify(clearedAlarms)}）`);
  });

  it('settings.syncEnabled=false（用户显式关）→ 同样不建 alarm', async () => {
    const handles = installChromeMock({ syncEnabled: false, syncIntervalMinutes: 30 });
    const { createCalls } = handles;
    const { setupBackgroundSync } = await import('@/background/backgroundSync');

    await invalidateSettingsCache();
    setupBackgroundSync();
    await waitForSetup(handles);

    assert.equal(createCalls.length, 0, '用户显式关闭时不得创建 alarm');
  });
});

describe('B. 开启 + 四档：按用户档位建周期 alarm', () => {
  const CASES: Array<[number, string]> = [
    [5, '5分钟'],
    [10, '10分钟'],
    [30, '30分钟'],
    [60, '1小时'],
  ];
  for (const [minutes, label] of CASES) {
    it(`syncEnabled=true + ${label} → periodInMinutes=${minutes}`, async () => {
      const handles = installChromeMock({ syncEnabled: true, syncIntervalMinutes: minutes });
      const { createCalls } = handles;
      const { setupBackgroundSync, SYNC_ALARM } = await import('@/background/backgroundSync');

      await invalidateSettingsCache();
      setupBackgroundSync();
      await waitForSetup(handles);

      assert.equal(createCalls.length, 1, '必须恰好创建一个 alarm');
      assert.equal(createCalls[0].name, SYNC_ALARM);
      assert.equal(createCalls[0].opts.periodInMinutes, minutes,
        `周期必须等于用户档位 ${minutes}（E 旧契约：不再是写死的 1）`);
      assert.equal(createCalls[0].opts.delayInMinutes, minutes, '首次触发按同档位排');
    });
  }

  it('开启但档位字段缺失 → 回落默认 10 分钟（fail-safe，不炸）', async () => {
    const handles = installChromeMock({ syncEnabled: true });
    const { createCalls } = handles;
    const { setupBackgroundSync } = await import('@/background/backgroundSync');

    await invalidateSettingsCache();
    setupBackgroundSync();
    await waitForSetup(handles);

    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0].opts.periodInMinutes, 10);
  });
});

describe('C. alarm 触发时开关已被关 → 自杀（清 alarm、不跑管线）', () => {
  it('关状态下触发 alarm：清掉 alarm，且不把退避往前推（= 没跑管线）', async () => {
    // 【这一段被变异验证推翻重写过一次，留档免得重犯】
    // 第一版：installChromeMock 重挂 globalThis.chrome 后取 alarmListeners[0] 派发，
    // 断言「clear 被调」。实测把 handleAlarm 里「关则自杀」整段删掉，测试**照样全绿**。
    // 根因不是断言不够强，而是**测的不是生产代码**：
    //   · setupBackgroundSync 在模块首次加载时就 addListener 过；
    //   · 后续用例 installChromeMock 重挂 chrome，早先注册的 listener 闭包里
    //     仍是**第一次那个 mock 的 chrome** —— 派发事件时被清的是那个旧 mock 的
    //     clear，不是当前 handles 的。断言 handles.clearedAlarms 只是在自己骗自己。
    // 判别式：当断言的观测量与被测代码不在同一个对象上时，绿是必然的，与实现无关。
    //
    // 修法：整个文件**只装一次 chrome mock**（真实 alarm 回调由 setup 捕获），
    // 每个用例只换「设置种子」。这样 listener 与被断言的 mock 恒为同一个对象。
    const handles = installChromeMock({ syncEnabled: false });
    const mod = await import('@/background/backgroundSync');
    const { BACKOFF_STATE_KEY } = await import('@/background/syncBackoff');

    await invalidateSettingsCache();
    mod.setupBackgroundSync();
    await waitForSetup(handles);

    // listener 必须是**本次**安装的（断言 addListener 只增一次，指向同一闭包）
    const before = handles.clearedAlarms.length;
    assert.equal(handles.alarmListeners.length, 1, 'listener 必须已注册（开启路径经 resyncAlarm 重建时要用）');

    await handles.alarmListeners[0]({ name: 'tapstack-background-sync' } as chrome.alarms.Alarm);

    assert.ok(
      handles.clearedAlarms.length > before,
      '关状态下触发必须清掉 alarm（自愈，之后零唤醒）'
    );
    // 变异 C 的真正防线：关 = 稳态不是故障 ⇒ 不得推进退避阶梯。
    // 若「关则自杀」被删而管线跑起来，未登录会让 performBackgroundSync 返回
    // not_logged_in（ok:true，不计退避）——所以再补一条结构断言钉住门禁本身。
    const backoff = handles.mockStore[BACKOFF_STATE_KEY];
    assert.equal(backoff, undefined,
      `关状态下不得推进退避（实得 ${JSON.stringify(backoff)}）`);
  });

  it('结构层：handleAlarm 必须有「关则自杀」的第一道门禁', async () => {
    // 行为断言（上面那条）在「未登录」这个 fixture 下与「管线跑了但没失败」同形，
    // 断不出差异。结构断言直接钉住门禁代码在场 —— 与 P0 的 getData 断言同手法。
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath: f2p } = await import('node:url');
    const { dirname: dn, resolve: rs } = await import('node:path');
    const here = dn(f2p(import.meta.url));
    const src = readFileSync(rs(here, '../src/background/backgroundSync.ts'), 'utf8');
    const body = src.slice(src.indexOf('async function handleAlarm'));
    assert.match(body, /if \(!cfg\.enabled\)/,
      'handleAlarm 必须先问总开关（变异：删掉整段 early-return）');
    assert.match(body, /alarms\.clear\(SYNC_ALARM\)/,
      '关状态必须清 alarm（自愈，否则关开关前排的那一次还会白醒一次）');
    // 开关判据必须在退避判据之前：反了的话，一次失败留下的退避状态会让
    // 关掉的开关「看起来还在生效」（跳过原因变成退避而不是关闭），排障会跑偏。
    assert.ok(body.indexOf('!cfg.enabled') < body.indexOf('shouldSkipDueToBackoff'),
      '总开关门禁必须排在退避门禁之前');
  });
});

describe('D. 档位校验：非法回落、合法通过（单点在 storage 层）', () => {
  it('非法值（1/7/999/字符串/undefined）→ 全部回落 10', async () => {
    const { validateSyncIntervalMinutes } = await import('@/utils/storage');
    for (const bad of [1, 7, 999, '30', undefined, null]) {
      assert.equal(validateSyncIntervalMinutes(bad), 10, `非法值 ${String(bad)} 必须回落 10`);
    }
  });

  it('合法四档原样通过（没有这条，「恒返回10」的实现也能全绿）', async () => {
    const { validateSyncIntervalMinutes, SYNC_INTERVAL_CHOICES } = await import('@/utils/storage');
    assert.deepEqual([...SYNC_INTERVAL_CHOICES], [5, 10, 30, 60]);
    for (const good of SYNC_INTERVAL_CHOICES) {
      assert.equal(validateSyncIntervalMinutes(good), good, `合法档位 ${good} 不得被改写`);
    }
  });

  it('DEFAULT_SETTINGS：syncEnabled=false、interval=10（F 契约）', async () => {
    const { DEFAULT_SETTINGS } = await import('@/utils/storage');
    assert.equal(DEFAULT_SETTINGS.syncEnabled, false, '自动同步必须默认关闭');
    assert.equal(DEFAULT_SETTINGS.syncIntervalMinutes, 10);
  });

  it('存量用户保留 syncEnabled=true（不得被默认值翻转）', async () => {
    const handles = installChromeMock({ syncEnabled: true, syncIntervalMinutes: 60 });
    const { createCalls } = handles;
    const { setupBackgroundSync } = await import('@/background/backgroundSync');

    await invalidateSettingsCache();
    setupBackgroundSync();
    await waitForSetup(handles);

    assert.equal(createCalls.length, 1, '存量开启用户必须照常工作（静默翻转=1.22.16 修的那类 bug）');
    assert.equal(createCalls[0].opts.periodInMinutes, 60);
  });
});

describe('E. resyncAlarm / 原因码导出（SW 与 popup 的握手面）', () => {
  it('RESYNC_ALARM_OP 与 AUTO_SYNC_DISABLED_REASON 可导入且值稳定', async () => {
    const { RESYNC_ALARM_OP, AUTO_SYNC_DISABLED_REASON, SYNC_ALARM } = await import('@/background/backgroundSync');
    assert.equal(RESYNC_ALARM_OP, 'resyncAlarm');
    assert.equal(AUTO_SYNC_DISABLED_REASON, 'auto_sync_disabled');
    assert.equal(SYNC_ALARM, 'tapstack-background-sync');
  });

  it('结构层：SW 门禁只看 auto 位，resyncAlarm 在 SYNC 分支早于 enqueue 处理', async () => {
    const { readFileSync } = await import('node:fs');
    const here = dirname(fileURLToPath(import.meta.url));
    const sw = readFileSync(resolve(here, '../src/service-worker.ts'), 'utf8');
    // resyncAlarm 必须在 SYNC 分支内、且不进队列（scheduleUpload 同模式）
    assert.match(sw, /data\.op === 'resyncAlarm'/, 'SW 必须处理 resyncAlarm');
    const resyncBlock = sw.slice(sw.indexOf("data.op === 'resyncAlarm'"));
    const syncCaseStart = sw.lastIndexOf("case 'SYNC':", sw.indexOf("data.op === 'resyncAlarm'"));
    const syncCaseEnd = sw.indexOf("default:", syncCaseStart);
    const inSyncCase = resyncBlock.length < syncCaseEnd - syncCaseStart;
    assert.ok(inSyncCase, 'resyncAlarm 必须在 SYNC case 内处理');
    // auto 门禁必须复用 readAutoSyncConfig（单点判据）
    const gate = sw.slice(sw.indexOf('data.auto === true'), sw.indexOf('runSyncOp'));
    assert.match(gate, /readAutoSyncConfig/, '自动下载门禁必须复用 readAutoSyncConfig');
    // ── 变异 D 的防线（第一版缺这条，实测把 `if (!cfg.enabled)` 改成 if (false && …)
    //    测试照样全绿：只查「有没有调 readAutoSyncConfig」判不出「判据还在不在」）──
    // 必须真的回一个「因关闭而跳过」的原因码，而不是放行进队列。
    assert.match(gate, /if \(!cfg\.enabled\)/,
      '门禁必须在关闭时真的 early-return（变异：if (false && !cfg.enabled)）');
    assert.match(gate, /AUTO_SYNC_DISABLED_REASON/,
      '关闭时必须回 auto_sync_disabled（AuthProvider 据此静默，不当故障报）');
    // 放行后必须走同一条 runSyncOp（不复制第二份 enqueue）。
    // 取「门禁所在 if 块」到 SYNC case 结尾的整段，而不是切到 runSyncOp 定义处 ——
    // 定义在调用点之前，切错边界会拿不到这行（实测踩过）。
    const gateStart = sw.indexOf("if (data.op === 'download' && data.auto === true)");
    const caseEnd = sw.indexOf("default:", sw.lastIndexOf("case 'SYNC':", gateStart));
    const gateBody = sw.slice(gateStart, caseEnd);
    assert.match(gateBody, /runSyncOp\(\)/, '放行后必须走同一条入队路径');
    // 反向：门禁块内不得自己 enqueue（复制第二条入队路径 = 两份真相）
    const gateBlockEnd = gateBody.indexOf('return true;');
    const gateBlock = gateBody.slice(0, gateBlockEnd === -1 ? gateBody.length : gateBlockEnd);
    assert.doesNotMatch(gateBlock, /enqueue\(/, '门禁块内不得复制 enqueue（改一条漏一条）');
  });

  it('结构层：HeaderDropdown 必须发 resyncAlarm 通知 SW（popup 不能自己碰 alarms）', async () => {
    const { readFileSync } = await import('node:fs');
    const here = dirname(fileURLToPath(import.meta.url));
    const ui = readFileSync(resolve(here, '../src/components/layout/HeaderDropdown.tsx'), 'utf8');
    assert.match(ui, /sendSyncCommand\('resyncAlarm'\)/, '开关/档位变化必须通知 SW 重建 alarm');
    assert.match(ui, /SYNC_INTERVAL_CHOICES/, '档位选项必须引用 storage 单点，不得手抄 [5,10,30,60]');
  });
});

describe('F. 缓存旁路：popup 改设置后 SW 必须立即看到（2026-10-11 审查 P1）', () => {
  it('popup 落盘后立即再读，读到的是【新值】而不是 60s 进程内缓存', async () => {
    // 【这条是审查发现的真缺陷，已实证】修复前 readAutoSyncConfig 走
    // store.dispatch(loadSettings()) → getSettings → cachedAsyncFn('storage','settings')
    // = **60 秒进程内缓存**。popup 与 SW 是两个执行上下文、各有独立 cacheManager，
    // 于是「用户点关闭 → popup 发 resyncAlarm → SW 重建 alarm」这条链上，
    // SW 读到的还是自己那份旧缓存（enabled:true）⇒ **关不掉**，最长 60 秒内
    // 用户显式关掉的意图完全无效，后台继续出流量。
    //
    // 探针实证（改盘后立刻再读）：修复前拿到 enabled:true；修复后拿到 false。
    const handles = installChromeMock({ syncEnabled: true, syncIntervalMinutes: 10 });
    const { readAutoSyncConfig } = await import('@/background/backgroundSync');

    const first = await readAutoSyncConfig();
    assert.equal(first.enabled, true, '前置条件：开关处于开启状态');

    // 模拟 popup 在**另一个执行上下文**改盘（SW 进程的缓存毫不知情）
    handles.setStoredSettings({ syncEnabled: false, syncIntervalMinutes: 10 });

    const second = await readAutoSyncConfig();
    assert.equal(second.enabled, false,
      '❌ 读到 60s 旧缓存 → 用户点了「关闭」但后台仍按开启跑，最长 60 秒内关不掉');

    // 反向：档位也要立即可见（否则「选了 1 小时、实际还按 5 分钟跑」）
    handles.setStoredSettings({ syncEnabled: true, syncIntervalMinutes: 60 });
    const third = await readAutoSyncConfig();
    assert.equal(third.intervalMinutes, 60, '档位变更必须立即可见，不得被缓存遮蔽');
  });

  it('结构层：readAutoSyncConfig 不得经由 loadSettings（那是带 60s 缓存的入口）', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath: f2p } = await import('node:url');
    const { dirname: dn, resolve: rs } = await import('node:path');
    const here = dn(f2p(import.meta.url));
    const src = readFileSync(rs(here, '../src/background/backgroundSync.ts'), 'utf8');
    const start = src.indexOf('export async function readAutoSyncConfig');
    assert.ok(start !== -1, '应能找到 readAutoSyncConfig');
    // 只取代码行（去掉注释）：函数体的注释里正解释着「为什么不能走 loadSettings」，
    // 不断言注释的话这条守卫会被自己的说明文字误判为红（实测踩过）。
    const raw = src.slice(start, src.indexOf('\n}', start));
    const body = raw.split('\n').filter(l => {
      const t = l.trim();
      return !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('//');
    }).join('\n');
    assert.doesNotMatch(body, /loadSettings/,
      'readAutoSyncConfig 不得走 loadSettings（60s 缓存 ⇒ 关不掉开关）');
    assert.match(body, /kvGet/,
      '必须直接读盘（当前真实配置），而不是本进程 60s 前见过什么');
  });

  it('读配置失败时按「关闭」处理（fail-closed），不得撤销用户显式关掉的意图', async () => {
    // 方向论证写在 readAutoSyncConfig 的注释里：撤销用户意图比多跑一轮更糟。
    // 保护「关」不需要理由（它是默认值），保护「开」才是错的方向。
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath: f2p } = await import('node:url');
    const { dirname: dn, resolve: rs } = await import('node:path');
    const here = dn(f2p(import.meta.url));
    const src = readFileSync(rs(here, '../src/background/backgroundSync.ts'), 'utf8');
    const start = src.indexOf('export async function readAutoSyncConfig');
    const rawBody = src.slice(start, src.indexOf('\n}', start));
    const body = rawBody.split('\n').filter(l => {
      const t = l.trim();
      return !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('//');
    }).join('\n');
    const catchBody = body.slice(body.indexOf('catch'));
    assert.match(catchBody, /enabled: false/,
      '读失败必须按「关闭」处理：撤销用户「关掉自动同步」的显式意图比多跑一轮更糟');
    assert.match(catchBody, /logError/,
      '读失败必须出声（logError 而非 warn）：否则「我开了却不动」无从排查');
  });
});

describe('G. 保存失败必须让 UI 收敛到磁盘真值（2026-10-11 审查 P1）', () => {
  it('结构层：两个 handler 都必须在失败分支回滚 reducer + 说清当前状态', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath: f2p } = await import('node:url');
    const { dirname: dn, resolve: rs } = await import('node:path');
    const here = dn(f2p(import.meta.url));
    const ui = readFileSync(rs(here, '../src/components/layout/HeaderDropdown.tsx'), 'utf8');

    const grab = (name: string) => {
      const start = ui.indexOf(`const ${name}`);
      assert.ok(start !== -1, `应能找到 ${name}`);
      return ui.slice(start, ui.indexOf('\n  };', start));
    };

    // 开关：保存失败 → 回滚 + 明确告知「恢复为 X」
    const toggle = grab('handleToggleAutoSync');
    const toggleFail = toggle.slice(toggle.indexOf('if (saveError)'));
    assert.match(toggleFail, /dispatch\(setSyncEnabled\(settings\.syncEnabled\)\)/,
      '开关保存失败必须回滚 Redux（否则显示「已关闭」而 alarm 仍按开启跑）');
    assert.match(toggleFail, /已恢复为/,
      'toast 必须说清「恢复成什么状态」——只说「保存失败」等于让用户自己猜开关生效没有');

    // 档位：同理（显示 30 分钟、实际 5 分钟 = 谎报）
    const interval = grab('handleSetSyncInterval');
    const intervalFail = interval.slice(interval.indexOf('if (saveError)'));
    assert.match(intervalFail, /dispatch\(setSyncIntervalMinutes\(settings\.syncIntervalMinutes\)\)/,
      '档位保存失败必须回滚 Redux');
    assert.match(intervalFail, /已恢复为/, 'toast 必须说清恢复后的档位');
  });
});

// ── 2026-10-12 P1：读失败 ≠ 用户关闭，两者收尾动作相反 ──────────────────────
//
// 修复前 readAutoSyncConfig 的返回类型只有 `{enabled:false}`，而 false 有两种含义：
//   (a) 设置里明确写着 syncEnabled !== true  → 用户真的关了 → 该**清 alarm**
//   (b) kvGet 抛错（死句柄看门狗 / 事务 abort）→ 故障       → **不该清 alarm**
// 调用方分不清，于是走 (b) 时也 `alarms.clear(SYNC_ALARM)`，而「本轮不再排下一轮」
// 正是清 alarm 的含义 ⇒ 同步停摆到下一次 SW 唤醒（无事件就无唤醒，时长不可控），
// 且 UI 毫无提示。（日志承诺的「下轮重试」并不可靠：没有 alarm 就没有确定性的下一轮。）
describe('H. 读配置失败时不得清 alarm（否则同步停摆到下次 SW 唤醒，时长不可控）', () => {
  it('handleAlarm：kvGet 抛错 → 不得 clear alarm，必须重排一次', async () => {
    const handles = installChromeMock({ syncEnabled: true, syncIntervalMinutes: 60 });
    const mod = await import('@/background/backgroundSync');
    await invalidateSettingsCache();

    // 让 user_settings 的读抛错 —— 模拟死句柄看门狗 / 事务 abort 这类瞬时故障
    const ls = (globalThis as Record<string, unknown>).localStorage as {
      getItem(k: string): string | null;
      setItem(k: string, v: string): void;
    };
    const innerGet = ls.getItem.bind(ls);
    ls.getItem = (k: string) => {
      if (k === 'user_settings') throw new Error('模拟 IndexedDB 读错误');
      return innerGet(k);
    };

    try {
      mod.setupBackgroundSync();
      await waitForSetup(handles);
      // 【为什么不能在 setup 之后取快照当基线】waitForSetup 的等待条件是
      // 「create 或 clear 任一发生」—— 而 setup 自己在「开 + 档位」时走的是
      // create 分支，读失败那次走的是 reschedule（也是 create），
      // 所以基线必须取在 setup **之前**，否则会把 setup 的动作算进本用例。
      const clearedBeforeDispatch = handles.clearedAlarms.length;
      const createsBeforeDispatch = handles.createCalls.length;
      await handles.alarmListeners[0]({ name: 'tapstack-background-sync' } as chrome.alarms.Alarm);
      assert.equal(
        handles.clearedAlarms.length,
        clearedBeforeDispatch,
        '❌ 读失败被当成「用户关闭」而清掉了 alarm —— 同步停摆到下一次 SW 唤醒、时长不可控（且 UI 无提示）'
      );
      assert.ok(
        handles.createCalls.length > createsBeforeDispatch,
        '❌ 读失败后必须重排一个 alarm（瞬时错误下轮自愈），实测没排'
      );
    } finally {
      ls.getItem = innerGet;
    }
    assert.equal(
      handles.createCalls.at(-1)?.opts.delayInMinutes,
      1,
      '❌ 读失败后必须重排一个短延迟的 alarm（瞬时错误下轮自愈），实测没排'
    );
  });

  it('setupBackgroundSync：启动时读失败 → 不得 clear alarm，必须排一次重试', async () => {
    // SYNC_ALARM 的创建点全在本模块；本函数每次 SW 唤醒都会经模块顶层重进，
    // 所以清 alarm 不是「一次性永久」，但重建依赖 SW 再次被唤醒 ——
    // 无事件就无唤醒，停摆时长不可控（且期间无 UI 提示）。
    const handles = installChromeMock({ syncEnabled: true, syncIntervalMinutes: 60 });
    const mod = await import('@/background/backgroundSync');
    await invalidateSettingsCache();

    const ls = (globalThis as Record<string, unknown>).localStorage as {
      getItem(k: string): string | null;
    };
    const innerGet = ls.getItem.bind(ls);
    ls.getItem = (k: string) => {
      if (k === 'user_settings') throw new Error('模拟 IndexedDB 读错误');
      return innerGet(k);
    };

    try {
      mod.setupBackgroundSync();
      await waitForSetup(handles);
    } finally {
      ls.getItem = innerGet;
    }

    assert.equal(
      handles.clearedAlarms.length,
      0,
      '❌ 启动时读失败被当成「用户关闭」而清了 alarm'
    );
    assert.equal(
      handles.createCalls.at(-1)?.opts.delayInMinutes,
      1,
      '❌ 启动读失败后必须排一次重试 alarm，实测没排'
    );
  });

  it('反向：真读到用户关闭时仍然必须清 alarm（不得把闸门整个废掉）', async () => {
    const handles = installChromeMock({ syncEnabled: false });
    const mod = await import('@/background/backgroundSync');
    await invalidateSettingsCache();
    mod.setupBackgroundSync();
    await waitForSetup(handles);
    assert.ok(
      handles.clearedAlarms.length > 0,
      '❌ 真的读到用户关闭时仍必须清 alarm —— 否则关开关前排的那次会一直白醒'
    );
  });
});

// ── 2026-10-12 P1：异常分支不得把用户档位洗回 60s ──────────────────────────
describe('I. 异常重排必须沿用用户档位（不得写死 60s）', () => {
  it('结构层：handleAlarm 的 catch 分支 period 不得恒为 NORMAL_INTERVAL_MINUTES', async () => {
    // 修复前无条件写死 NORMAL_INTERVAL_MINUTES（=1 即 60s），旧注释的理由是
    // 「异常路径拿不到用户档位」—— 作用域层面没错：当时 cfg 在 try 内首行声明，
    // catch 引用不到。但不是硬约束：提到 try 外即可让异常路径也用上真档位。
    // 影响窗口有限：写死的 period 只持续到下一次重排（下一轮 alarm 触发 / SW
    // 唤醒都会用 cfg 重排回档位）。修掉是为了维持「period 恒 = 用户档位」。
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath: f2p } = await import('node:url');
    const { dirname: dn, resolve: rs } = await import('node:path');
    const src = readFileSync(
      rs(dn(f2p(import.meta.url)), '../src/background/backgroundSync.ts'),
      'utf8',
    );
    const start = src.indexOf('async function handleAlarm');
    assert.ok(start > -1, '找不到 handleAlarm');
    const fn = src.slice(start, src.indexOf('\n}\n', start));
    const catchIdx = fn.indexOf('catch (err)');
    assert.ok(catchIdx > -1, 'handleAlarm 必须有 catch 分支');
    const catchBody = fn.slice(catchIdx);

    assert.match(
      catchBody,
      /cfg\?\.intervalMinutes\s*\?\?\s*NORMAL_INTERVAL_MINUTES/,
      '异常重排的 period 必须优先用用户档位（cfg?.intervalMinutes），只有拿不到才回落常量'
    );
    assert.doesNotMatch(
      catchBody,
      /rescheduleAlarm\(\s*backoffMinutesFor\([^)]*\)\s*,\s*NORMAL_INTERVAL_MINUTES\s*\)/,
      '❌ 异常分支把 period 写死成 60s —— 一次异常就把用户档位退回 1 分钟'
    );
    // cfg 必须提到 try 外声明，否则 catch 分支根本拿不到它
    assert.match(
      fn,
      /let\s+cfg\s*:\s*AutoSyncConfig\s*\|\s*null\s*=\s*null/,
      'cfg 必须提到 try 外声明（catch 分支要靠它拿用户档位）'
    );
  });
});
