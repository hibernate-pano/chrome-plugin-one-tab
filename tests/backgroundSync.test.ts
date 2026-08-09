import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import 'fake-indexeddb/auto';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub',
  DEV: false,
  MODE: 'test',
};

// --- chrome.alarms stub ---
const alarmCalls: Array<{ name: string; periodInMinutes: number }> = [];
(globalThis as any).chrome = {
  alarms: {
    create: (name: string, opts: { periodInMinutes: number }) => {
      alarmCalls.push({ name, periodInMinutes: opts.periodInMinutes });
    },
    onAlarm: { addListener: () => {} },
  },
  runtime: { id: 'test-ext-id' },
};

// 每个 test 用带时间戳的 query 重新 import，避免模块缓存。
async function loadModule() {
  const url = pathToFileURL(
    '/Users/panbo/Code/Demos/chrome-plugin-one-tab/src/background/backgroundSync.ts'
  ).href;
  return await import(`${url}?t=${Date.now()}`);
}

test('ensureBackgroundSyncAlarm creates a 15-min alarm', async () => {
  const { ensureBackgroundSyncAlarm, BACKGROUND_SYNC_ALARM, BACKGROUND_SYNC_PERIOD_MINUTES } =
    await loadModule();
  alarmCalls.length = 0;
  ensureBackgroundSyncAlarm();
  assert.equal(alarmCalls.length, 1, 'should create exactly one alarm');
  assert.equal(alarmCalls[0].name, BACKGROUND_SYNC_ALARM);
  assert.equal(alarmCalls[0].periodInMinutes, BACKGROUND_SYNC_PERIOD_MINUTES);
  assert.equal(BACKGROUND_SYNC_PERIOD_MINUTES, 15, 'period must be 15 minutes per spec');
});

test('handleBackgroundSyncAlarm skips when not authenticated', async () => {
  const { handleBackgroundSyncAlarm } = await loadModule();
  // authCache 读 secureStorage（IndexedDB）；无数据时返回 null → 视为未登录 → 静默跳过。
  await handleBackgroundSyncAlarm(); // should not throw
  assert.ok(true, 'unauthenticated skip must not throw');
});

test('handleBackgroundSyncAlarm runs downloadAndMerge when authenticated and persists status', async () => {
  const { authCache } = await import('@/utils/authCache.ts');
  await authCache.saveAuthState({ id: 'u1', email: 'a@b.c' } as any, true);

  const { handleBackgroundSyncAlarm } = await loadModule();
  await handleBackgroundSyncAlarm();

  // 真实 supabase 客户端在此环境大概率网络失败 → engine 写 lastSyncError；
  // 若 stub 恰好可用则成功写 lastSyncAt。两种情况都必须持久化 lastSyncStatus。
  const { storage } = await import('@/utils/storage.ts');
  const status = await storage.getLastSyncStatus();
  assert.ok(status, 'engine must persist lastSyncStatus after a run');
});
