// 锁定后端失败的**按起因分级出声**（2026-10-16 审计 A · 缺陷 2）。
//
// 审计探针证明：resolveBackendOutcome() 的 4 个失败分支全部静默落进
// lockedBackend()，于是「配置存储读不出来」「确认没配」「解锁状态读不出来」
// 「确认未解锁」在日志里完全不可区分（三者都是零 console.error、零 console.warn）。
// 设计文档却宣称读失败会额外出声（logError 而非 logWarn）—— 注释与实现不符。
//
// 本文件逐个起因断言**severity 必须不同**：
//   存储读抛错（配置 / 解锁状态）→ console.error
//   确认没配 / 确认未解锁        → console.warn
// 这是能区分失败原因的最小证明；只断言 lockedReason 文案不够，因为「静默的
// 锁定」与「出声的锁定」在返回值上完全同形（.memory/fallback-catch-must-not-equal-
// pre-fix-behavior.md 的判据）。

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

if (!process.env.VERBOSE) {
  console.log = () => {};
}

import { primeSyncBackend, resetActiveSyncBackend } from '@/sync-backend';
import { clearSessionSecrets, saveWebDavConfig } from '@/sync-backend/webdav/config';
import { initStorage } from '@/storage-kv/storageAdapter';

const CONFIG_KEY = 'webdav_sync_config_v1';

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

const has = (entries: unknown[][], needle: string) =>
  entries.some(args => String(args[0]).includes(needle));

before(async () => {
  await initStorage();
});

beforeEach(async () => {
  lsData.clear();
  resetActiveSyncBackend();
  await clearSessionSecrets();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
});

describe('resolveBackendOutcome 的失败分支必须按起因分级出声', () => {
  it('配置存储读失败 → logError（不是 logWarn）', async () => {
    // 只让配置键的读抛错；其余键（如 migration_flags）照常。
    const origGetItem = localStorageStub.getItem;
    localStorageStub.getItem = (k: string) => {
      if (k === CONFIG_KEY) throw new Error('本地存储不可用（测试注入）');
      return origGetItem(k);
    };
    try {
      const { result, warns, errors } = await capture(() => primeSyncBackend());
      assert.match(result.lockedReason ?? '', /配置读取失败/);
      assert.ok(has(errors, '存储不可读'), `读失败必须 logError，实得 errors=${JSON.stringify(errors)}`);
      assert.deepEqual(warns, [], '存储读失败不得以 logWarn 混同「确认没配/未解锁」');
    } finally {
      localStorageStub.getItem = origGetItem;
    }
  });

  it('确认没配 → logWarn（不是 logError）', async () => {
    const { result, warns, errors } = await capture(() => primeSyncBackend());
    assert.match(result.lockedReason ?? '', /云服务信息/);
    assert.ok(has(warns, '尚未配置云盘'), `确认没配必须 logWarn，实得 warns=${JSON.stringify(warns)}`);
    assert.deepEqual(errors, [], '确认没配不是故障，不得以 logError 出声');
  });

  it('确认未解锁 → logWarn（不是 logError）', async () => {
    await saveWebDavConfig({
      baseUrl: 'https://dav.example.com/dav/',
      username: 'u',
      rootPath: 'TapStack',
      encryption: 'plain',
    });
    const { result, warns, errors } = await capture(() => primeSyncBackend());
    assert.match(result.lockedReason ?? '', /解锁/);
    assert.ok(has(warns, '尚未解锁'), `确认未解锁必须 logWarn，实得 warns=${JSON.stringify(warns)}`);
    assert.deepEqual(errors, [], '确认未解锁不是故障，不得以 logError 出声');
  });

  it('解锁状态存储读失败 → logError（与「确认未解锁」severity 不同）', async () => {
    await saveWebDavConfig({
      baseUrl: 'https://dav.example.com/dav/',
      username: 'u',
      rootPath: 'TapStack',
      encryption: 'plain',
    });
    // 会话存储存在、但读会抛错：这是「读不出来」，不是「读到了、没凭据」。
    (globalThis as Record<string, unknown>).chrome = {
      storage: {
        session: {
          get: async () => {
            throw new Error('chrome.storage.session 不可读（测试注入）');
          },
          set: async () => undefined,
          remove: async () => undefined,
        },
      },
    };

    const { result, warns, errors } = await capture(() => primeSyncBackend());
    assert.match(result.lockedReason ?? '', /解锁状态读取失败/);
    assert.ok(has(errors, '会话存储不可读'), `读失败必须 logError，实得 errors=${JSON.stringify(errors)}`);
    assert.deepEqual(warns, [], '读失败不得以 logWarn 混同「确认未解锁」');
  });
});
