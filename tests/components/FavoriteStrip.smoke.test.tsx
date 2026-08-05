// S3 §3: FavoriteStrip smoke test (jsdom).
//
// 验证 spec §3.4 列出的两条最小契约：
//   1. 有 groups 时渲染 region + 卡片（每组一卡）
//   2. 0 groups 时返回 null（不渲染容器）
//
// 直接渲染 <FavoriteStrip>：组件依赖 Redux dispatch + useToast，
// Provider 包裹 + ToastProvider 满足其依赖；不触发点击（不验证 restore 流程，
// restore 流程会副作用 dispatch，单独在 TabGroup/SearchResultList smoke 中覆盖）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { installJsdom, installChromeStub } from '../_jsdom-helpers.mjs';

installJsdom();
installChromeStub();

const { render, cleanup } = await import('@testing-library/react');
const { default: tabReducer, initialTabState } = await import('@/store/slices/tabSlice.ts');
const { default: settingsReducer, initialSettingsState } = await import('@/store/slices/settingsSlice.ts');
const { default: authReducer } = await import('@/store/slices/authSlice.ts');
const { FavoriteStrip } = await import('@/components/tabs/FavoriteStrip.tsx');
const { ToastProvider } = await import('@/contexts/ToastContext.tsx');

const NOW = '2026-08-05T08:00:00.000Z';

function makeGroup(id: string, name: string, tabCount: number) {
  return {
    id,
    name,
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    isFavorite: true,
    tabs: Array.from({ length: tabCount }, (_, i) => ({
      id: `${id}-t${i}`,
      url: `https://example.com/${id}/${i}`,
      title: `Tab ${i + 1} of ${id}`,
      favicon: `https://example.com/${id}/${i}/favicon.ico`,
      createdAt: NOW,
      lastAccessed: NOW,
      pinned: false,
    })),
  };
}

function makeStore() {
  return configureStore({
    reducer: { tabs: tabReducer, settings: settingsReducer, auth: authReducer },
    preloadedState: {
      tabs: { ...initialTabState, lastLoadedAt: NOW },
      settings: { ...initialSettingsState },
      auth: { user: null, isAuthenticated: false, isLoading: false, error: null } as any,
    },
  });
}

function renderStrip(groups: any[]) {
  const store = makeStore();
  return render(
    <Provider store={store}>
      <ToastProvider>
        <FavoriteStrip groups={groups} />
      </ToastProvider>
    </Provider>
  );
}

test('FavoriteStrip: renders a card for each favorite group', () => {
  const groups = [
    makeGroup('g1', 'Research Session', 3),
    makeGroup('g2', 'Later Work', 1),
  ];
  const { container, unmount } = renderStrip(groups);

  const region = container.querySelector('section[aria-label="收藏会话"]');
  assert.ok(region, 'should render region with aria-label="收藏会话"');

  const cards = container.querySelectorAll('[data-testid="favorite-card"]');
  assert.equal(cards.length, 2, 'should render one card per favorite group');

  // 标题文本
  const html = container.innerHTML;
  assert.ok(html.includes('Research Session'), 'first group name should appear');
  assert.ok(html.includes('Later Work'), 'second group name should appear');

  // 数量徽章
  assert.ok(html.includes('3'), 'first card count badge');
  assert.ok(html.includes('1'), 'second card count badge');

  unmount();
  cleanup();
});

test('FavoriteStrip: returns null when no groups', () => {
  const { container, unmount } = renderStrip([]);

  const region = container.querySelector('section[aria-label="收藏会话"]');
  assert.equal(region, null, 'should not render region when favorites are empty');
  assert.equal(container.innerHTML, '', 'empty groups should produce empty output');

  unmount();
  cleanup();
});
