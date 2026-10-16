// 1.22.15 同步正确性修复（fixer lane）· UI 文案与日志文案回归。
//
// 本文件钉两处「纯文案但会误导人」的修复，行为语义均不变：
//
// 1. SyncButton.tsx 的 REASON_COPY 补全：
//    - 登记 `recent_upload_guard`（上传后 35s 保护窗内的手动下载被跳过，
//      见 syncDecision.ts UPLOAD_GUARD_MS）。缺了它，该 reason 会落到裸枚举
//      回退路径，用户看到的是 `recent_upload_guard` 原文。
//    - 未登记的**纯 snake_case 枚举**（如未来的新 reason）回退到
//      spec.failureMessage，而不是把枚举原文弹给用户。
//    - 带人类可读文本的 reason（如 `validation_failed: ...`、error.message）
//      原样显示，便于定位。
//    - `reason` 可能为 undefined：读 REASON_COPY 前做空值防护。
//
// 2. syncEngine.ts 的 precheck 读取失败日志（downloadAndMerge 的 catch 分支）：
//    判据有两个来源 —— storage.getLastUploadTime()（last_upload_time 键）与
//    hasPendingUpload() → getPendingUpload()（pending_upload 键）。旧文案把
//    两者都写成「读不到 pending_upload 判据」，运维按文案排查会被误导到错误
//    的方向。修复后日志按抛错 message 里的键名区分；失败语义不变：
//    { success: false, reason: 'precheck_unknown' } + 中止，零网络请求。
//
// 断言方式说明：本仓库没有 DOM 测试环境（见 a11yDialogs.test.ts 头注释），
// SyncButton 是 .tsx 组件，采用与 syncOverwriteGuard.test.ts 相同的
// 「readFileSync 源码结构断言」；syncEngine 部分跑真实引擎 + console.warn 捕获
// （该测试文件自身已静音 console，这里只监听不动全局）。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  installFakeSyncBackend,
  resetFakeSyncBackend,
} from './_helpers/fakeSyncBackend.ts';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};
const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

// ── localStorage 桩（无 indexedDB 时 storageAdapter 回退到它）────────
const lsData = new Map<string, string>();
(globalThis as Record<string, unknown>).window = {
  localStorage: {
    get length() {
      return lsData.size;
    },
    key: (i: number) => [...lsData.keys()][i] ?? null,
    getItem: (k: string) => (lsData.has(k) ? (lsData.get(k) as string) : null),
    setItem: (k: string, v: string) => void lsData.set(k, String(v)),
    removeItem: (k: string) => void lsData.delete(k),
    clear: () => lsData.clear(),
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
  alarms: { create: () => undefined, clear: async () => true, onAlarm: { addListener: () => undefined } },
};

const SYNC_BUTTON_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src/components/sync/SyncButton.tsx'
);
const syncButtonSource = () => readFileSync(SYNC_BUTTON_PATH, 'utf8');

before(async () => {
  register(LOADER_PATH);
  lsData.set('tab_groups', JSON.stringify([]));
  lsData.set('storage_version', JSON.stringify(5));
  // 2026-10-16：原先这里 dispatch `setFromCache` 造一个假登录态，好让
  // `ensureAuthenticated` 门禁放行。那道门禁与 session fixture 已随账号体系
  // 删除 —— SyncEngine 的网络出口现在只有 `@/sync-backend`，所以改成注入后端
  // 替身（远端恒空：这些用例考的是本地 precheck 读失败，不是远端数据）。
  await installFakeSyncBackend();
});

after(async () => {
  await resetFakeSyncBackend();
});

