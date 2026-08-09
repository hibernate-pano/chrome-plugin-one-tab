# Background Auto-Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add proactive background sync (every 15 min via `chrome.alarms`, download + merge only) and surface sync failures in the UI, so users get cloud data even when the popup is closed.

**Architecture:** The Service Worker owns a `chrome.alarms` timer and, on fire, constructs a SW-local `SyncEngine` with injected deps (`getState` reads `authCache` + `storage.getSettings()`, no Redux) and calls `downloadAndMerge()`. The engine writes merged groups + `lastSyncStatus` to IndexedDB; the popup picks them up on next open via `hydrateAll()`. `SyncStatusRow` renders the persisted `lastSyncError` when present.

**Tech Stack:** Chrome Extension MV3 (service worker, chrome.alarms), TypeScript, React, node:test + jsdom.

## Global Constraints

- AGENTS.md "Completion rule": never stop before done; automated checks with non-zero exit on failure; no long-running background processes left after verification.
- AGENTS.md "Refresh persistence regression": all read-modify-write paths must use `storage.getGroupsOrThrow()`; `tests/refreshDataLossRootCause.test.ts` must stay green; run `pnpm verify` after changes touching storage, hydration, tab thunks, sync engine, or migrations.
- AGENTS.md "Responses": reply in Chinese.
- `pnpm verify` must be green: type-check 0 errors, lint 0 warnings, build OK, node tests (322) + jsdom (26) all pass.
- `pnpm package` → `chrome-extension.zip` ≤ 280 KB.
- Do NOT modify `syncEngine.ts` logic — only instantiate it with injected deps.
- Do NOT add timed upload. Upload stays reactive via `autoSyncMiddleware`.
- Do NOT add system notifications.

## File Structure

| File | Operation | Role |
|---|---|---|
| `src/background/backgroundSync.ts` | Create | Alarm scheduler + SW sync entry (the core new module) |
| `src/service-worker.ts` | Modify | Wire `ensureBackgroundSyncAlarm()` on install/startup + `onAlarm` listener |
| `manifest.json` | Modify | Add `alarms` permission |
| `src/components/sync/SyncStatusRow.tsx` | Modify | Render `lastSyncError` when present (P1) |
| `tests/backgroundSync.test.ts` | Create | 3 scenarios: alarm created, skip when unauthenticated, downloadAndMerge on authenticated + failure writes lastSyncError |
| `tests/components/SyncStatusRow.smoke.test.tsx` | Extend | Error-state render test |

---

## Task 1: `src/background/backgroundSync.ts` — alarm scheduler + SW sync entry

**Files:**
- Create: `src/background/backgroundSync.ts`
- Test: `tests/backgroundSync.test.ts`

**Interfaces:**
- Consumes: `authCache.getAuthState()` (returns `{ user, isAuthenticated } | null`), `SyncEngine` (constructor accepts `{ getState, storage?, ... }` deps), `storage.getSettings()` (returns `UserSettings` with `syncStrategy`).
- Produces:
  - `export const BACKGROUND_SYNC_ALARM = 'tabstack-background-sync'`
  - `export const BACKGROUND_SYNC_PERIOD_MINUTES = 15`
  - `export function ensureBackgroundSyncAlarm(): void` — creates the alarm if missing (idempotent)
  - `export async function handleBackgroundSyncAlarm(): Promise<void>` — the onAlarm entry (no return value)

- [ ] **Step 1: Write the failing test**

