// S1 §4.1: useNetworkStatus hook（jsdom）。
//
// 信号源：navigator.onLine 初始值 + online/offline 事件 + 30s 轮询兜底。
// 用 @testing-library/react renderHook + jsdom 事件模拟网络切换。

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { installJsdom } from '../_jsdom-helpers.mjs';

installJsdom();
// Late import: jsdom globals 就位后才能引入 @testing-library/react
const { renderHook, act, cleanup } = await import('@testing-library/react');
const { useNetworkStatus } = await import('@/hooks/useNetworkStatus.ts');

/** 覆写 navigator.onLine（jsdom 默认恒为 true） */
function setOnLine(value: boolean) {
  Object.defineProperty(globalThis.navigator, 'onLine', {
    configurable: true,
    get: () => value,
  });
}

test('useNetworkStatus: 初始值 = navigator.onLine（默认在线）', () => {
  setOnLine(true);
  const { result } = renderHook(() => useNetworkStatus());
  assert.equal(result.current, true, '在线时应返回 true');
  cleanup();
});

test('useNetworkStatus: offline 事件 → false', () => {
  setOnLine(true);
  const { result } = renderHook(() => useNetworkStatus());
  assert.equal(result.current, true);

  setOnLine(false);
  act(() => {
    window.dispatchEvent(new window.Event('offline'));
  });

  assert.equal(result.current, false, 'offline 事件后应返回 false');
  cleanup();
});

test('useNetworkStatus: online 事件 → true（从离线恢复）', () => {
  setOnLine(false);
  const { result } = renderHook(() => useNetworkStatus());
  assert.equal(result.current, false);

  setOnLine(true);
  act(() => {
    window.dispatchEvent(new window.Event('online'));
  });

  assert.equal(result.current, true, 'online 事件后应返回 true');
  cleanup();
});

test('useNetworkStatus: 30s 轮询兜底（事件丢失时仍能感知）', async () => {
  // 在 render 之前启用 mock timers，让 hook 里的 setInterval 走 mock
  mock.timers.enable({ apis: ['setInterval'] });

  setOnLine(true);
  const { result } = renderHook(() => useNetworkStatus());
  assert.equal(result.current, true);

  // 静默断网：navigator.onLine 变了但没有事件（MV3 上下文可能丢事件）
  setOnLine(false);
  await act(async () => {
    mock.timers.tick(30_000);
  });

  assert.equal(result.current, false, '30s 轮询应兜底感知离线');

  cleanup();
  mock.timers.reset();
});

test('useNetworkStatus: 卸载后事件不再影响状态', () => {
  setOnLine(true);
  const { result, unmount } = renderHook(() => useNetworkStatus());
  unmount();

  setOnLine(false);
  window.dispatchEvent(new window.Event('offline'));

  // 卸载后状态不再更新（不抛错即可，值保持最后一次）
  assert.equal(result.current, true);
  cleanup();
});
