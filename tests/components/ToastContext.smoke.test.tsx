// S3 §4: ToastContext action smoke test (jsdom).
//
// 验证 spec §4.4 列出的两条最小契约：
//   1. action toast（带 action 字段）渲染一个带 aria-label 的按钮（撤销）
//   2. 点击按钮触发 onClick（cancel → 撤销回调）且 toast 关闭
//
// 直接 render TestConsumer —— 组件订阅 ToastContext 并调用 showToast，
// 验证 Toast 子树的 DOM 行为。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { useState } from 'react';
import { installJsdom, installChromeStub } from '../_jsdom-helpers.mjs';

installJsdom();
installChromeStub();

const { render, cleanup, fireEvent } = await import('@testing-library/react');
const { ToastProvider, useToast } = await import('@/contexts/ToastContext.tsx');

interface TriggerProps {
  message: string;
  action?: { label: string; onClick: () => void };
  trigger: (show: (message: string, action?: any) => void) => void;
}

const Trigger: React.FC<TriggerProps> = ({ message, action, trigger }) => {
  const { showToast } = useToast();
  const btnRef = React.useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={btnRef}
      data-testid="trigger"
      onClick={() => trigger((m, a) => showToast({ message: m, action: a ?? action }))}
    >
      Fire
    </button>
  );
};

test('ToastContext: action toast renders a button with aria-label', () => {
  const onClick = () => {};
  const { container, unmount } = render(
    <ToastProvider>
      <Trigger
        message="会话已删除"
        action={{ label: '撤销', onClick }}
        trigger={(show) => show('会话已删除')}
      />
    </ToastProvider>
  );

  // 点击 trigger 触发 showToast
  const triggerBtn = container.querySelector('[data-testid="trigger"]') as HTMLButtonElement;
  fireEvent.click(triggerBtn);

  // Toast 子树通过 createPortal 渲染到 document.body
  const actionBtn = document.body.querySelector('[aria-label="撤销"]');
  assert.ok(actionBtn, 'action toast should render a button with aria-label="撤销"');
  assert.equal(actionBtn?.textContent, '撤销', 'button text should equal label');

  unmount();
  cleanup();
});

test('ToastContext: clicking action triggers onClick', async () => {
  let clicked = 0;
  const onClick = () => { clicked += 1; };

  const { container, unmount } = render(
    <ToastProvider>
      <Trigger
        message="会话已删除"
        action={{ label: '撤销', onClick }}
        trigger={(show) => show('会话已删除')}
      />
    </ToastProvider>
  );

  const triggerBtn = container.querySelector('[data-testid="trigger"]') as HTMLButtonElement;
  fireEvent.click(triggerBtn);

  const actionBtn = document.body.querySelector('[aria-label="撤销"]') as HTMLButtonElement;
  assert.ok(actionBtn, 'action button should render after trigger');
  fireEvent.click(actionBtn);

  // Toast 关闭动画 220ms → 等候 + 二次断言 onClick 已触发 + 按钮已脱离 DOM
  await new Promise<void>((resolve) => setTimeout(resolve, 350));

  assert.equal(clicked, 1, 'onClick should fire once after clicking action');

  const stillThere = document.body.querySelector('[aria-label="撤销"]');
  assert.equal(stillThere, null, 'toast should be removed after action click');

  unmount();
  cleanup();
});
