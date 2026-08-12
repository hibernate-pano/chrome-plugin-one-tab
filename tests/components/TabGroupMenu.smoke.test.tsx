// UI smoke test for the per-group action menu surface (Task 5.2).
//
// The brief originally called for a `TabGroupMenu` component. A search of
// `src/components/` confirms that no such component exists in the current
// codebase — the per-group action surface is the button row inside
// `TabGroup.tsx` (恢复 / 重命名 / 备注 / 锁定 / 删除), rendered
// via `DraggableTabGroup` → `TabGroup`. We test that surface directly:
//
//   1. TabGroup renders its action buttons (恢复整个会话, 重命名, etc.)
//
// This is a faithful substitute: it is the same UI element the user
// interacts with, just reached via the actual production component
// instead of a separate (non-existent) component.
//
// TabGroup uses `useToast`, so we wrap renders in ToastProvider. It also
// uses `useEnhancedToast`, which depends on ToastContext, so the same
// provider covers both.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { installJsdom, installChromeStub } from '../_jsdom-helpers.mjs';

installJsdom();
installChromeStub();

const { render, screen, cleanup, fireEvent } = await import('@testing-library/react');
const { default: tabReducer, initialTabState } = await import('@/store/slices/tabSlice.ts');
const { default: settingsReducer, initialSettingsState } = await import('@/store/slices/settingsSlice.ts');
const { default: authReducer } = await import('@/store/slices/authSlice.ts');
const { TabGroup } = await import('@/components/tabs/TabGroup.tsx');
const { ToastProvider } = await import('@/contexts/ToastContext.tsx');
const { DndProvider } = await import('react-dnd');
const { HTML5Backend } = await import('react-dnd-html5-backend');

const NOW = '2026-06-04T08:00:00.000Z';

function makeGroup(overrides: Record<string, unknown> = {}) {
  return {
    id: 'g1',
    name: 'My Session',
    tabs: [
      {
        id: 't1',
        url: 'https://example.com',
        title: 'Example',
        createdAt: NOW,
        lastAccessed: NOW,
        pinned: false,
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    version: 1,
    ...overrides,
  };
}

function makeStore(groups: any[]) {
  return configureStore({
    reducer: { tabs: tabReducer, settings: settingsReducer, auth: authReducer },
    preloadedState: {
      tabs: { ...initialTabState, groups, lastLoadedAt: NOW },
      settings: initialSettingsState,
      auth: { user: null, isAuthenticated: false, isLoading: false, error: null } as any,
    },
  });
}

function renderTabGroup(group: any) {
  const store = makeStore([group]);
  return render(
    <Provider store={store}>
      <DndProvider backend={HTML5Backend}>
        <ToastProvider>
          <TabGroup group={group} />
        </ToastProvider>
      </DndProvider>
    </Provider>
  );
}

test('TabGroup surface: renders the action buttons (恢复 / 重命名 / 锁定 / 删除)', () => {
  const group = makeGroup();
  renderTabGroup(group);

  // Action buttons are revealed on hover (opacity-0 group-hover/card:opacity-100
  // in the source), but they are *always present in the DOM* — only the
  // opacity is animated. We can query them by their aria-label.
  assert.ok(screen.getByLabelText('恢复整个会话，共 1 个标签页'), 'restore-all button should be in the DOM');
  assert.ok(screen.getByLabelText('重命名会话'), 'rename button should be in the DOM');
  assert.ok(screen.getByLabelText('锁定会话'), 'lock button should be in the DOM');
  assert.ok(screen.getByLabelText('删除会话'), 'delete button should be in the DOM');
  cleanup();
});
