# Background Auto-Sync Design

**Date:** 2026-08-09
**Branch:** `codex/v1-11-6-integration`
**Status:** Draft (awaiting user review)

## Context

The extension currently has **reactive auto-sync** but no **proactive auto-sync**:

- **Upload (reactive):** `autoSyncMiddleware` (Redux) watches data-mutating thunks
  (`saveGroup`, `deleteGroup`, `moveTabAndSync`, etc.), debounces 1.5-3s by
  priority, and calls `syncEngine.scheduleUpload()`. Working well.
- **Download (reactive):** `smartSyncService.maybeAutoDownload()` runs when the
  popup opens (2-min cooldown + concurrency lock + race guard). Working well.
- **Gap:** If the user never opens the popup, the extension never pulls cloud
  data. Changes made on another device (phone / other computer) stay invisible
  until the popup opens. The service worker has **no `chrome.alarms` permission**
  and the SW comment explicitly says "定时后台云端同步已移除(v1.12.0)".
- **Second gap:** Sync failures are silent. `maybeAutoDownload` / `maybeAutoUpload`
  use `catch { /* 静默失败 */ }`. `SyncEngine.downloadAndMerge` already writes
  `lastSyncError` to persisted `lastSyncStatus`, but the UI (SyncStatusRow) does
  not render the error state — only SyncTab shows it.

### Decisions made during brainstorming

1. **P0 — Background timed sync:** `chrome.alarms` every 15 minutes, download +
   merge only (upload stays reactive via `autoSyncMiddleware`).
2. **P1 — Failure visibility:** persist `lastSyncError` (already done in engine);
   render it in SyncStatusRow. No system notifications.
3. **Architecture B3:** Service Worker drives the alarm and runs sync **directly
   against the storage layer** (no Redux). Reuse `SyncEngine` with injected deps.
   Popup picks up results on next open via `hydrateAll()`.

## Goals

- Sync cloud data to local **every 15 minutes** even when the popup is closed.
- Surface sync failures in the UI (SyncStatusRow) without notifications.
- Reuse the existing `SyncEngine` (snapshot → download → merge → validate →
  write → rollback) unchanged — do not fork or rewrite sync logic.

## Non-goals

- **Timed upload.** Upload stays reactive (`autoSyncMiddleware`). Adding timed
  upload risks double-writes / conflicts for marginal benefit.
- **System notifications on failure.** P1 is "visible when the popup opens",
  not "interrupt the user".
- **Refactoring `SyncEngine` to remove its singleton.** We instantiate a
  dedicated SW instance with injected deps; the singleton stays for popup use.
- **Changing `smartSyncService` / popup sync flow** beyond the SyncStatusRow UI.

## Design

### 1. New module: `src/background/backgroundSync.ts`

A small, self-contained scheduler that owns the `chrome.alarms` lifecycle:

```
export const BACKGROUND_SYNC_ALARM = 'tabstack-background-sync';

export function ensureBackgroundSyncAlarm(): void   // create if missing
export async function handleBackgroundSyncAlarm(): Promise<void>  // onAlarm entry
```

- `ensureBackgroundSyncAlarm()`: called from `onInstalled` and `onStartup`
  (idempotent — `chrome.alarms.create` with the same name replaces).
- `handleBackgroundSyncAlarm()`:
  1. Read auth from `authCache.getAuthState()` — no Redux.
  2. Not authenticated → return silently (alarm stays; fires again next period).
  3. Already syncing (a popup sync is in flight) → skip this cycle.
  4. Build a SW-local `SyncEngine` with injected deps:
     ```
     new SyncEngine({
       getState: () => ({ auth: swAuth, settings: { syncStrategy: 'newest' } }),
     })
     ```
     `syncStrategy` comes from `storage.getSettings()`; default `'newest'`.
  5. `await engine.downloadAndMerge()` — the engine writes
     `storage.setGroups` + `setLastSyncTime` + `setLastSyncStatus`
     (success clears `lastSyncError`; failure writes it) and rolls back on error.
  6. Log a one-line summary (success/failure + counts). No toast, no notification.

### 2. `src/service-worker.ts` — wire the alarm

Add two listeners to the existing file (following existing patterns):