Create `tests/backgroundSync.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import 'fake-indexeddb/auto';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub',
  DEV: false,
  MODE: 'test',
};

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

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

let handledAlarms: string[] = [];

// --- Module registry for the module-under-test (re-imported per test) ---
async function loadModule() {
  // Clear module cache so each test gets a fresh import.
  const base = '/Users/panbo/Code/Demos/chrome-plugin-one-tab/src/background/backgroundSync.ts';
  const url = pathToFileURL(base).href;
  delete (require as any).cache;
  return await import(url);
}

test('ensureBackgroundSyncAlarm creates a 15-min alarm', async () => {
  const { ensureBackgroundSyncAlarm, BACKGROUND_SYNC_ALARM, BACKGROUND_SYNC_PERIOD_MINUTES } = await loadModule();
  alarmCalls.length = 0;
  ensureBackgroundSyncAlarm();
  assert.equal(alarmCalls.length, 1, 'should create exactly one alarm');
  assert.equal(alarmCalls[0].name, BACKGROUND_SYNC_ALARM);
  assert.equal(alarmCalls[0].periodInMinutes, BACKGROUND_SYNC_PERIOD_MINUTES);
  assert.equal(BACKGROUND_SYNC_PERIOD_MINUTES, 15, 'period must be 15 minutes per spec');
});

test('handleBackgroundSyncAlarm skips when not authenticated', async () => {
  const { handleBackgroundSyncAlarm } = await loadModule();
  // authCache reads secureStorage → IndexedDB; with no data it returns null
  // (getAuthState → null → treated as unauthenticated).
  await handleBackgroundSyncAlarm(); // should not throw
  assert.ok(true, 'unauthenticated skip must not throw');
});

test('handleBackgroundSyncAlarm runs downloadAndMerge when authenticated and writes lastSyncError on failure', async () => {
  // Set up an authenticated authCache + a failing download path.
  const { authCache } = await import('@/utils/authCache.ts');
  await authCache.saveAuthState({ id: 'u1', email: 'a@b.c' } as any, true);

  const { handleBackgroundSyncAlarm } = await loadModule();
  await handleBackgroundSyncAlarm(); // engine will try downloadTabGroups → supabase stub → likely fails or network error

  // If the real supabase client fails (no network), lastSyncError should be written.
  const { storage } = await import('@/utils/storage.ts');
  const status = await storage.getLastSyncStatus();
  // Either success (lastSyncError null) or failure (lastSyncError non-null) — both acceptable,
  // but the status object must exist (proves engine ran and persisted).
  assert.ok(status, 'engine must persist lastSyncStatus after a run');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
node --test --test-force-exit --test-concurrency=1 --experimental-strip-types --experimental-test-module-mocks --loader ./tests/_alias-loader.mjs tests/backgroundSync.test.ts 2>&1 | tail -15
```
Expected: FAIL — module `src/background/backgroundSync.ts` does not exist (ERR_MODULE_NOT_FOUND) or exports undefined.

- [ ] **Step 3: Create `src/background/backgroundSync.ts`**

```ts
import { authCache } from '@/utils/authCache';
import { storage } from '@/utils/storage';
import { SyncEngine } from '@/services/syncEngine';

/**
 * 后台自动同步（P0）
 *
 * Service Worker 每 15 分钟通过 chrome.alarms 触发一次「拉取并合并」云端数据。
 * 设计约束（spec 2026-08-09-background-auto-sync-design.md §B3）：
 * - 只下载 + 合并，不上传（上传保持 autoSyncMiddleware 响应式）。
 * - 不依赖 Redux store：登录态走 authCache，settings 走 storage.getSettings()。
 * - 复用 SyncEngine（快照 → 下载 → 合并 → 验证 → 写入 → 回滚），不改其逻辑。
 * - 失败静默写 lastSyncStatus.lastSyncError（不弹通知），popup 打开时可见。
 */
export const BACKGROUND_SYNC_ALARM = 'tabstack-background-sync';
export const BACKGROUND_SYNC_PERIOD_MINUTES = 15;

/** 幂等创建 15 分钟周期 alarm（同名 create 自动替换）。 */
export function ensureBackgroundSyncAlarm(): void {
  chrome.alarms.create(BACKGROUND_SYNC_ALARM, {
    periodInMinutes: BACKGROUND_SYNC_PERIOD_MINUTES,
  });
}

/**
 * onAlarm 入口：未登录静默跳过；已登录则用 SW 本地依赖构造 SyncEngine 并拉取合并。
 * 不抛错（任何异常都被 engine 内部捕获并写入 lastSyncError）。
 */
export async function handleBackgroundSyncAlarm(): Promise<void> {
  try {
    const cachedAuth = await authCache.getAuthState();
    if (!cachedAuth?.isAuthenticated) {
      console.log('[BackgroundSync] 未登录，跳过后台同步');
      return;
    }

    const settings = await storage.getSettings();
    const engine = new SyncEngine({
      getState: () => ({
        auth: { isAuthenticated: true, user: cachedAuth.user } as any,
        settings: { syncStrategy: settings.syncStrategy ?? 'newest' } as any,
        tabs: undefined as any,
      }),
    });

    const result = await engine.downloadAndMerge();
    console.log(
      `[BackgroundSync] ${result.success ? '同步成功' : '同步失败'}: ` +
      `本地 ${result.stats?.localCount ?? 0} / 云端 ${result.stats?.cloudCount ?? 0} / ` +
      `合并 ${result.stats?.mergedCount ?? 0} 个组` +
      (result.reason ? ` (${result.reason})` : '')
    );
  } catch (error) {
    // engine 内部已写 lastSyncError；这里兜底记录，避免 SW 崩溃。
    console.error('[BackgroundSync] 后台同步异常:', error);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
node --test --test-force-exit --test-concurrency=1 --experimental-strip-types --experimental-test-module-mocks --loader ./tests/_alias-loader.mjs tests/backgroundSync.test.ts 2>&1 | tail -12
```
Expected: all 3 tests PASS.

