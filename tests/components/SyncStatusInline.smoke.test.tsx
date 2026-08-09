// UI smoke test for SyncStatusInline (F10).
//
// F10 在 Header 恢复高频率的「立即同步 / 上传到云端 / 下载（覆盖本地） / 删除
// 重复标签」四个动作（拆分按钮 + 倒三角 popover）。
//
// 这里只验证：
//   1. 未登录时组件渲染 null（避免破坏未登录用户的 Header 布局）。
//   2. 登录时渲染「立即同步」主按钮（aria-label 区分两个拆分按钮）。
//   3. 点击倒三角后，popover 出现在 DOM 中（role="menu"）。
//
// 不触发任何 syncService / dispatch 调用：syncService 会拉起 smartSyncService
// → syncEngine → IndexedDB 完整路径，超出 smoke 测试范围；thunk 行为由各自
// 的 storeHydration / tabSelectors 测试覆盖。沿用既有 F9 ImportExportTab
// smoke 测试的 chrome-stub + jsdom 约定，不引入 fake-indexeddb。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { installJsdom, installChromeStub } from '../_jsdom-helpers.mjs';

installJsdom();
installChromeStub();
// Late import: 沿用既有 smoke 测试的延迟导入模式
const { render, screen, cleanup, fireEvent } = await import('@testing-library/react');
const { default: tabReducer, initialTabState } = await import('@/store/slices/tabSlice.ts');
const { default: settingsReducer, initialSettingsState } = await import('@/store/slices/settingsSlice.ts');
const { default: authReducer } = await import('@/store/slices/authSlice.ts');
const { SyncStatusInline } = await import('@/components/layout/SyncStatusInline.tsx');
const { ToastProvider } = await import('@/contexts/ToastContext.tsx');

function makeStore(opts: { isAuthenticated: boolean; syncStatus?: 'idle' | 'syncing' | 'success' | 'error' } = { isAuthenticated: true }) {
  return configureStore({
    reducer: { tabs: tabReducer, settings: settingsReducer, auth: authReducer },
    preloadedState: {
      tabs: { ...initialTabState, syncStatus: opts.syncStatus ?? 'idle' },
      settings: initialSettingsState,
      auth: { user: null, isAuthenticated: opts.isAuthenticated, isLoading: false, error: null } as any,
    },
  });
}

test('SyncStatusInline: returns null when not authenticated', () => {
  const store = makeStore({ isAuthenticated: false });
  const { container } = render(
    <Provider store={store}>
      <ToastProvider>
        <SyncStatusInline />
      </ToastProvider>
    </Provider>
  );
  // 组件未渲染任何 button / 拆分按钮的 DOM
  assert.equal(container.querySelector('button'), null, '未登录时不应渲染任何按钮');
  cleanup();
});

test('SyncStatusInline: renders the "立即同步" button when authenticated', () => {
  const store = makeStore({ isAuthenticated: true, syncStatus: 'idle' });
  render(
    <Provider store={store}>
      <ToastProvider>
        <SyncStatusInline />
      </ToastProvider>
    </Provider>
  );
  // 主按钮：左半部分的立即同步（aria-label 区分）
  const syncButton = screen.getByRole('button', { name: '立即同步' });
  assert.ok(syncButton, '「立即同步」按钮应在 DOM 中');
  // 拆分按钮右半部分：更多同步操作
  const moreButton = screen.getByRole('button', { name: '更多同步操作' });
  assert.ok(moreButton, '「更多同步操作」拆分按钮应在 DOM 中');
  // 初始未展开 popover
  assert.equal(screen.queryByRole('menu'), null, '初始不应渲染 popover 菜单');
  cleanup();
});

test('SyncStatusInline: clicking the chevron toggles the popover visible', () => {
  const store = makeStore({ isAuthenticated: true, syncStatus: 'idle' });
  render(
    <Provider store={store}>
      <ToastProvider>
        <SyncStatusInline />
      </ToastProvider>
    </Provider>
  );
  // 初始：菜单不可见
  assert.equal(screen.queryByRole('menu'), null);
  // 点击倒三角（aria-label = 更多同步操作）
  // 用 fireEvent（自动 wrap 在 act 里）以确保 React 18 并发模式下的状态更新
  // 被 flush，避免 useState setOpen(o => !o) 在测试结束前未生效。
  const moreButton = screen.getByRole('button', { name: '更多同步操作' });
  fireEvent.click(moreButton);
  // 现在 popover 出现
  const menu = screen.getByRole('menu', { name: '同步操作' });
  assert.ok(menu, '点击倒三角后应渲染 role="menu" 元素');
  // popover 内至少包含上传 / 下载 / 删除重复标签 / 打开设置 4 个菜单项
  assert.ok(screen.getByRole('menuitem', { name: '上传到云端' }), '应有「上传到云端」菜单项');
  assert.ok(screen.getByRole('menuitem', { name: '下载（覆盖本地）' }), '应有「下载（覆盖本地）」菜单项');
  assert.ok(screen.getByRole('menuitem', { name: '删除重复标签' }), '应有「删除重复标签」菜单项');
  assert.ok(screen.getByRole('menuitem', { name: '打开设置 → 同步…' }), '应有「打开设置 → 同步…」菜单项');
  cleanup();
});