// ── 1. SyncButton REASON_COPY ──────────────────────────────────────────────
describe('SyncButton 错误文案：REASON_COPY 补全（1.22.15）', () => {
  it('REASON_COPY 必须登记 recent_upload_guard（35s 保护窗内下载被跳过的文案）', () => {
    const src = syncButtonSource();
    assert.match(
      src,
      /recent_upload_guard:\s*'[^']+'/,
      'REASON_COPY 缺少 recent_upload_guard：该 reason 会落到裸枚举回退路径，' +
        '用户看到的是 `recent_upload_guard` 原文，等于没说'
    );
  });

  it('REASON_COPY 必须登记 overwrite_empty_cloud_refused（空云端覆盖闸门的文案）', () => {
    // 2026-10-16 审查 L1：该 reason 由 syncEngine 的空云端闸门产出
    // （decideForceRemoteOverwrite refuse）。不登记的话它是纯 snake_case，
    // 过不了「非纯枚举原样显示」分支，用户只看到通用失败文案，而闸门那句
    // 「已中止以免清空本机、如需清空请手动删除」恰好是他此刻最需要的。
    const src = syncButtonSource();
    assert.match(
      src,
      /overwrite_empty_cloud_refused:\s*'[^']+'/,
      'REASON_COPY 缺少 overwrite_empty_cloud_refused：覆盖下载撞空云端闸门时，' +
        '用户看不到「已中止以免清空本机」的定向说明，只有通用失败文案'
    );
  });

  it('纯 snake_case 的未登记枚举回退到 spec.failureMessage，而不是裸枚举', () => {
    const src = syncButtonSource();
    // 修法（已定）：mapped || (reason && !/^[a-z_]+$/.test(reason) ? reason : undefined) || spec.failureMessage
    assert.match(
      src,
      /\^\[a-z_\]\+\$\/\.test\(reason\)/,
      '缺少纯 snake_case 判定：未登记枚举会原样展示给用户'
    );
    assert.match(
      src,
      /\|\s*spec\.failureMessage;/,
      '回退终点必须是 spec.failureMessage'
    );
  });

  it('带人类可读文本的 reason（如 error.message）必须原样显示', () => {
    const src = syncButtonSource();
    assert.match(
      src,
      /reason && !\/\^\[a-z_\]\+\$\/\.test\(reason\) \? reason : undefined/,
      '带文本的 reason 原样透传的表达式丢失'
    );
  });

  it('reason 可能为 undefined：读取 REASON_COPY 前必须做空值防护', () => {
    const src = syncButtonSource();
    assert.match(
      src,
      /reason != null \? REASON_COPY\[reason\] : undefined/,
      'reason 为 undefined 时直接索引会把 undefined 传播进后续 || 链'
    );
  });
});

// ── 2. syncEngine precheck 日志按来源区分 ─────────────────────────────────
describe('precheck 读取失败：日志按来源区分 + 语义保持 fail-closed（1.22.15）', () => {
  it('getLastUploadTime 抛错时，日志点名 last_upload_time（而非 pending_upload），且返回 precheck_unknown', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    invalidateGroupsCache();

    const warns: unknown[][] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args);
    const origGetLast = storage.getLastUploadTime;
    (storage as any).getLastUploadTime = async () => {
      throw new Error('simulated read failure: last_upload_time');
    };
    let result: Awaited<ReturnType<typeof syncEngine.downloadAndMerge>>;
    try {
      result = await syncEngine.downloadAndMerge();
    } finally {
      (storage as any).getLastUploadTime = origGetLast;
      console.warn = origWarn;
    }

    assert.equal(result.success, false, '判据读不到必须中止（fail-closed，语义不变）');
    assert.equal(result.reason, 'precheck_unknown');
    assert.equal(result.groups.length, 0);

    const text = warns.flat().map(x => (typeof x === 'string' ? x : '')).join(' ');
    assert.match(text, /last_upload_time/, `日志必须点名 last_upload_time，实际: ${text}`);
    assert.doesNotMatch(
      text,
      /读不到 pending_upload 判据/,
      '不得再写死 pending_upload 文案误导运维'
    );
  });

  it('getPendingUpload 抛错时，日志点名 pending_upload，同样 precheck_unknown 中止', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    invalidateGroupsCache();

    const warns: unknown[][] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args);
    const origGetPending = storage.getPendingUpload;
    (storage as any).getPendingUpload = async () => {
      throw new Error('simulated read failure: pending_upload');
    };
    let result: Awaited<ReturnType<typeof syncEngine.downloadAndMerge>>;
    try {
      result = await syncEngine.downloadAndMerge();
    } finally {
      (storage as any).getPendingUpload = origGetPending;
      console.warn = origWarn;
    }

    assert.equal(result.success, false);
    assert.equal(result.reason, 'precheck_unknown');
    assert.equal(result.groups.length, 0);

    const text = warns.flat().map(x => (typeof x === 'string' ? x : '')).join(' ');
    assert.match(text, /pending_upload/, `日志必须点名 pending_upload，实际: ${text}`);
  });

  it('无键名特征的其他错误归入中性文案「本地同步判据读取失败」', () => {
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../src/services/syncEngine.ts'),
      'utf8'
    );
    assert.match(
      src,
      /本地同步判据读取失败/,
      '缺少中性兜底文案：无键名特征的错误会落到含糊其辞的旧文案'
    );
  });
});
