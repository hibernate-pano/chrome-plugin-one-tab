// S3 §1：TabPreview 浮层 smoke test（jsdom）。
//
// 验证 spec §1.4 列出的两条最小契约：
//   1. 有 tabs 时渲染 favicon（每个 tab 一个 SafeFavicon，≤8 个）
//   2. 0 tabs 时返回 null（不渲染浮层容器）
//
// 直接渲染 <TabPreview>，不挂在 TabGroup 上 — 这样能单独验证预览组件
// 自身的渲染行为，避开 TabGroup 的 hover delay / Redux 副作用。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { installJsdom, installChromeStub } from '../_jsdom-helpers.mjs';

installJsdom();
installChromeStub();

// Late import: jsdom globals 就位后才能引入 @testing-library/react
const { render, cleanup } = await import('@testing-library/react');
const { TabPreview } = await import('@/components/tabs/TabPreview.tsx');

const NOW = '2026-08-05T08:00:00.000Z';

function makeGroup(id: string, tabCount: number) {
  return {
    id,
    name: `Group ${id}`,
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
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

test('TabPreview: renders favicon + truncated title rows for a non-empty group', () => {
  const group = makeGroup('g1', 5);
  const { container, unmount } = render(<TabPreview group={group as any} />);

  // 浮层容器：role + aria-label
  const region = container.querySelector('[role="region"][aria-label="会话预览"]');
  assert.ok(region, 'preview region should render with role/aria-label');

  // 每个 tab 一个 row（≤8 全展示）
  const rows = container.querySelectorAll('[data-testid="tab-preview-row"]');
  assert.equal(rows.length, 5, 'should render one row per visible tab');

  // 每行有一个 img 标签（SafeFavicon 渲染 <img> 当 src 通过安全检查时）
  const imgs = region.querySelectorAll('img');
  assert.equal(imgs.length, 5, 'each row should contain a favicon <img>');

  // 标题文字应该出现在文本里
  const html = container.innerHTML;
  assert.ok(html.includes('Tab 1 of g1'), 'first tab title should be in the DOM');
  assert.ok(html.includes('Tab 5 of g1'), 'fifth tab title should be in the DOM');

  unmount();
  cleanup();
});

test('TabPreview: returns null when group has zero tabs', () => {
  const group = makeGroup('empty', 0);
  const { container, unmount } = render(<TabPreview group={group as any} />);

  // 不渲染任何 region
  const region = container.querySelector('[role="region"][aria-label="会话预览"]');
  assert.equal(region, null, 'preview region should not render for empty group');
  assert.equal(container.innerHTML, '', 'empty group should produce empty output');

  unmount();
  cleanup();
});