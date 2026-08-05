// UI smoke test for ImportExportTab's "数据维护" section (F9).
//
// F9 恢复了 S2 Header 折叠时丢失的「删除重复标签」动作。
// 这里只验证按钮在 DOM 中存在；不触发点击：
//   - 真实 dispatch 会调用 cleanDuplicateTabs → storage.setGroups → IndexedDB，
//     与其他 smoke 测试类似，让它在 fake-indexeddb 里跑成本过高；
//   - 按钮的语义由源组件 handleCleanDuplicates 覆盖（dispatch + showAlert），
//     而 redux thunk 已有专门的 storeHydration / tabSelectors 测试。
//
// 第二个用例：点击按钮时不会抛同步错误（因为 storage stub 在 chrome.storage 上，
// 而不是 storage.ts 的 IndexedDB 路径，但 useState 的 busy 切换与 dispatch 的
// 错误捕获逻辑足够覆盖「按钮按下后组件稳定」）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { installJsdom, installChromeStub } from '../_jsdom-helpers.mjs';

installJsdom();
installChromeStub();
// Late import: 见 Hello.test.ts 的说明
const { render, screen, cleanup } = await import('@testing-library/react');
const { default: tabReducer, initialTabState } = await import('@/store/slices/tabSlice.ts');
const { default: settingsReducer, initialSettingsState } = await import('@/store/slices/settingsSlice.ts');
const { default: authReducer } = await import('@/store/slices/authSlice.ts');
const { ImportExportTab } = await import('@/components/settings/ImportExportTab.tsx');
const { ToastProvider } = await import('@/contexts/ToastContext.tsx');

function makeStore() {
  return configureStore({
    reducer: { tabs: tabReducer, settings: settingsReducer, auth: authReducer },
    preloadedState: {
      tabs: { ...initialTabState },
      settings: initialSettingsState,
      auth: { user: null, isAuthenticated: false, isLoading: false, error: null } as any,
    },
  });
}

test('ImportExportTab: renders "数据维护" section with the "删除重复标签" button', () => {
  const store = makeStore();
  render(
    <Provider store={store}>
      <ToastProvider>
        <ImportExportTab />
      </ToastProvider>
    </Provider>
  );

  // 「数据维护」section 标题
  assert.ok(screen.getByText('数据维护'), '数据维护 section 标题应存在');
  // 按钮：默认文案（未在 cleaning 状态）
  const button = screen.getByRole('button', { name: '删除重复标签' });
  assert.ok(button, '删除重复标签 按钮应在 DOM 中');
  // 初始未处于 cleaning 状态 → 按钮可用
  assert.equal(button.hasAttribute('disabled'), false);
  cleanup();
});

test('ImportExportTab: clicking "删除重复标签" does not throw even when storage is stubbed', () => {
  // chrome.storage 的 stub 只满足 chrome.* API；cleanDuplicateTabs 内部走 storage.ts
  // → IndexedDB 路径，会抛错（因为 fake-indexeddb 没装）；组件用 try/catch 包住 +
  // showAlert 失败提示，不应让 React 卸载或抛同步未捕获异常。
  const store = makeStore();
  render(
    <Provider store={store}>
      <ToastProvider>
        <ImportExportTab />
      </ToastProvider>
    </Provider>
  );

  const button = screen.getByRole('button', { name: '删除重复标签' });

  // 不 assert 任何副作用（thunk 异步 + IndexedDB 都不在 fake-indexeddb），
  // 只确认点击事件能被 React 处理而不抛同步异常。
  assert.doesNotThrow(() => {
    button.click();
  });
  cleanup();
});