// 读取路径的后端归一（2026-10-16 审计 A · 缺陷 1）。
//
// 审计探针证明：getSettings() 从不调用 validateSyncBackend()，于是 localStorage
// 里的 `syncBackend: 'supabase'` 原样穿透 —— 返回类型写着 'webdav'，对象却在
// 对自己的类型撒谎；更糟的是 uploadSettings 会把这个陈旧键传上云端设置文件，
// 扩散到用户所有设备。
//
// 本文件不做纯函数测试（tests/webdavWiring.test.ts 已有），而是走**真实 KV 底座**
// （storage-kv 的 localStorage 驱动 + getSettings 的完整读路径），钉三件事：
//   1. 返回值归一为 'webdav'；
//   2. 归一值**落盘**（否则下次冷启动又读到旧值，只是口头修正）；
//   3. 弃用告警出声（存量用户「为什么被切了」有迹可循，不是静默改写）。
//
// 环境纪律（与 tests/webdavWiring.test.ts 的注释同源）：必须先 await initStorage()
// 再 seed，否则 migrateFromLocalStorage 会先扫走并重写这些键，断言读到的东西
// 可能根本不是测试灌进去的那份。

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

if (!process.env.VERBOSE) {
  console.log = () => {};
}

import { storage, DEFAULT_SETTINGS } from '@/utils/storage';
import { kvGet, kvSet, initStorage } from '@/storage-kv/storageAdapter';
import { cacheManager } from '@/utils/performance';

// ── localStorage 底座：storageAdapter.pickBackend() 在无 indexedDB 时回退到它 ──
const lsData = new Map<string, string>();
const localStorageStub = {
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
(globalThis as Record<string, unknown>).window = { localStorage: localStorageStub };

const clearSettingsCache = () => cacheManager.getCache('storage').delete('settings');

/** 直接读持久化层，绕过 getSettings 的归一 —— 验证的是「盘上真的变了」。 */
const persistedSettings = () => kvGet<Record<string, unknown>>('user_settings');

/** 捕获一次调用期间的 console.warn / console.error。 */
async function capture<T>(
  fn: () => Promise<T>
): Promise<{ result: T; warns: unknown[][]; errors: unknown[][] }> {
  const warns: unknown[][] = [];
  const errors: unknown[][] = [];
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (...args: unknown[]) => {
    warns.push(args);
  };
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    const result = await fn();
    return { result, warns, errors };
  } finally {
    console.warn = origWarn;
    console.error = origError;
  }
}

before(async () => {
  await initStorage();
});

beforeEach(() => {
  lsData.clear();
  clearSettingsCache();
});

describe('getSettings 读路径：legacy supabase 必须被归一', () => {
  it("种子 'supabase' → 返回 'webdav'、盘上落成 'webdav'、并打一条弃用告警", async () => {
    await kvSet('user_settings', { ...DEFAULT_SETTINGS, syncBackend: 'supabase' });
    clearSettingsCache();

    const { result: settings, warns, errors } = await capture(() => storage.getSettings());

    // 1) 返回值不再对自己的类型撒谎（修复前这里拿到 'supabase'）。
    assert.equal(settings.syncBackend, 'webdav', 'getSettings 的返回值必须诚实');

    // 2) 归一值必须落盘：修复前原样留在盘上，下一轮读又是烂值。
    const persisted = await persistedSettings();
    assert.equal(persisted?.syncBackend, 'webdav', '归一值必须持久化，不能只在内存里修正');

    // 3) 出声：'supabase' 是预期的存量值，但归一必须留下一条弃用告警。
    assert.ok(
      warns.some(args => String(args[0]).includes('同步后端标识已废弃')),
      `应打一条弃用告警，实得 warns=${JSON.stringify(warns)}`
    );
    assert.deepEqual(errors, [], '归一不是故障，不该以 logError 出声');
  });

  it('归一后再次读取是幂等的，且不再重复告警', async () => {
    await kvSet('user_settings', { ...DEFAULT_SETTINGS, syncBackend: 'supabase' });
    clearSettingsCache();
    await storage.getSettings();

    // 模拟冷启动：清缓存、重新走真实读路径（盘上已是归一值）。
    clearSettingsCache();
    const { result: second, warns } = await capture(() => storage.getSettings());
    assert.equal(second.syncBackend, 'webdav');
    assert.equal(
      warns.filter(args => String(args[0]).includes('同步后端标识已废弃')).length,
      0,
      '盘上已是 webdav 后不该再刷弃用告警（每秒一条会把真异常淹没）'
    );
  });
});

describe('写路径同样归一（JSON 导入合并走的就是 setSettings）', () => {
  it("setSettings 收到 'supabase' → 落盘时归一为 'webdav'", async () => {
    // importDetailed 的 settings 合并是 `setSettings({...current, ...file.settings})`，
    // 所以本用例覆盖的正是「旧导出文件里的 supabase 值」这条通道。
    await storage.setSettings({ ...DEFAULT_SETTINGS, syncBackend: 'supabase' } as never);
    const persisted = await persistedSettings();
    assert.equal(persisted?.syncBackend, 'webdav', '写路径必须与读路径同口径归一');
  });
});