```ts
chrome.runtime.onInstalled.addListener(...)   // existing — add ensureBackgroundSyncAlarm()
chrome.runtime.onStartup.addListener(...)     // existing — add ensureBackgroundSyncAlarm()
chrome.alarms.onAlarm.addListener(alarm => {  // NEW
  if (alarm.name === BACKGROUND_SYNC_ALARM) {
    void handleBackgroundSyncAlarm();
  }
});
```

### 3. `manifest.json` — add `alarms` permission

```json
"permissions": ["tabs", "storage", "unlimitedStorage", "notifications", "contextMenus", "alarms"]
```

### 4. `src/components/sync/SyncStatusRow.tsx` — error state (P1)

Current row shows dot (idle/syncing/error colors) + last-sync time + "立即同步"
button. Enhance:

- Read `lastSyncError` from the persisted `lastSyncStatus` (via
  `useAppSelector` on `tabs.lastSyncStatus` or the same source SyncTab uses).
- When `lastSyncError` is non-empty, render it as a small rose-colored line
  under the row (same style as SyncTab.tsx:100-102) — no blocking, just visible.
- Keep the "立即同步" button; clicking it still calls
  `syncService.downloadAndRefresh(false)` and a successful run clears the error
  (engine already writes `lastSyncError: null` on success).

### 5. Data flow (end to end)

```
[another device] → Supabase cloud
        ↑ (reactive upload via autoSyncMiddleware, unchanged)
[popup open]      → autoSyncMiddleware → syncEngine.scheduleUpload → upload

[SW alarm 15min]  → handleBackgroundSyncAlarm
        → authCache.getAuthState()
        → (not authed → skip)
        → new SyncEngine({ getState: swGetState }).downloadAndMerge()
        → storage.setGroups(merged) + setLastSyncTime + setLastSyncStatus
        → (popup next open) hydrateAll() reads new data + lastSyncStatus
```

### 6. Error handling

| Case | Behavior |
|---|---|
| Not authenticated | Silent skip (alarm persists) |
| Sync in flight (popup) | Skip this cycle (`getIsSyncing()` lock inside engine) |
| Download/merge failure | Engine rolls back to snapshot + writes `lastSyncError` |
| Chrome suspended | `chrome.alarms` only fires when Chrome is running; no issue |
| Invalid `syncStrategy` | Fall back to `'newest'` (engine + mergeTabGroups already handle) |

### 7. Testing

- `tests/backgroundSync.test.ts` (new):
  - `ensureBackgroundSyncAlarm` creates the alarm with correct name/period
    (mock `chrome.alarms`).
  - `handleBackgroundSyncAlarm` skips when not authenticated.
  - `handleBackgroundSyncAlarm` calls `downloadAndMerge` when authenticated
    (mock engine deps / assert storage writes).
  - Failure path: engine failure → `lastSyncError` written to storage
    (mock `downloadTabGroups` to reject).
- `tests/components/SyncStatusRow.smoke.test.tsx` (extend or new):
  - Renders error text when `lastSyncError` is set.
  - Does not render error text when it's null.
- Existing `syncEngine.test.ts` / `syncMergeSafety.test.ts` must stay green —
  we do NOT change engine logic, only instantiate it with SW deps.

## Verification

- `pnpm verify` (validate + type-check + lint + build + node tests + jsdom).
- `pnpm package` — `chrome-extension.zip` ≤ 280 KB (alarms adds no bundle weight
  of note; SW bundle grows by ~1-2 KB).

## Definition of done

- [ ] `manifest.json` includes `alarms` permission.
- [ ] `src/background/backgroundSync.ts` exists with `ensureBackgroundSyncAlarm`
      and `handleBackgroundSyncAlarm`.
- [ ] `service-worker.ts` wires the alarm on install + startup + onAlarm.
- [ ] SW sync uses `new SyncEngine({ getState: swGetState })` — no global store.
- [ ] `lastSyncError` persists on failure, clears on success (engine behavior,
      verified by test).
- [ ] `SyncStatusRow` renders `lastSyncError` when present.
- [ ] `pnpm verify` green.
- [ ] `pnpm package` zip ≤ 280 KB.

## Out of scope

- Timed upload (stays reactive).
- Notifications on failure.
- SyncEngine refactor to remove singleton.
- UI beyond SyncStatusRow error line.
