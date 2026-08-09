// S3 §4: useDeferredDelete hook 测试（jsdom）。
//
// 验证 spec §4.4 的三条最小契约：
//   1. 达到 delayMs 后调用 onCommit
//   2. cancel 在 timer 未触发前阻止 commit
//   3. 重复 requestDelete 重置 timer（不会造成双 commit）
//
// 使用 @testing-library/react 的 renderHook + act —— 完整 React 生命周期，
// 卸载清理（clearTimer）也能被覆盖。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { installJsdom, installChromeStub } from './_jsdom-helpers.mjs';

installJsdom();
installChromeStub();

const { renderHook, act } = await import('@testing-library/react');
const { useDeferredDelete } = await import('@/hooks/useDeferredDelete.ts');

test('useDeferredDelete: commits after delay', async () => {
  let commits = 0;
  const { result, unmount } = renderHook(() =>
    useDeferredDelete({ delayMs: 50, onCommit: () => { commits += 1; } })
  );

  assert.equal(result.current.pending, false, '初始 pending=false');
  act(() => {
    result.current.requestDelete();
  });
  assert.equal(result.current.pending, true, '调用后 pending=true');

  // 等待大于 delayMs 的时间（setTimeout 触发的 setState 需要包在 act 里）
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 80));
  });

  assert.equal(commits, 1, '应触发一次 commit');
  assert.equal(result.current.pending, false, 'commit 后 pending=false');

  unmount();
});

test('useDeferredDelete: cancel before delay prevents commit', async () => {
  let commits = 0;
  const { result, unmount } = renderHook(() =>
    useDeferredDelete({ delayMs: 50, onCommit: () => { commits += 1; } })
  );

  act(() => {
    result.current.requestDelete();
  });
  assert.equal(result.current.pending, true);

  // 在 timer 触发前撤销
  act(() => {
    result.current.cancel();
  });
  assert.equal(result.current.pending, false, 'cancel 后 pending=false');

  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 80));
  });

  assert.equal(commits, 0, 'cancel 后不能 commit');

  unmount();
});

test('useDeferredDelete: repeat requestDelete resets timer (no double commit)', async () => {
  let commits = 0;
  const { result, unmount } = renderHook(() =>
    useDeferredDelete({ delayMs: 50, onCommit: () => { commits += 1; } })
  );

  // 第一次请求
  act(() => {
    result.current.requestDelete();
  });

  // 30ms 后再次请求 —— 重置 timer
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  act(() => {
    result.current.requestDelete();
  });

  // 等到原 timer (50ms) + 余量过去 —— commit 不应被触发
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 40));
  });
  assert.equal(commits, 0, '第一次 timer 已被重置');

  // 等到第二次 timer 触发
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  assert.equal(commits, 1, '第二次 timer 触发一次 commit');

  unmount();
});

test('useDeferredDelete: clicking the undo action button cancels the commit', async () => {
  // E2E: renderHook + ToastProvider wrapper, simulate the spec §4.4 flow
  // ("delete → 10s undo toast with button → click → cancel").
  let commits = 0;
  const { useToast } = await import('@/contexts/ToastContext.tsx');

  let captured: { requestDelete: () => void; cancel: () => void } | null = null;

  const Host: React.FC = () => {
    const { showToast } = useToast();
    const deferred = useDeferredDelete({ delayMs: 10000, onCommit: () => { commits += 1; } });
    captured = deferred;
    return (
      <button
        type="button"
        data-testid="delete"
        onClick={() => {
          showToast({
            message: '已删除',
            duration: 10000,
            action: { label: '撤销', onClick: deferred.cancel },
          });
          deferred.requestDelete();
        }}
      >
        delete
      </button>
    );
  };

  const { ToastProvider } = await import('@/contexts/ToastContext.tsx');
  const { render, fireEvent, cleanup } = await import('@testing-library/react');

  const { unmount } = render(
    <ToastProvider>
      <Host />
    </ToastProvider>
  );

  // 点击 delete 触发 showToast + requestDelete
  fireEvent.click(document.querySelector('[data-testid="delete"]') as HTMLButtonElement);
  assert.equal(captured!.pending, true, 'requestDelete 后 pending=true');

  // 找到 toast 上的撤销按钮并点击
  const actionBtn = document.body.querySelector('[data-testid="toast-action"]') as HTMLButtonElement;
  assert.ok(actionBtn, '撤销按钮应已渲染');
  assert.equal(actionBtn.textContent, '撤销');

  fireEvent.click(actionBtn);

  // 等 toast 关闭动画 220ms + 余量
  await new Promise(resolve => setTimeout(resolve, 350));

  assert.equal(commits, 0, '点击撤销按钮后 commit 不应触发');
  assert.equal(captured!.pending, false, '点击撤销后 pending=false');

  unmount();
  cleanup();
});