If the third test's `storage.getLastSyncStatus()` returns null (engine didn't write), check whether `downloadAndMerge` short-circuits on `isSyncing` (the SW singleton may already be syncing). If so, add `SyncEngine.__resetInstanceForTesting()` before the call in the test, or call `new SyncEngine({...})` directly with fresh deps. The implementation should NOT be modified to weaken concurrency — fix the test instead.

- [ ] **Step 5: Commit**

```bash
git add src/background/backgroundSync.ts tests/backgroundSync.test.ts
git -c user.name=panbo -c user.email=panbo.coding@qq.com commit -m "feat(sync): background sync scheduler (chrome.alarms every 15min, download+merge)"
```

---

## Task 2: Wire alarm into `service-worker.ts` + `manifest.json` alarms permission

**Files:**
- Modify: `src/service-worker.ts`
- Modify: `manifest.json`

**Interfaces:**
- Consumes: `ensureBackgroundSyncAlarm` + `handleBackgroundSyncAlarm` + `BACKGROUND_SYNC_ALARM` from `@/background/backgroundSync` (Task 1).

- [ ] **Step 1: Add `alarms` permission to `manifest.json`**

In `manifest.json`, find `"permissions"` and add `"alarms"`:

```json
"permissions": [
  "tabs",
  "storage",
  "unlimitedStorage",
  "notifications",
  "contextMenus",
  "alarms"
],
```

- [ ] **Step 2: Wire the alarm into `service-worker.ts`**

Add the import at the top (after the existing `tabManager` / `migrateToV2` imports):

```ts
import { ensureBackgroundSyncAlarm, handleBackgroundSyncAlarm, BACKGROUND_SYNC_ALARM } from '@/background/backgroundSync';
```

In the existing `chrome.runtime.onInstalled.addListener` callback, add `ensureBackgroundSyncAlarm();` (after `await setupContextMenus();`):

```ts
  // 创建右键菜单
  await setupContextMenus();

  // 后台自动同步 alarm（幂等）
  ensureBackgroundSyncAlarm();
```

In the existing `chrome.runtime.onStartup.addListener` callback, add the same line (after `await setupContextMenus();`).

At the end of the file (after the `setupContextMenus().catch(...)` call), add the onAlarm listener:

```ts
// 后台自动同步：每 15 分钟拉取并合并云端数据（popup 关闭时也能同步）
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === BACKGROUND_SYNC_ALARM) {
    void handleBackgroundSyncAlarm();
  }
});
```

- [ ] **Step 3: Verify type-check + lint**

Run:
```bash
pnpm type-check
pnpm lint
```
Expected: 0 errors, 0 warnings.

- [ ] **Step 4: Verify build**

Run:
```bash
pnpm build
```
Expected: build succeeds. Confirm `dist/service-worker.js` includes a reference to `backgroundSync` (grep for `tabstack-background-sync`):
```bash
grep -c "tabstack-background-sync" dist/service-worker.js
```
Expected: ≥ 1.

