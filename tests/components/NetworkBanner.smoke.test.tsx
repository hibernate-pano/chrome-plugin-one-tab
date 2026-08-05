// S1 §4.2: NetworkBanner 离线提示条 smoke test。
//
// 在线 → 渲染 null；离线 → 渲染琥珀色提示条。组件自包含（内部
// useNetworkStatus），不接收 props。
//
// 注意：NetworkBanner 引入 syncService（供网络恢复自动重试），
// 但两个用例都不会触发重试——在线用例初始即在线（无「恢复」事件），
// 离线用例永不进入恢复分支；5s 防抖定时器在 cleanup() 卸载时清除。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { installJsdom, installChromeStub } from '../_jsdom-helpers.mjs';

installJsdom();
installChromeStub();
// Late import: 见 Hello.test.ts 的说明
const { render, screen, cleanup } = await import('@testing-library/react');
const { NetworkBanner } = await import('@/components/common/NetworkBanner.tsx');

function setOnLine(value: boolean) {
  Object.defineProperty(globalThis.navigator, 'onLine', {
    configurable: true,
    get: () => value,
  });
}

test('NetworkBanner: 在线 → 不渲染任何内容', async () => {
  setOnLine(true);
  const { container } = render(<NetworkBanner />);
  assert.equal(container.innerHTML, '', '在线时 banner 应为空');
  cleanup();
});

test('NetworkBanner: 离线 → 渲染提示条文案', async () => {
  setOnLine(false);
  render(<NetworkBanner />);
  const banner = screen.getByText('离线 — 同步将在网络恢复后自动重试');
  assert.ok(banner, '离线时应显示提示条');
  cleanup();
});
