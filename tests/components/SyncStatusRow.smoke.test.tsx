// UI smoke test for SyncStatusRow (Task 5.2).
//
// SyncStatusRow renders three things:
//   1. a status dot (color varies by syncStatus)
//   2. a timestamp label ("刚刚" / "X分钟前" / "尚未同步")
//   3. a "立即同步" / "同步中…" button that calls syncService.downloadAndRefresh
//
// Strategy: render with a real Redux store (configureStore + the three
// reducers), stub chrome runtime so the button click doesn't blow up,
// and assert visible text for both the idle and syncing states. We do not
// exercise the click handler — syncService pulls in smartSyncService and
// the full sync engine, which is well outside the scope of a UI smoke test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { installJsdom, installChromeStub } from '../_jsdom-helpers.mjs';

installJsdom();
installChromeStub();
// Late import: see Hello.test.ts for rationale.
const { render, screen, cleanup } = await import('@testing-library/react');
const { default: tabReducer, initialTabState } = await import('@/store/slices/tabSlice.ts');
const { default: settingsReducer, initialSettingsState } = await import('@/store/slices/settingsSlice.ts');
const { default: authReducer } = await import('@/store/slices/authSlice.ts');
const { SyncStatusRow } = await import('@/components/sync/SyncStatusRow.tsx');

function makeStore(syncOverrides: Partial<typeof initialTabState> = {}) {
  return configureStore({
    reducer: { tabs: tabReducer, settings: settingsReducer, auth: authReducer },
    preloadedState: {
      tabs: { ...initialTabState, ...syncOverrides },
      settings: initialSettingsState,
      auth: { user: null, isAuthenticated: false, isLoading: false, error: null } as any,
    },
  });
}

test('SyncStatusRow: idle state shows "立即同步" button and "尚未同步" label', async () => {
  // lastSyncTime is null in initialTabState, so we're testing the
  // "never synced" branch.
  const store = makeStore({ syncStatus: 'idle', lastSyncTime: null });
  render(<Provider store={store}><SyncStatusRow /></Provider>);

  assert.equal(screen.getByText('立即同步').textContent, '立即同步');
  assert.equal(screen.getByText('尚未同步').textContent, '尚未同步');
  cleanup();
});

test('SyncStatusRow: syncing state shows "同步中…" button (disabled) and recent timestamp', async () => {
  // A timestamp 30 seconds ago. formatLastSync returns "刚刚" since
  // diffMins < 1.
  const recentTimestamp = new Date(Date.now() - 30 * 1000).toISOString();
  const store = makeStore({ syncStatus: 'syncing', lastSyncTime: recentTimestamp });
  render(<Provider store={store}><SyncStatusRow /></Provider>);

  const button = screen.getByText('同步中…');
  assert.equal(button.textContent, '同步中…');
  // In syncing state the button is disabled.
  assert.equal(button.hasAttribute('disabled'), true);
  assert.equal(screen.getByText('刚刚').textContent, '刚刚');
  cleanup();
});