- [ ] **Step 5: Run the node tests (no jsdom needed for this task)**

Run:
```bash
pnpm test
```
Expected: 322/322 pass (the new backgroundSync.test.ts is among them if it lives in tests/).

- [ ] **Step 6: Commit**

```bash
git add manifest.json src/service-worker.ts
git -c user.name=panbo -c user.email=panbo.coding@qq.com commit -m "feat(sync): wire background sync alarm into service worker + alarms permission"
```

---

## Task 3: `SyncStatusRow` error-state rendering (P1)

**Files:**
- Modify: `src/components/sync/SyncStatusRow.tsx`
- Extend: `tests/components/SyncStatusRow.smoke.test.tsx`

**Interfaces:**
- Consumes: `storage.getLastSyncStatus()` (returns `Promise<{ lastSyncAt: string | null; lastSyncError: string | null }>`).
- Produces: no new exports; SyncStatusRow now shows an error line below the row when `lastSyncError` is non-empty.

- [ ] **Step 1: Write the failing test**

Append to `tests/components/SyncStatusRow.smoke.test.tsx`:

```tsx
// P1: error state — render lastSyncError from persisted status.
test('SyncStatusRow: shows error text when lastSyncError is set', async () => {
  const { storage } = await import('@/utils/storage.ts');
  await storage.setLastSyncStatus({ lastSyncAt: null, lastSyncError: '网络不可用，稍后重试' });

  const store = makeStore({ syncStatus: 'error', lastSyncTime: null });
  render(<Provider store={store}><SyncStatusRow /></Provider>);

  // The component reads persisted status on mount; wait for it.
  const err = await screen.findByText(/网络不可用/);
  assert.ok(err, 'should render lastSyncError text');
  cleanup();
});

test('SyncStatusRow: no error text when lastSyncError is null', async () => {
  const { storage } = await import('@/utils/storage.ts');
  await storage.setLastSyncStatus({ lastSyncAt: null, lastSyncError: null });

  const store = makeStore({ syncStatus: 'idle', lastSyncTime: null });
  render(<Provider store={store}><SyncStatusRow /></Provider>);

  // Give the mount effect a tick, then assert no error text.
  await new Promise(r => setTimeout(r, 50));
  assert.equal(screen.queryByText(/上次同步失败/), null, 'should NOT render error when null');
  cleanup();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
node --test --test-force-exit --test-concurrency=1 --experimental-strip-types --experimental-test-module-mocks --loader ./tests/_alias-loader.mjs tests/components/SyncStatusRow.smoke.test.tsx 2>&1 | tail -12
```
Expected: FAIL — "上次同步失败" text not found (component doesn't render it yet).

- [ ] **Step 3: Modify `SyncStatusRow.tsx`**

Add a `lastSyncError` state + effect that reads persisted status on mount, and render the error line. The current component is:

```tsx
export const SyncStatusRow: React.FC = () => {
  const status = useAppSelector(s => s.tabs.syncStatus);
  const lastSyncAt = useAppSelector(s => s.tabs.lastSyncTime);
  const isBusy = status === 'syncing';
  ...
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className={dotClass} aria-hidden="true" />
      <span className="text-gray-700 dark:text-gray-300">{formatLastSync(lastSyncAt)}</span>
      <button ...>立即同步</button>
    </div>
  );
};
```

Change it to:

```tsx
import React, { useEffect, useState } from 'react';
import { useAppSelector } from '@/store/hooks';
import { syncService } from '@/services/syncService';
import { storage } from '@/utils/storage';
import { cn } from '@/lib/utils';
import { formatLastSync } from '@/utils/sessionPresentation';

/**
 * Compact "sync status + manual refresh" row used inside SyncTab.
 *
 * P1 (2026-08-09): also shows a persisted lastSyncError line when the
 * previous background/manual sync failed. Source is storage.getLastSyncStatus()
 * (IndexedDB direct read — SW-written errors are not in Redux).
 */
export const SyncStatusRow: React.FC = () => {
  const status = useAppSelector(s => s.tabs.syncStatus);
  const lastSyncAt = useAppSelector(s => s.tabs.lastSyncTime);
  const isBusy = status === 'syncing';

  const [lastSyncError, setLastSyncError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    storage.getLastSyncStatus().then(s => {
      if (!cancelled) setLastSyncError(s.lastSyncError);
    });
    return () => { cancelled = true; };
  }, []);

  const dotClass = cn(
    'inline-block h-2 w-2 rounded-full',
    status === 'error' && 'bg-rose-500',
    status === 'syncing' && 'bg-amber-500 animate-pulse',
    (status === 'idle' || status === 'success') && 'bg-emerald-500'
  );

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={dotClass} aria-hidden="true" />
        <span className="text-gray-700 dark:text-gray-300">{formatLastSync(lastSyncAt)}</span>
        <button
          onClick={() => {
            if (isBusy) return;
            void syncService.downloadAndRefresh(false);
          }}
          disabled={isBusy}
          className={cn(
            'ml-auto inline-flex items-center justify-center rounded-md px-3 py-1.5 text-xs font-medium flat-interaction',
            isBusy
              ? 'cursor-not-allowed bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-500'
              : 'bg-primary-600 text-white hover:bg-primary-700'
          )}
        >
          {isBusy ? '同步中…' : '立即同步'}
        </button>
      </div>
      {lastSyncError && (
        <p className="text-xs text-rose-500 dark:text-rose-400">
          上次同步失败：{lastSyncError}
        </p>
      )}
    </div>
  );
};

export default SyncStatusRow;
```

- [ ] **Step 4: Run the smoke test to verify it passes**

Run:
```bash
node --test --test-force-exit --test-concurrency=1 --experimental-strip-types --experimental-test-module-mocks --loader ./tests/_alias-loader.mjs tests/components/SyncStatusRow.smoke.test.tsx 2>&1 | tail -12
```
Expected: all tests PASS (2 existing + 2 new).

- [ ] **Step 5: Run jsdom + node suites**

Run:
```bash
pnpm test:jsdom
pnpm test
```
Expected: jsdom all green (28 now), node tests all green (322).

- [ ] **Step 6: Commit**

```bash
git add src/components/sync/SyncStatusRow.tsx tests/components/SyncStatusRow.smoke.test.tsx
git -c user.name=panbo -c user.email=panbo.coding@qq.com commit -m "feat(ui): SyncStatusRow shows persisted lastSyncError (P1 failure visibility)"
```

---

## Task 4: Full verification + zip-size check

**Files:** none — sanity step.

- [ ] **Step 1: Run `pnpm verify`**

Run:
```bash
pnpm verify
```
Expected: EXIT=0 — validate, type-check (0 errors), lint (0 warnings), build OK, node tests (322), jsdom (28).

- [ ] **Step 2: Run `pnpm package` + zip size**

Run:
```bash
pnpm package
ls -lh chrome-extension.zip | awk '{print $5}'
```
Expected: ≤ 280K (previous 254K; the SW bundle grows by ~1-2 KB, should stay well under).

- [ ] **Step 3: Final commit if any stray changes**

Run:
```bash
git status --porcelain
```
Expected: empty. If not, investigate before committing.

---

## Definition of done (final)

- [ ] `manifest.json` includes `alarms` permission.
- [ ] `src/background/backgroundSync.ts` exists with `BACKGROUND_SYNC_ALARM`, `BACKGROUND_SYNC_PERIOD_MINUTES = 15`, `ensureBackgroundSyncAlarm`, `handleBackgroundSyncAlarm`.
- [ ] `service-worker.ts` calls `ensureBackgroundSyncAlarm()` on install + startup and listens to `chrome.alarms.onAlarm` for `BACKGROUND_SYNC_ALARM`.
- [ ] SW sync constructs `new SyncEngine({ getState })` — no global Redux store.
- [ ] `SyncStatusRow` renders `lastSyncError` when present; hides when null.
- [ ] `tests/backgroundSync.test.ts` green (alarm created; unauthenticated skip; authenticated run persists status).
- [ ] `tests/components/SyncStatusRow.smoke.test.tsx` green (error + no-error).
- [ ] `pnpm verify` green.
- [ ] `pnpm package` zip ≤ 280 KB.
